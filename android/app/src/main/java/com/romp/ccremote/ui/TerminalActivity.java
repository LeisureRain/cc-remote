package com.romp.ccremote.ui;

import android.app.NotificationManager;
import android.content.Intent;
import android.os.Bundle;
import android.view.Menu;
import android.view.MenuItem;
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

    // Turn / streaming state
    private boolean turnActive = false;           // a turn is in flight (send → response)
    private boolean streamingIntoBubble = false;  // currently appending text to a Claude bubble
    private final StringBuilder streamBuf = new StringBuilder();       // current text segment
    private final StringBuilder turnAnswerText = new StringBuilder();  // whole turn's answer text
    private boolean streamRenderScheduled = false;
    private int turnStartIndex = 0;     // adapter index where the current turn began
    private int turnTextSegments = 0;   // # of Claude text bubbles created this turn
    private long turnStartMs = 0;
    private long lastActivityMs = 0;
    private final java.util.HashSet<String> turnToolIds = new java.util.HashSet<>();

    // Live activity status bar
    private android.view.View statusBar;
    private TextView statusText;
    private android.widget.ProgressBar statusSpinner;
    private int statusPhase = PHASE_WORKING;
    private String currentToolLabel = "";
    private final android.os.Handler uiHandler =
            new android.os.Handler(android.os.Looper.getMainLooper());

    private static final int PHASE_WORKING = 0, PHASE_THINKING = 1, PHASE_TOOL = 2, PHASE_WRITING = 3;
    private static final long STUCK_MS = 30000;   // no activity for this long → "may be stuck"
    private static final int COLOR_GREEN = 0xFF51CF66, COLOR_AMBER = 0xFFFFD43B;

    // Track the last user message for local persistence pairing
    private ChatMessage lastSentUser = null;

    private final Runnable statusTick = new Runnable() {
        @Override public void run() {
            if (!turnActive) return;
            updateStatusBar();
            uiHandler.postDelayed(this, 1000);
        }
    };

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
        statusBar = findViewById(R.id.status_bar);
        statusText = findViewById(R.id.status_text);
        statusSpinner = findViewById(R.id.status_spinner);
        // Tapping the live status bar interrupts the in-flight turn.
        statusBar.setOnClickListener(v -> { if (turnActive) confirmInterrupt(); });

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

        // Input — Enter inserts a newline (multi-line field); sending is done
        // explicitly via the send button so multi-line messages aren't cut off.
        btnSend.setOnClickListener(v -> {
            if (turnActive) confirmInterrupt();
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
        uiHandler.removeCallbacks(statusTick);
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
            endTurnUi(); // drop any live status bar from the previous session
            lastSentUser = null;
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
            endTurnUi();
            updateToolbarStatus();
            chatAdapter.addMessage(new ChatMessage(ChatMessage.TYPE_CLAUDE, "— Session killed —"));
        });
    }

    @Override
    public void onSessionExited(String sid, int exitCode) {
        if (!sid.equals(sessionId)) return;
        isSessionRunning = false;
        runOnUiThread(() -> {
            endTurnUi();
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

    @Override public boolean onPrepareOptionsMenu(Menu menu) {
        // Stop is for a running session; Resume is for a stopped one — show
        // whichever applies so the action matches the session's current state.
        MenuItem stop = menu.findItem(R.id.action_stop);
        MenuItem resume = menu.findItem(R.id.action_resume);
        if (stop != null) stop.setVisible(isSessionRunning);
        if (resume != null) resume.setVisible(!isSessionRunning);
        return super.onPrepareOptionsMenu(menu);
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        int id = item.getItemId();
        if (id == android.R.id.home) { finish(); return true; /* no disconnect */ }
        if (id == R.id.action_disconnect) { disconnectAndFinish(); return true; }
        if (id == R.id.action_stop) { confirmStop(); return true; }
        if (id == R.id.action_resume) { doResume(); return true; }
        if (id == R.id.action_delete) { confirmDelete(); return true; }
        return super.onOptionsItemSelected(item);
    }

    private void disconnectAndFinish() {
        WebSocketManager.getInstance().sendDisconnect(sessionId);
        ClawForegroundService.stop(this);
        finish();
    }

    /** Stop (pause) the session — keeps it resumable; stays on this screen. */
    private void confirmStop() {
        new AlertDialog.Builder(this)
                .setTitle("Stop Session")
                .setMessage("Stop this session? The Claude process will be terminated, "
                        + "but the session and its history are kept so you can resume it later.")
                .setPositiveButton("Stop", (d, w) -> {
                    WebSocketManager.getInstance().sendStop(sessionId);
                    Toast.makeText(this, "Stopping session…", Toast.LENGTH_SHORT).show();
                })
                .setNegativeButton("Cancel", null).create().show();
    }

    /** Resume a stopped session — relaunches its process on the server. */
    private void doResume() {
        WebSocketManager.getInstance().sendResume(sessionId);
        Toast.makeText(this, "Resuming session…", Toast.LENGTH_SHORT).show();
    }

    private void confirmDelete() {
        new AlertDialog.Builder(this)
                .setTitle("Delete Session")
                .setMessage("Permanently delete this session? It will be stopped and removed "
                        + "from the server — it will NOT be restored after a server restart.")
                .setPositiveButton("Delete", (d, w) -> {
                    WebSocketManager.getInstance().sendDeleteSession(sessionId);
                    ClawForegroundService.stop(this);
                    Toast.makeText(this, "Session deleted", Toast.LENGTH_SHORT).show();
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
            case "session_connected": isSessionRunning = "running".equals(data.get("status").getAsString()); runOnUiThread(() -> { updateToolbarStatus(); invalidateOptionsMenu(); }); break;
            case "session_stopped": {
                isSessionRunning = false;
                runOnUiThread(() -> {
                    endTurnUi();
                    updateToolbarStatus();
                    invalidateOptionsMenu();
                    chatAdapter.addMessage(new ChatMessage(ChatMessage.TYPE_CLAUDE, "— Session stopped (tap ⋮ → Resume to continue) —"));
                    scrollToBottom();
                });
                break;
            }
            case "session_resumed": {
                isSessionRunning = true;
                runOnUiThread(() -> {
                    updateToolbarStatus();
                    invalidateOptionsMenu();
                    chatAdapter.addMessage(new ChatMessage(ChatMessage.TYPE_CLAUDE, "— Session resumed —"));
                    scrollToBottom();
                });
                break;
            }
            case "session_error":    handleError(data); break;
            case "error": {
                // Generic server error (e.g. "previous message still processing").
                // If a turn is in flight, settle it with the error inline so the
                // status bar/button reset; otherwise just surface a toast.
                String msg = data.has("message") ? data.get("message").getAsString() : "Error";
                runOnUiThread(() -> {
                    if (turnActive) {
                        String prefix = turnAnswerText.length() > 0 ? turnAnswerText + "\n\n" : "";
                        finalizeTurn(prefix + "⚠ " + msg);
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
                String id = data.has("id") ? data.get("id").getAsString() : "";
                String detail = data.has("detail") && !data.get("detail").isJsonNull()
                        ? data.get("detail").getAsString() : "";
                boolean ok = !data.has("ok") || data.get("ok").getAsBoolean();
                String result = data.has("result") && !data.get("result").isJsonNull()
                        ? data.get("result").getAsString() : "";
                runOnUiThread(() -> onToolEvent(status, name, id, detail, ok, result));
                break;
            }
            case "session_thinking": {
                runOnUiThread(this::onThinking);
                break;
            }
            case "profile_switched": {
                // The server restarts all running sessions itself on switch
                // (server-driven), so the client must NOT also send a restart —
                // that would double-restart. Just inform the user; the new model
                // arrives via the fresh session_meta after the restart.
                runOnUiThread(() ->
                    Toast.makeText(this, "Profile switched · restarting session…", Toast.LENGTH_SHORT).show());
                break;
            }
        }
    }

    // ============================================================
    // Streaming render + live activity status bar
    // ============================================================

    /** Begin the in-flight-turn UI: status bar visible, button becomes Stop. */
    private void startTurnUi(int startIndex) {
        turnActive = true;
        turnStartIndex = startIndex;
        turnStartMs = System.currentTimeMillis();
        lastActivityMs = turnStartMs;
        streamingIntoBubble = false;
        turnTextSegments = 0;
        statusPhase = PHASE_WORKING;
        currentToolLabel = "";
        turnToolIds.clear();
        streamBuf.setLength(0);
        turnAnswerText.setLength(0);
        setStreaming(true);
        statusBar.setVisibility(android.view.View.VISIBLE);
        updateStatusBar();
        uiHandler.removeCallbacks(statusTick);
        uiHandler.postDelayed(statusTick, 1000);
    }

    /** End the in-flight-turn UI: hide status bar, button becomes Send. */
    private void endTurnUi() {
        turnActive = false;
        streamingIntoBubble = false;
        uiHandler.removeCallbacks(statusTick);
        setStreaming(false);
        statusBar.setVisibility(android.view.View.GONE);
    }

    private void markActivity() { lastActivityMs = System.currentTimeMillis(); }

    /** Render the live status line from the current phase + elapsed time. */
    private void updateStatusBar() {
        if (!turnActive) return;
        long now = System.currentTimeMillis();
        long elapsed = (now - turnStartMs) / 1000;
        long idleMs = now - lastActivityMs;

        String label;
        switch (statusPhase) {
            case PHASE_THINKING: label = "✳ Thinking…"; break;
            case PHASE_TOOL:     label = "⚙ " + currentToolLabel; break;
            case PHASE_WRITING:  label = "✍ Writing…"; break;
            default:             label = "✳ Working…"; break;
        }

        int color;
        String text;
        if (idleMs > STUCK_MS) {
            // No activity for a while — may be a long silent step or a hang.
            color = COLOR_AMBER;
            text = "⚠ " + label + " · no update " + (idleMs / 1000) + "s — tap to interrupt";
        } else {
            color = COLOR_GREEN;
            text = label + "  " + elapsed + "s";
        }
        statusText.setTextColor(color);
        statusText.setText(text);
        if (statusSpinner.getIndeterminateDrawable() != null) {
            statusSpinner.getIndeterminateDrawable()
                    .setColorFilter(color, android.graphics.PorterDuff.Mode.SRC_IN);
        }
    }

    /** Extended-thinking heartbeat from the server — keeps the bar "alive". */
    private void onThinking() {
        if (!turnActive) startTurnUi(chatAdapter.getItemCount());
        markActivity();
        if (statusPhase != PHASE_WRITING) statusPhase = PHASE_THINKING;
        updateStatusBar();
    }

    /** Append a streamed chunk to the current Claude bubble (throttled). */
    private void onDelta(String delta) {
        if (!turnActive) startTurnUi(chatAdapter.getItemCount());
        markActivity();
        statusPhase = PHASE_WRITING;
        if (!streamingIntoBubble) {
            // Start a fresh text segment (a new bubble below any tool lines).
            ChatMessage bubble = new ChatMessage(ChatMessage.TYPE_CLAUDE, "");
            bubble.showRendered = false; // plain while streaming; markdown on finalize
            chatAdapter.addMessage(bubble);
            streamingIntoBubble = true;
            turnTextSegments++;
            streamBuf.setLength(0);
            scrollToBottom();
        }
        streamBuf.append(delta);
        turnAnswerText.append(delta);
        scheduleStreamRender();
        updateStatusBar();
    }

    private final Runnable streamRender = () -> {
        streamRenderScheduled = false;
        // Only safe while the Claude bubble is still the last row; a tool event
        // ends the segment (streamingIntoBubble=false) before appending its line.
        if (!streamingIntoBubble) return;
        chatAdapter.updateLastText(streamBuf.toString(), false);
        // Don't call scrollToBottom() here — setStackFromEnd(true) keeps the
        // bottom visible; explicit scrolling during rapid updates causes jitter.
    };

    /**
     * Tool-call progress (P3). Tool lines are persistent: they stay in the
     * transcript as a browsable trail of what Claude did, and the live status
     * bar mirrors the running tool. `id` correlates the name event with the
     * later detail event; `detail` is a short argument summary.
     */
    private void onToolEvent(String status, String toolName, String id, String detail,
                             boolean ok, String result) {
        if ("running".equals(status)) {
            markActivity();
            // A tool ends the current text segment — flush it so the next text
            // delta starts a new bubble below this tool line.
            if (streamingIntoBubble) {
                chatList.removeCallbacks(streamRender);
                streamRenderScheduled = false;
                chatAdapter.updateLastText(streamBuf.toString(), false);
                streamingIntoBubble = false;
            }
            String name = toolName != null && !toolName.isEmpty() ? toolName : "tool";
            if (id != null && !id.isEmpty() && turnToolIds.contains(id)) {
                // Second event for the same tool — fill in its argument detail.
                if (detail != null && !detail.isEmpty()) chatAdapter.updateToolDetail(id, detail);
            } else {
                if (id != null && !id.isEmpty()) turnToolIds.add(id);
                chatAdapter.addMessage(new ChatMessage(name, id, detail));
                scrollToBottom();
            }
            statusPhase = PHASE_TOOL;
            currentToolLabel = name + (detail != null && !detail.isEmpty() ? " · " + detail : "");
            updateStatusBar();
        } else if ("result".equals(status)) {
            // Tool finished — annotate its line with the output snippet.
            markActivity();
            chatAdapter.updateToolResult(id, ok, result);
        } else if ("done".equals(status)) {
            markActivity();
            chatAdapter.markToolsDone();
            statusPhase = PHASE_WORKING;
            currentToolLabel = "";
            updateStatusBar();
        }
    }

    private void scheduleStreamRender() {
        if (streamRenderScheduled) return;
        streamRenderScheduled = true;
        chatList.postDelayed(streamRender, 80);
    }

    /** Finalize the current turn: render the answer text as Markdown, settle UI. */
    private void finalizeTurn(String text) {
        chatList.removeCallbacks(streamRender);
        streamRenderScheduled = false;
        // Flush any trailing partial segment into its bubble.
        if (streamingIntoBubble) {
            chatAdapter.updateLastText(streamBuf.toString(), false);
            streamingIntoBubble = false;
        }
        chatAdapter.markToolsDone();

        // Canonical text == concatenation of all streamed segments. Prefer it
        // (clean Markdown / guards against dropped deltas) when there is exactly
        // one segment; with multiple interleaved segments, render them in place
        // so we don't duplicate earlier text.
        String answer = (text != null && !text.isEmpty()) ? text : turnAnswerText.toString();
        if (turnTextSegments == 1 && answer != null && !answer.isEmpty()) {
            chatAdapter.setLastClaudeText(turnStartIndex, answer);
        } else if (turnTextSegments > 1) {
            chatAdapter.renderClaudeFrom(turnStartIndex);
        } else if (answer != null && !answer.isEmpty()) {
            chatAdapter.addMessage(new ChatMessage(ChatMessage.TYPE_CLAUDE, answer));
        }

        endTurnUi();
        scrollToBottom();

        // Persist this turn locally so the user can browse offline later
        if (lastSentUser != null) {
            String persist = answer != null ? answer : "";
            ChatHistoryStore.getInstance().appendTurn(sessionId, lastSentUser,
                    new ChatMessage(ChatMessage.TYPE_CLAUDE, persist));
            lastSentUser = null;
        }
        streamBuf.setLength(0);
        turnAnswerText.setLength(0);
        turnTextSegments = 0;
    }

    /** Toggle the send button between Send and Stop (Stop while a turn runs). */
    private void setStreaming(boolean s) {
        btnSend.setImageResource(s
                ? android.R.drawable.ic_menu_close_clear_cancel
                : android.R.drawable.ic_menu_send);
        btnSend.setContentDescription(s ? "Stop" : "Send");
    }

    private void sendInterrupt() {
        WebSocketManager.getInstance().sendInterrupt(sessionId);
    }

    /** Confirm before interrupting an in-progress Claude turn. */
    private void confirmInterrupt() {
        new AlertDialog.Builder(this)
                .setTitle("Stop Claude")
                .setMessage("Interrupt Claude's current response?")
                .setPositiveButton("Stop", (d, w) -> sendInterrupt())
                .setNegativeButton("Cancel", null).create().show();
    }

    private void handleChatHistory(JsonObject data) {
        runOnUiThread(() -> {
            endTurnUi(); // history is the new source of truth; drop stale turn UI
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
                // A turn was already in flight on the server (e.g. reconnect or
                // returning from background): show the live status bar and
                // anchor the elapsed timer to the server's reported duration so
                // it doesn't restart from zero each time we re-attach.
                startTurnUi(chatAdapter.getItemCount());
                if (data.has("pendingMs") && !data.get("pendingMs").isJsonNull()) {
                    long pendingMs = data.get("pendingMs").getAsLong();
                    if (pendingMs > 0) {
                        turnStartMs = System.currentTimeMillis() - pendingMs;
                        updateStatusBar();
                    }
                }
            }
            scrollToBottom();
        });
    }

    private void handleError(JsonObject data) {
        String error = data.has("error") ? data.get("error").getAsString() : "Unknown error";
        runOnUiThread(() -> {
            // While a turn is in flight, settle it with the error appended so the
            // bubble settles and the status bar/button reset.
            if (turnActive) {
                String prefix = turnAnswerText.length() > 0 ? turnAnswerText + "\n\n" : "";
                finalizeTurn(prefix + "⚠ " + error);
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
        // If a turn is in flight, stop is handled in the button click — in
        // case we get here via keyboard, block sending while busy.
        if (turnActive) return;

        // Keep leading/trailing spaces so commands like "  indent" aren't lost.
        // Only reject truly empty input.
        final String raw = inputText.getText().toString();
        if (raw.trim().isEmpty()) return;

        if (!isSessionRunning) {
            Toast.makeText(this, "Session stopped — tap ⋮ → Resume to continue", Toast.LENGTH_SHORT).show();
            return;
        }

        final String text = raw;

        WebSocketManager wm = WebSocketManager.getInstance();
        if (!wm.isConnected()) {
            wm.connect();
            Toast.makeText(this, "Not connected — reconnecting...", Toast.LENGTH_SHORT).show();
            return;
        }

        inputText.setText("");
        com.romp.ccremote.util.PreferencesHelper.clearInputDraft(sessionId);
        final int startIndex = chatAdapter.getItemCount();
        lastSentUser = new ChatMessage(ChatMessage.TYPE_USER, text.trim());
        chatAdapter.addMessage(lastSentUser);
        // Liveness is shown by the status bar (no placeholder bubble).
        startTurnUi(startIndex);

        // Scroll without guard — always go to bottom after sending
        final int target = chatAdapter.getItemCount() - 1;
        chatList.postDelayed(() -> {
            chatList.scrollToPosition(target);
        }, 100);

        if (!wm.sendChat(sessionId, text.trim())) {
            chatAdapter.removeLast();
            endTurnUi();
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
