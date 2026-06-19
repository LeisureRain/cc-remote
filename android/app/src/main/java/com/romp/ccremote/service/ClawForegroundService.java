package com.romp.ccremote.service;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import com.google.gson.JsonObject;
import com.romp.ccremote.ui.MainActivity;
import com.romp.ccremote.ui.TerminalActivity;
import com.romp.ccremote.websocket.WebSocketManager;

import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Foreground service — keeps WebSocket alive in background.
 * Posts reply notifications when TerminalActivity is not visible.
 */
public class ClawForegroundService extends Service {

    private static final String TAG = "ClawService";
    private static final String CHANNEL_ID = "remote_claw_fg";
    private static final String REPLY_CHANNEL = "remote_claw_reply";
    private static final int NOTIFY_ID = 1;

    private static final String ACTION_START = "com.romp.ccremote.START_SERVICE";
    private static final String ACTION_STOP  = "com.romp.ccremote.STOP_SERVICE";
    private static final String EXTRA_SESSION_ID  = "session_id";
    private static final String EXTRA_SESSION_DIR = "session_dir";

    private static ClawForegroundService instance;

    // Session currently visible in a foreground TerminalActivity. Set directly
    // by the activity (not via the service instance), so the foreground check
    // is race-free even before the service has finished starting.
    private static volatile String visibleSessionId;

    private String sessionId;
    private String sessionDir;
    private boolean started = false;   // true after first onStartCommand

    private final CopyOnWriteArrayList<ChatCallback> callbacks = new CopyOnWriteArrayList<>();

    public interface ChatCallback {
        void onSessionKilled(String sessionId);
        void onSessionExited(String sessionId, int exitCode);
    }

    private final WebSocketManager.MessageListener msgListener = this::onWsMessage;
    private final WebSocketManager.ConnectionListener connListener = this::onWsConnected;

    // ============================================================
    // Static helpers
    // ============================================================

    public static void start(Context ctx, String sessionId, String sessionDir) {
        Intent i = new Intent(ctx, ClawForegroundService.class);
        i.setAction(ACTION_START);
        i.putExtra(EXTRA_SESSION_ID, sessionId);
        i.putExtra(EXTRA_SESSION_DIR, sessionDir);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startForegroundService(i);
        } else {
            ctx.startService(i);
        }
    }

    public static void stop(Context ctx) {
        Intent i = new Intent(ctx, ClawForegroundService.class);
        i.setAction(ACTION_STOP);
        ctx.startService(i);
    }

    public static ClawForegroundService getInstance() { return instance; }

    /** Mark a session as visible in the foreground (call from Activity.onResume). */
    public static void setVisibleSession(String sid) { visibleSessionId = sid; }

    /** Clear the visible marker (call from Activity.onPause). */
    public static void clearVisibleSession(String sid) {
        if (sid != null && sid.equals(visibleSessionId)) visibleSessionId = null;
    }

    /** Whether this service's session is currently shown in a foreground activity. */
    private boolean isSessionVisible() {
        return sessionId != null && sessionId.equals(visibleSessionId);
    }

    public static void initChannel(Context ctx) {
        NotificationManager nm = (NotificationManager)
                ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // Low-importance (not NONE) channel for the foreground notification.
            // IMPORTANCE_NONE can cause some OEMs to suppress or replace the
            // required foreground-service notification; MIN keeps it quiet but
            // valid.
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "CC Remote",
                    NotificationManager.IMPORTANCE_MIN);
            ch.setShowBadge(false);
            ch.setSound(null, null);
            ch.enableLights(false);
            ch.enableVibration(false);
            nm.createNotificationChannel(ch);

            // Reply channel with alert
            NotificationChannel rch = new NotificationChannel(
                    REPLY_CHANNEL, "Claude Replies",
                    NotificationManager.IMPORTANCE_HIGH);
            rch.setDescription("Notifications when Claude responds");
            nm.createNotificationChannel(rch);
        }
    }

    // ============================================================
    // Service
    // ============================================================

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_STICKY;
        String action = intent.getAction();
        Log.d(TAG, "onStartCommand: " + action);

        if (ACTION_START.equals(action)) {
            String sid = intent.getStringExtra(EXTRA_SESSION_ID);
            // Only re-init if session changed
            if (started && sessionId != null && sessionId.equals(sid)) {
                Log.d(TAG, "Already running for session " + sid);
                return START_STICKY;
            }
            sessionId = sid;
            sessionDir = intent.getStringExtra(EXTRA_SESSION_DIR);
            startForeground(NOTIFY_ID, buildFgNotification());
            registerWsListeners();
            started = true;
            Log.d(TAG, "Foreground started for " + sessionId);
        } else if (ACTION_STOP.equals(action)) {
            unregisterWsListeners();
            stopForeground(true);
            stopSelf();
            instance = null;
            started = false;
            Log.d(TAG, "Stopped");
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onDestroy() {
        unregisterWsListeners();
        instance = null;
        started = false;
        super.onDestroy();
    }

    public void addCallback(ChatCallback cb) { if (cb != null) callbacks.add(cb); }
    public void removeCallback(ChatCallback cb) { callbacks.remove(cb); }
    public String getSessionId() { return sessionId; }

    // ============================================================
    // WebSocket
    // ============================================================

    private void registerWsListeners() {
        WebSocketManager wm = WebSocketManager.getInstance();
        wm.addMessageListener(msgListener);
        wm.addConnectionListener(connListener);
    }

    private void unregisterWsListeners() {
        WebSocketManager wm = WebSocketManager.getInstance();
        wm.removeMessageListener(msgListener);
        wm.removeConnectionListener(connListener);
    }

    private void onWsConnected(boolean connected) {
        if (connected && sessionId != null) {
            WebSocketManager.getInstance().sendConnectSession(sessionId);
        }
    }

    private void onWsMessage(String type, JsonObject data) {
        String sid = data.has("session_id") ? data.get("session_id").getAsString() : null;
        if (sid == null || !sid.equals(sessionId)) return;

        switch (type) {
            case "session_response": {
                String text = data.has("data") ? data.get("data").getAsString() : "";
                if (text.isEmpty()) break;
                // UI rendering is handled by TerminalActivity's own message
                // listener (always registered). The service only decides
                // whether a background notification is needed.
                if (isSessionVisible()) {
                    cancelReplyNotification();
                } else {
                    showReplyNotification(text);
                }
                break;
            }
            case "session_killed": {
                for (ChatCallback cb : callbacks) cb.onSessionKilled(sessionId);
                if (!isSessionVisible()) showEventNotification("Session ended (killed)");
                stopForeground(true);
                stopSelf();
                instance = null;
                break;
            }
            case "session_exited": {
                int code = data.has("exit_code") ? data.get("exit_code").getAsInt() : -1;
                for (ChatCallback cb : callbacks) cb.onSessionExited(sessionId, code);
                if (!isSessionVisible()) showEventNotification("Claude exited (code " + code + ")");
                break;
            }
        }
    }

    // ============================================================
    // Notifications
    // ============================================================

    /** Minimal foreground notification — silent, barely visible. */
    private Notification buildFgNotification() {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("")
                .setContentText("")
                .setSmallIcon(android.R.drawable.ic_menu_info_details)
                .setOngoing(true)
                .setSilent(true)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .build();
    }

    /** Reply notification when Claude responds and TerminalActivity is not visible. */
    private void showReplyNotification(String text) {
        PendingIntent pi = makeTerminalIntent();
        String body = text.length() > 150 ? text.substring(0, 147) + "…" : text;

        Notification notif = new NotificationCompat.Builder(this, REPLY_CHANNEL)
                .setContentTitle("Claude replied")
                .setContentText(body)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentIntent(pi)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .build();

        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(getReplyNotifyId(), notif);
    }

    /** Cancel the reply notification for the current session (message already seen). */
    public void cancelReplyNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(getReplyNotifyId());
    }

    /** Lifecycle event notification (session killed / Claude exited) when backgrounded. */
    private void showEventNotification(String body) {
        Notification notif = new NotificationCompat.Builder(this, REPLY_CHANNEL)
                .setContentTitle("CC Remote")
                .setContentText(body)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentIntent(makeTerminalIntent())
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .build();
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(getReplyNotifyId(), notif);
    }

    /**
     * Deterministic notification ID tied to the session, so we can
     * cancel the exact notification that was shown for this session.
     */
    private int getReplyNotifyId() {
        return replyNotifyId(sessionId);
    }

    /** Stable reply-notification ID for a given session id (used by callers too). */
    public static int replyNotifyId(String sessionId) {
        return 1000 + (sessionId != null ? sessionId.hashCode() & 0xFFFF : 0);
    }

    /**
     * Build a PendingIntent that opens TerminalActivity for the current
     * session, clearing any previous instance so we don't accumulate
     * duplicate activities in the back stack.
     */
    private PendingIntent makeTerminalIntent() {
        Intent intent = new Intent(this, TerminalActivity.class);
        intent.putExtra("session_id", sessionId);
        intent.putExtra("session_directory", sessionDir);
        intent.putExtra("session_status", "running");
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, (sessionId != null ? sessionId.hashCode() : 0) & 0xFFFF,
                intent, flags);
    }

}
