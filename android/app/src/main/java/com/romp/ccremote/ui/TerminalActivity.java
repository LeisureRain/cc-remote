package com.romp.ccremote.ui;

import android.app.NotificationManager;
import android.content.Intent;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.Menu;
import android.view.MenuItem;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.widget.Toolbar;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import com.google.gson.JsonObject;
import com.romp.ccremote.R;
import com.romp.ccremote.model.ChatMessage;
import com.romp.ccremote.service.ClawForegroundService;
import com.romp.ccremote.util.ChatHistoryStore;
import com.romp.ccremote.websocket.WebSocketManager;

public class TerminalActivity extends AppCompatActivity
        implements ClawForegroundService.ChatCallback {

    private EditText inputText;
    private ImageButton btnSend;
    private TextView toolbarTitle;
    private TextView toolbarStatus;
    private RecyclerView chatList;
    private ChatAdapter chatAdapter;
    private LinearLayoutManager layoutManager;
    private String sessionId;
    private String sessionDirectory;
    private volatile boolean isSessionRunning = true;
    private boolean autoScroll = true;

    // Streaming state
    private boolean streaming = false;
    private final StringBuilder streamBuf = new StringBuilder();
    private boolean streamRenderScheduled = false;

    // Track the last user message for local persistence pairing
    private ChatMessage lastSentUser = null;

    private final WebSocketManager.MessageListener messageListener = this::onMessage;
    private final WebSocketManager.ConnectionListener connectionListener = this::onConnectionChanged;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_terminal);

        sessionId = getIntent().getStringExtra("session_id");
        sessionDirectory = getIntent().getStringExtra("session_directory");
        String stat = getIntent().getStringExtra("session_status");
        if (stat != null) isSessionRunning = "running".equals(stat);
        if (sessionId == null) { finish(); return; }

        // Start foreground service to keep connection alive in background
        ClawForegroundService.start(this, sessionId, sessionDirectory);

        // Clear this session's stale reply notification (not other sessions')
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null && sessionId != null) {
            nm.cancel(ClawForegroundService.replyNotifyId(sessionId));
        }

        // Views
        Toolbar toolbar = findViewById(R.id.toolbar);
        toolbarTitle = findViewById(R.id.toolbar_title);
        toolbarStatus = findViewById(R.id.toolbar_status);
        chatList = findViewById(R.id.chat_list);
        inputText = findViewById(R.id.input_text);
        btnSend = findViewById(R.id.btn_send);

        setSupportActionBar(toolbar);
        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
            getSupportActionBar().setDisplayShowTitleEnabled(false);
        }
        toolbarTitle.setText(getDisplayDir(sessionDirectory));
        updateToolbarStatus();

        // Restore unsent draft for this session
        String draft = com.romp.ccremote.util.PreferencesHelper.getInputDraft(sessionId);
        if (draft != null && !draft.isEmpty()) {
            inputText.setText(draft);
            inputText.setSelection(draft.length());
        }

        // Save draft on every keystroke
        inputText.addTextChangedListener(new android.text.TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) {}
            @Override public void afterTextChanged(android.text.Editable s) {
                com.romp.ccremote.util.PreferencesHelper.setInputDraft(sessionId, s.toString());
            }
        });

        // Chat list
        chatAdapter = new ChatAdapter();
        layoutManager = new LinearLayoutManager(this);
        layoutManager.setStackFromEnd(true);
        chatList.setLayoutManager(layoutManager);
        chatList.setAdapter(chatAdapter);
        chatList.addOnScrollListener(new RecyclerView.OnScrollListener() {
            @Override public void onScrolled(RecyclerView rv, int dx, int dy) {
                int last = layoutManager.findLastCompletelyVisibleItemPosition();
                autoScroll = last >= chatAdapter.getItemCount() - 2;
            }
        });

        // Load any locally-cached chat history so the user sees messages
        // immediately, before the WebSocket reconnects and server sends
        // the canonical chat_history (which will overwrite this).
        java.util.List<ChatMessage> cached = ChatHistoryStore.getInstance().load(sessionId);
        if (!cached.isEmpty()) {
            for (ChatMessage m : cached) chatAdapter.addMessage(m);
            scrollToBottom();
        }

        // Input
        inputText.setOnKeyListener((v, code, event) -> {
            if (code == KeyEvent.KEYCODE_ENTER && event.getAction() == KeyEvent.ACTION_DOWN) {
                sendInput(); return true;
            }
            return false;
        });
        inputText.setOnEditorActionListener((v, actionId, event) -> { sendInput(); return true; });
        btnSend.setOnClickListener(v -> {
            if (streaming) sendInterrupt();
            else sendInput();
        });

        // Connect
        WebSocketManager wm = WebSocketManager.getInstance();
        if (wm.isConnected()) wm.sendConnectSession(sessionId);
        else wm.connect();
    }

    @Override
    protected void onResume() {
        super.onResume();
        WebSocketManager wm = WebSocketManager.getInstance();
        wm.addMessageListener(messageListener);
        wm.addConnectionListener(connectionListener);

        // Mark this session as visible so the service won't post notifications
        // while we're watching. Done directly (race-free) rather than via the
        // possibly-not-yet-started service instance.
        ClawForegroundService.setVisibleSession(sessionId);

        // Register with foreground service for kill/exit callbacks
        ClawForegroundService svc = ClawForegroundService.getInstance();
        if (svc != null) svc.addCallback(this);

        // Cancel any stale reply notification — user is now watching the chat
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null && sessionId != null) {
            nm.cancel(ClawForegroundService.replyNotifyId(sessionId));
        }

        if (wm.isConnected()) wm.sendConnectSession(sessionId);
    }

    @Override
    protected void onPause() {
        super.onPause();
        // No longer the visible session — responses now warrant a notification.
        ClawForegroundService.clearVisibleSession(sessionId);
        // Don't remove WebSocket listeners — service keeps them alive.
        // But unregister from service callback so duplicate UI updates
        // don't happen on re-entry.
        ClawForegroundService svc = ClawForegroundService.getInstance();
        if (svc != null) svc.removeCallback(this);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (isFinishing()) {
            WebSocketManager wm = WebSocketManager.getInstance();
            wm.removeMessageListener(messageListener);
            wm.removeConnectionListener(connectionListener);
            // Don't stop service — keep connection alive
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String sid = intent.getStringExtra("session_id");
        if (sid != null && !sid.equals(sessionId)) {
            sessionId = sid;
            sessionDirectory = intent.getStringExtra("session_directory");
            toolbarTitle.setText(getDisplayDir(sessionDirectory));
            chatAdapter.clear();
            // Load local cache for the new session immediately
            java.util.List<ChatMessage> cached = ChatHistoryStore.getInstance().load(sessionId);
            if (!cached.isEmpty()) {
                for (ChatMessage m : cached) chatAdapter.addMessage(m);
                scrollToBottom();
            }
            WebSocketManager.getInstance().sendConnectSession(sessionId);
        }
    }

    // ============================================================
    // Service callbacks (for when activity is in foreground)
    // ============================================================

    @Override
    public void onSessionKilled(String sid) {
        if (!sid.equals(sessionId)) return;
        isSessionRunning = false;
        runOnUiThread(() -> {
            updateToolbarStatus();
            chatAdapter.addMessage(new ChatMessage(ChatMessage.TYPE_CLAUDE, "— Session killed —"));
        });
    }

    @Override
    public void onSessionExited(String sid, int exitCode) {
        if (!sid.equals(sessionId)) return;
        isSessionRunning = false;
        runOnUiThread(() -> {
            updateToolbarStatus();
            chatAdapter.addMessage(new ChatMessage(ChatMessage.TYPE_CLAUDE,
                    "— Claude exited (code: " + exitCode + ") —"));
        });
    }

    // ============================================================
    // Menu
    // ============================================================

    @Override public boolean onCreateOptionsMenu(Menu menu) {
        getMenuInflater().inflate(R.menu.terminal_menu, menu); return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        int id = item.getItemId();
        if (id == android.R.id.home) { finish(); return true; /* no disconnect */ }
        if (id == R.id.action_disconnect) { disconnectAndFinish(); return true; }
        if (id == R.id.action_kill) { confirmKill(); return true; }
        return super.onOptionsItemSelected(item);
    }

    private void disconnectAndFinish() {
        WebSocketManager.getInstance().sendDisconnect(sessionId);
        ClawForegroundService.stop(this);
        finish();
    }

    private void confirmKill() {
        new AlertDialog.Builder(this)
                .setTitle("Kill Session")
                .setMessage("Terminate this Claude Code process on the server?")
                .setPositiveButton("Kill", (d, w) -> {
                    WebSocketManager.getInstance().sendKill(sessionId);
                    ClawForegroundService.stop(this);
                    Toast.makeText(this, "Session killed", Toast.LENGTH_SHORT).show();
                    finish();
                })
                .setNegativeButton("Cancel", null).create().show();
    }

    // ============================================================
    // Message handling (for chat_history, connected, error)
    // ============================================================

    private void onMessage(String type, JsonObject data) {
        String sid = data.has("session_id") ? data.get("session_id").getAsString() : null;
        if (sid != null && !sid.equals(sessionId)) return;

        switch (type) {
            case "chat_history":     handleChatHistory(data); break;
            case "session_connected": isSessionRunning = "running".equals(data.get("status").getAsString()); runOnUiThread(this::updateToolbarStatus); break;
            case "session_error":    handleError(data); break;
            case "error": {
                // Generic server error (e.g. "previous message still processing").
                // If a request placeholder is pending, replace it so it doesn't
                // hang forever; otherwise just surface a toast.
                String msg = data.has("message") ? data.get("message").getAsString() : "Error";
                runOnUiThread(() -> {
                    String last = chatAdapter.getLastText();
                    if ("Thinking…".equals(last) || "Processing…".equals(last)) {
                        chatAdapter.replaceLast(new ChatMessage(ChatMessage.TYPE_CLAUDE, "⚠ " + msg));
                    } else {
                        Toast.makeText(this, msg, Toast.LENGTH_LONG).show();
                    }
                });
                break;
            }
            case "session_delta": {
                String text = data.has("text") ? data.get("text").getAsString() : "";
                if (!text.isEmpty()) runOnUiThread(() -> onDelta(text));
                break;
            }
            case "session_response": {
                // Final/canonical turn text — finalize the streaming bubble.
                String text = data.has("data") ? data.get("data").getAsString() : "";
                runOnUiThread(() -> finalizeTurn(text));
                break;
            }
            case "session_tool": {
                String status = data.has("status") ? data.get("status").getAsString() : "";
                String name = data.has("name") ? data.get("name").getAsString() : "";
                runOnUiThread(() -> onToolEvent(status, name));
                break;
            }
            case "profile_switched": {
                // Profile changed — restart the session so the new model takes effect
                runOnUiThread(() -> {
                    WebSocketManager.getInstance().sendRestartSession(sessionId);
                    Toast.makeText(this, "Restarting with new model…", Toast.LENGTH_SHORT).show();
                });
                break;
            }
        }
    }

    // ============================================================
    // Streaming render
    // ============================================================

    /** Append a streamed chunk to the in-progress Claude bubble (throttled). */
    private void onDelta(String delta) {
        if (!streaming) {
            streaming = true;
            streamBuf.setLength(0);
            setStreaming(true);
            // Ensure there is a Claude bubble to stream into (reuse the
            // "Thinking…"/"Processing…" placeholder when present).
            if (chatAdapter.getItemCount() == 0 || chatAdapter.isLastUser()) {
                chatAdapter.addMessage(new ChatMessage(ChatMessage.TYPE_CLAUDE, ""));
            }
        }
        streamBuf.append(delta);
        scheduleStreamRender();
    }

    private final Runnable streamRender = () -> {
        streamRenderScheduled = false;
        // Render as plain text while streaming (cheap); markdown on finalize.
        chatAdapter.updateLastText(streamBuf.toString(), false);
        // Don't call scrollToBottom() here — the RecyclerView's
        // setStackFromEnd(true) already keeps the bottom visible as the
        // item grows. Explicit scrolling during rapid incremental updates
        // fights the layout manager and causes visible jitter.
    };

    /** Insert or remove tool call progress indicators (P3). */
    private void onToolEvent(String status, String toolName) {
        if ("running".equals(status)) {
            String name = toolName != null ? toolName : "tool";
            chatAdapter.addMessage(new ChatMessage(name));
            scrollToBottom();
        } else if ("done".equals(status)) {
            chatAdapter.removeTrailingTools();
        }
    }

    private void scheduleStreamRender() {
        if (streamRenderScheduled) return;
        streamRenderScheduled = true;
        chatList.postDelayed(streamRender, 80);
    }

    /** Finalize the current turn: render the canonical text as Markdown. */
    private void finalizeTurn(String text) {
        chatList.removeCallbacks(streamRender);
        streamRenderScheduled = false;
        boolean wasStreaming = streaming;
        streaming = false;
        streamBuf.setLength(0);
        setStreaming(false);
        // Clean up any lingering tool indicators (P3)
        chatAdapter.removeTrailingTools();
        if (text == null || text.isEmpty()) {
            // Empty final with nothing streamed — drop a dangling placeholder.
            if (!wasStreaming) return;
            text = "";
        }
        ChatMessage claudeMsg = new ChatMessage(ChatMessage.TYPE_CLAUDE, text);
        chatAdapter.replaceLast(claudeMsg);
        scrollToBottom();

        // Persist this turn locally so the user can browse offline later
        if (lastSentUser != null) {
            ChatHistoryStore.getInstance().appendTurn(sessionId, lastSentUser, claudeMsg);
            lastSentUser = null;
        }
    }

    /** Toggle the send button between Send and Stop. */
    private void setStreaming(boolean s) {
        btnSend.setImageResource(s
                ? android.R.drawable.ic_menu_close_clear_cancel
                : android.R.drawable.ic_menu_send);
        btnSend.setContentDescription(s ? "Stop" : "Send");
    }

    private void sendInterrupt() {
        WebSocketManager.getInstance().sendInterrupt(sessionId);
    }

    private void handleChatHistory(JsonObject data) {
        runOnUiThread(() -> {
            chatAdapter.clear();
            if (data.has("entries")) {
                com.google.gson.JsonArray entries = data.getAsJsonArray("entries");
                for (int i = 0; i < entries.size(); i++) {
                    com.google.gson.JsonObject e = entries.get(i).getAsJsonObject();
                    String role = e.get("role").getAsString();
                    String text = e.get("text").getAsString();
                    long ts = e.has("ts") && !e.get("ts").isJsonNull()
                            ? e.get("ts").getAsLong() : System.currentTimeMillis();
                    int type = "user".equals(role) ? ChatMessage.TYPE_USER : ChatMessage.TYPE_CLAUDE;
                    chatAdapter.addMessage(new ChatMessage(type, text, ts));
                }
                // Server is source of truth — overwrite local cache
                ChatHistoryStore.getInstance().saveFromEntries(sessionId, entries);
            }
            if (data.has("pending") && !data.get("pending").isJsonNull()) {
                chatAdapter.addMessage(new ChatMessage(ChatMessage.TYPE_CLAUDE, "Processing…"));
            }
            scrollToBottom();
        });
    }

    private void handleError(JsonObject data) {
        String error = data.has("error") ? data.get("error").getAsString() : "Unknown error";
        runOnUiThread(() -> {
            // While streaming, finalize the partial text with the error so the
            // bubble settles and the button resets.
            if (streaming) {
                streamBuf.append("\n\n⚠ ").append(error);
                finalizeTurn(streamBuf.toString());
                streamBuf.setLength(0);
            } else {
                chatAdapter.addMessage(new ChatMessage(ChatMessage.TYPE_CLAUDE, "⚠ " + error));
            }
            Toast.makeText(this, error, Toast.LENGTH_SHORT).show();
        });
    }

    private void onConnectionChanged(boolean connected) {
        runOnUiThread(() -> {
            toolbarStatus.setText(connected ? "● connected" : "● disconnected");
            toolbarStatus.setTextColor(connected ? 0xFF51CF66 : 0xFFFFD43B);
            if (connected) WebSocketManager.getInstance().sendConnectSession(sessionId);
        });
    }

    // ============================================================
    // Input
    // ============================================================

    private void sendInput() {
        // If a turn is streaming, stop is handled in the button click — in
        // case we get here via keyboard, block sending while busy.
        if (streaming) return;

        // Keep leading/trailing spaces so commands like "  indent" aren't lost.
        // Only reject truly empty input.
        final String raw = inputText.getText().toString();
        if (raw.trim().isEmpty()) return;

        final String text = raw;

        WebSocketManager wm = WebSocketManager.getInstance();
        if (!wm.isConnected()) {
            wm.connect();
            Toast.makeText(this, "Not connected — reconnecting...", Toast.LENGTH_SHORT).show();
            return;
        }

        inputText.setText("");
        com.romp.ccremote.util.PreferencesHelper.clearInputDraft(sessionId);
        lastSentUser = new ChatMessage(ChatMessage.TYPE_USER, text.trim());
        chatAdapter.addMessage(lastSentUser);
        chatAdapter.addMessage(new ChatMessage(ChatMessage.TYPE_CLAUDE, "Thinking…"));

        // Scroll without guard — always go to bottom after sending
        final int target = chatAdapter.getItemCount() - 1;
        chatList.postDelayed(() -> {
            chatList.scrollToPosition(target);
        }, 100);

        if (!wm.sendChat(sessionId, text.trim())) {
            chatAdapter.removeLast();
            Toast.makeText(this, "Send failed", Toast.LENGTH_SHORT).show();
        }
    }

    // ============================================================
    // Helpers
    // ============================================================

    private void scrollToBottom() {
        if (autoScroll && chatAdapter.getItemCount() > 0) {
            chatList.post(() -> chatList.scrollToPosition(chatAdapter.getItemCount() - 1));
        }
    }

    private void updateToolbarStatus() {
        toolbarStatus.setText(isSessionRunning ? "● running" : "● exited");
        toolbarStatus.setTextColor(isSessionRunning ? 0xFF51CF66 : 0xFFFF6B6B);
    }

    private String getDisplayDir(String dir) {
        if (dir == null) return "Unknown";
        if (dir.endsWith("/") || dir.endsWith("\\")) dir = dir.substring(0, dir.length() - 1);
        int lastSep = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'));
        if (lastSep >= 0 && lastSep < dir.length() - 1) return dir.substring(lastSep + 1);
        return dir;
    }
}
