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
    private androidx.appcompat.widget.SwitchCompat switchContinue;

    private String sessionId;
    private String sessionDirectory;
    private volatile boolean isSessionRunning = true;
    private boolean autoScroll = true;

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

        // Clear any stale reply notifications
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.cancelAll();

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

        switchContinue = findViewById(R.id.switch_continue);

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

        // Input
        inputText.setOnKeyListener((v, code, event) -> {
            if (code == KeyEvent.KEYCODE_ENTER && event.getAction() == KeyEvent.ACTION_DOWN) {
                sendInput(); return true;
            }
            return false;
        });
        inputText.setOnEditorActionListener((v, actionId, event) -> { sendInput(); return true; });
        btnSend.setOnClickListener(v -> sendInput());

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

        // Register with foreground service for background notifications
        ClawForegroundService svc = ClawForegroundService.getInstance();
        if (svc != null) svc.addCallback(this);

        // Cancel any stale reply notification — user is now watching the chat
        if (svc != null) svc.cancelReplyNotification();

        if (wm.isConnected()) wm.sendConnectSession(sessionId);
    }

    @Override
    protected void onPause() {
        super.onPause();
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
            WebSocketManager.getInstance().sendConnectSession(sessionId);
        }
    }

    // ============================================================
    // Service callbacks (for when activity is in foreground)
    // ============================================================

    @Override
    public void onResponse(String sid, String text) {
        if (!sid.equals(sessionId)) return;
        runOnUiThread(() -> {
            chatAdapter.replaceLast(new ChatMessage(ChatMessage.TYPE_CLAUDE, text));
            scrollToBottom();
        });
    }

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
            case "session_response": {
                // Handle directly so messages arrive even if service callback is missing
                String text = data.has("data") ? data.get("data").getAsString() : "";
                if (!text.isEmpty()) {
                    runOnUiThread(() -> {
                        chatAdapter.replaceLast(new ChatMessage(ChatMessage.TYPE_CLAUDE, text));
                        scrollToBottom();
                    });
                }
                break;
            }
        }
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
            chatAdapter.addMessage(new ChatMessage(ChatMessage.TYPE_CLAUDE, "⚠ " + error));
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
        chatAdapter.addMessage(new ChatMessage(ChatMessage.TYPE_USER, text.trim()));
        chatAdapter.addMessage(new ChatMessage(ChatMessage.TYPE_CLAUDE, "Thinking…"));

        // Scroll without guard — always go to bottom after sending
        final int target = chatAdapter.getItemCount() - 1;
        chatList.postDelayed(() -> {
            chatList.scrollToPosition(target);
        }, 100);

        final boolean useContinue = switchContinue.isChecked();

        if (!wm.sendChat(sessionId, text.trim(), useContinue)) {
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
