package com.romp.ccremote.websocket;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.reflect.TypeToken;
import com.romp.ccremote.model.ProfileInfo;
import com.romp.ccremote.model.SessionInfo;
import com.romp.ccremote.util.PreferencesHelper;

import java.lang.reflect.Type;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * Singleton WebSocket manager for communicating with the Remote Claw server.
 */
public class WebSocketManager {
    private static final String TAG = "WebSocketManager";
    private static final int RECONNECT_DELAY_MS = 3000;
    private static final int MAX_RECONNECT_ATTEMPTS = 10;
    private static final int CONNECT_TIMEOUT_SEC = 10;

    private static volatile WebSocketManager instance;

    private final OkHttpClient client;
    private final Gson gson;
    private final Handler mainHandler;

    private WebSocket webSocket;
    private volatile boolean isConnected = false;
    private volatile boolean isConnecting = false;
    private int reconnectAttempts = 0;
    private volatile boolean shouldReconnect = false;  // Start false, set true after first manual connect

    // Server info (updated on connect / explicit request)
    private volatile String serverOs = null;
    private volatile String serverPathSeparator = "/";
    private volatile String[] serverCommonPaths = new String[0];
    private volatile String serverWorkspace = null;

    // Listeners
    private final List<MessageListener> messageListeners = new ArrayList<>();
    private final List<ConnectionListener> connectionListeners = new ArrayList<>();
    private final List<SessionListListener> sessionListListeners = new ArrayList<>();
    private final List<ServerInfoListener> serverInfoListeners = new ArrayList<>();
    private final List<DirectoryListListener> directoryListListeners = new ArrayList<>();
    private final List<ProfileListListener> profileListListeners = new ArrayList<>();

    private WebSocketManager() {
        this.client = new OkHttpClient.Builder()
                .readTimeout(0, TimeUnit.MILLISECONDS)  // No read timeout for streaming
                .writeTimeout(CONNECT_TIMEOUT_SEC, TimeUnit.SECONDS)
                .connectTimeout(CONNECT_TIMEOUT_SEC, TimeUnit.SECONDS)
                // Don't use pingInterval — server doesn't handle WebSocket pings the same way
                .retryOnConnectionFailure(true)
                .build();
        this.gson = new Gson();
        this.mainHandler = new Handler(Looper.getMainLooper());
    }

    public static WebSocketManager getInstance() {
        if (instance == null) {
            synchronized (WebSocketManager.class) {
                if (instance == null) {
                    instance = new WebSocketManager();
                }
            }
        }
        return instance;
    }

    public static void init() {
        getInstance();
    }

    // ============================================================
    // Connection management
    // ============================================================

    /**
     * Connect to the server. Call this from UI thread.
     * User-initiated connect — resets the reconnect backoff counter.
     */
    public void connect() {
        connectInternal(true);
    }

    private void connectInternal(boolean resetAttempts) {
        if (isConnecting || isConnected) {
            Log.d(TAG, "Already connected or connecting, skipping");
            return;
        }

        // Close any existing connection
        if (webSocket != null) {
            try {
                webSocket.close(1000, "Reconnecting");
            } catch (Exception e) {
                // Ignore
            }
            webSocket = null;
        }

        isConnecting = true;
        shouldReconnect = true;
        // Only reset the backoff counter for an explicit (user-initiated)
        // connect. Auto-reconnects must NOT reset it, otherwise the backoff
        // and MAX_RECONNECT_ATTEMPTS limit are defeated and we loop forever.
        if (resetAttempts) reconnectAttempts = 0;

        String url = PreferencesHelper.getWebSocketUrl();
        Log.d(TAG, "Connecting to " + url);

        Request request = new Request.Builder()
                .url(url)
                .header("User-Agent", "RemoteClaw-Android")
                .build();

        webSocket = client.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                Log.d(TAG, "Connected successfully! Response: " + (response != null ? response.code() : "null"));
                isConnected = true;
                isConnecting = false;
                reconnectAttempts = 0;
                notifyConnectionChanged(true);
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                handleMessage(text);
            }

            @Override
            public void onMessage(WebSocket webSocket, ByteString bytes) {
                // Not expected
            }

            @Override
            public void onClosing(WebSocket webSocket, int code, String reason) {
                Log.d(TAG, "Server closing: code=" + code + " reason=" + reason);
                webSocket.close(1000, null);
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                Log.d(TAG, "Closed: code=" + code + " reason=" + reason);
                isConnected = false;
                isConnecting = false;
                notifyConnectionChanged(false);
                // 4001 = auth failed — don't retry
                if (code == 4001) {
                    Log.w(TAG, "Auth rejected by server. Check your token in Settings.");
                    shouldReconnect = false;
                    // Broadcast error so UI can show it
                    com.google.gson.JsonObject err = new com.google.gson.JsonObject();
                    err.addProperty("type", "error");
                    err.addProperty("message", "Authentication failed. Check token in Settings.");
                    notifyMessage("error", err);
                } else {
                    scheduleReconnect();
                }
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                int respCode = response != null ? response.code() : -1;
                Log.e(TAG, "Connection failed: " + t.getMessage() + " responseCode=" + respCode);
                isConnected = false;
                isConnecting = false;
                notifyConnectionChanged(false);
                scheduleReconnect();
            }
        });
    }

    /**
     * Disconnect from the server
     */
    public void disconnect() {
        shouldReconnect = false;
        reconnectAttempts = 0;

        if (webSocket != null) {
            try {
                webSocket.close(1000, "Client disconnect");
            } catch (Exception e) {
                Log.e(TAG, "Error closing websocket: " + e.getMessage());
            }
            webSocket = null;
        }

        isConnected = false;
        isConnecting = false;
        notifyConnectionChanged(false);
    }

    /**
     * Force reconnect after settings change
     */
    public void reconnect() {
        Log.d(TAG, "Forcing reconnect...");
        disconnect();

        mainHandler.postDelayed(() -> {
            shouldReconnect = true;
            connect();
        }, 800);
    }

    private void scheduleReconnect() {
        if (!shouldReconnect) {
            Log.d(TAG, "Not scheduling reconnect: shouldReconnect=false");
            return;
        }
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            Log.w(TAG, "Max reconnect attempts (" + MAX_RECONNECT_ATTEMPTS + ") reached");
            // Notify UI so it can show a toast
            com.google.gson.JsonObject err = new com.google.gson.JsonObject();
            err.addProperty("type", "error");
            err.addProperty("message", "Cannot connect to server. Please check the address and ensure the server is running.");
            notifyMessage("error", err);
            return;
        }

        reconnectAttempts++;
        int delay = RECONNECT_DELAY_MS * reconnectAttempts; // Exponential-ish backoff
        Log.d(TAG, "Scheduling reconnect #" + reconnectAttempts + " in " + delay + "ms");

        mainHandler.postDelayed(() -> {
            if (!isConnected && shouldReconnect) {
                connectInternal(false);
            }
        }, delay);
    }

    // ============================================================
    // Message handling
    // ============================================================

    private void handleMessage(String text) {
        try {
            JsonObject msg = JsonParser.parseString(text).getAsJsonObject();
            String type = msg.has("type") ? msg.get("type").getAsString() : "";

            switch (type) {
                case "session_list":
                    handleSessionList(msg);
                    return;
                case "server_info":
                    handleServerInfo(msg);
                    return;
                case "directory_list":
                    handleDirectoryList(msg);
                    return;
                case "profile_list":
                    handleProfileList(msg);
                    return;
                default:
                    break;
            }

            // Forward all other messages to listeners
            notifyMessage(type, msg);

        } catch (Exception e) {
            Log.e(TAG, "Error parsing message: " + e.getMessage() + " raw=" + text.substring(0, Math.min(100, text.length())));
        }
    }

    private void handleSessionList(JsonObject msg) {
        try {
            JsonArray sessionsArray = msg.getAsJsonArray("sessions");
            Type listType = new TypeToken<List<SessionInfo>>(){}.getType();
            List<SessionInfo> sessions = gson.fromJson(sessionsArray, listType);
            notifySessionList(sessions);
        } catch (Exception e) {
            Log.e(TAG, "Error parsing session list: " + e.getMessage());
            notifyMessage("session_list", msg);
        }
    }

    private void handleServerInfo(JsonObject msg) {
        try {
            serverOs = msg.has("os") ? msg.get("os").getAsString() : null;
            serverPathSeparator = msg.has("pathSeparator") ? msg.get("pathSeparator").getAsString() : "/";
            if (msg.has("commonPaths")) {
                JsonArray arr = msg.getAsJsonArray("commonPaths");
                String[] paths = new String[arr.size()];
                for (int i = 0; i < arr.size(); i++) {
                    paths[i] = arr.get(i).getAsString();
                }
                serverCommonPaths = paths;
            }
            serverWorkspace = msg.has("workspace") ? msg.get("workspace").getAsString() : null;
            notifyServerInfo(serverOs, serverPathSeparator, serverCommonPaths);
        } catch (Exception e) {
            Log.e(TAG, "Error parsing server info: " + e.getMessage());
        }
    }

    private void handleDirectoryList(JsonObject msg) {
        try {
            String dirPath = msg.has("path") ? msg.get("path").getAsString() : "/";
            String parent = msg.has("parent") && !msg.get("parent").isJsonNull()
                    ? msg.get("parent").getAsString() : null;
            JsonArray entriesArr = msg.getAsJsonArray("entries");
            List<DirectoryEntry> entries = new ArrayList<>();
            for (int i = 0; i < entriesArr.size(); i++) {
                JsonObject entry = entriesArr.get(i).getAsJsonObject();
                entries.add(new DirectoryEntry(
                        entry.get("name").getAsString(),
                        entry.get("type").getAsString()));
            }
            notifyDirectoryList(dirPath, parent, entries);
        } catch (Exception e) {
            Log.e(TAG, "Error parsing directory list: " + e.getMessage());
        }
    }

    private void handleProfileList(JsonObject msg) {
        try {
            JsonArray arr = msg.getAsJsonArray("profiles");
            Type listType = new TypeToken<List<ProfileInfo>>(){}.getType();
            List<ProfileInfo> profiles = gson.fromJson(arr, listType);
            String active = msg.has("active") ? msg.get("active").getAsString() : "";
            notifyProfileList(profiles, active);
        } catch (Exception e) {
            Log.e(TAG, "Error parsing profile list: " + e.getMessage());
            notifyMessage("profile_list", msg);
        }
    }

    // ============================================================
    // Send methods
    // ============================================================

    public boolean isConnected() {
        return isConnected && webSocket != null;
    }

    private boolean send(String json) {
        if (!isConnected || webSocket == null) {
            Log.w(TAG, "Cannot send: not connected. isConnected=" + isConnected + " socket=" + (webSocket != null));
            return false;
        }
        boolean ok = webSocket.send(json);
        if (!ok) {
            Log.w(TAG, "send() returned false");
        }
        return ok;
    }

    public boolean sendListSessions() {
        return send("{\"type\":\"list_sessions\"}");
    }

    public boolean sendCreateSession(String directory) {
        JsonObject msg = new JsonObject();
        msg.addProperty("type", "create_session");
        msg.addProperty("directory", directory);
        return send(gson.toJson(msg));
    }

    public boolean sendConnectSession(String sessionId) {
        JsonObject msg = new JsonObject();
        msg.addProperty("type", "connect_session");
        msg.addProperty("session_id", sessionId);
        return send(gson.toJson(msg));
    }

    public boolean sendInput(String sessionId, String text) {
        JsonObject msg = new JsonObject();
        msg.addProperty("type", "send_input");
        msg.addProperty("session_id", sessionId);
        msg.addProperty("text", text);
        return send(gson.toJson(msg));
    }

    public boolean sendChat(String sessionId, String text) {
        return sendChat(sessionId, text, true);
    }

    public boolean sendChat(String sessionId, String text, boolean useContinue) {
        JsonObject msg = new JsonObject();
        msg.addProperty("type", "send_chat");
        msg.addProperty("session_id", sessionId);
        msg.addProperty("text", text);
        msg.addProperty("continue", useContinue);
        return send(gson.toJson(msg));
    }

    public boolean sendDisconnect(String sessionId) {
        JsonObject msg = new JsonObject();
        msg.addProperty("type", "disconnect_session");
        msg.addProperty("session_id", sessionId);
        return send(gson.toJson(msg));
    }

    public boolean sendKill(String sessionId) {
        JsonObject msg = new JsonObject();
        msg.addProperty("type", "kill_session");
        msg.addProperty("session_id", sessionId);
        return send(gson.toJson(msg));
    }

    public boolean sendInterrupt(String sessionId) {
        JsonObject msg = new JsonObject();
        msg.addProperty("type", "interrupt");
        msg.addProperty("session_id", sessionId);
        return send(gson.toJson(msg));
    }

    public boolean sendServerInfo() {
        return send("{\"type\":\"server_info\"}");
    }

    public boolean sendListDirectory(String path) {
        JsonObject msg = new JsonObject();
        msg.addProperty("type", "list_directory");
        msg.addProperty("path", path);
        return send(gson.toJson(msg));
    }

    // — Profile send methods —

    public boolean sendListProfiles() {
        return send("{\"type\":\"list_profiles\"}");
    }

    public boolean sendCreateProfile(String name, JsonObject content) {
        JsonObject msg = new JsonObject();
        msg.addProperty("type", "create_profile");
        msg.addProperty("name", name);
        msg.add("content", content);
        return send(gson.toJson(msg));
    }

    public boolean sendUpdateProfile(String id, String name, JsonObject content) {
        JsonObject msg = new JsonObject();
        msg.addProperty("type", "update_profile");
        msg.addProperty("id", id);
        if (name != null) msg.addProperty("name", name);
        if (content != null) msg.add("content", content);
        return send(gson.toJson(msg));
    }

    public boolean sendDeleteProfile(String id) {
        JsonObject msg = new JsonObject();
        msg.addProperty("type", "delete_profile");
        msg.addProperty("id", id);
        return send(gson.toJson(msg));
    }

    public boolean sendSwitchProfile(String id) {
        JsonObject msg = new JsonObject();
        msg.addProperty("type", "switch_profile");
        msg.addProperty("id", id);
        return send(gson.toJson(msg));
    }

    // ============================================================
    // Server info accessors
    // ============================================================

    public String getServerOs() {
        return serverOs;
    }

    public String getServerPathSeparator() {
        return serverPathSeparator;
    }

    public String[] getServerCommonPaths() {
        return serverCommonPaths;
    }

    public String getServerWorkspace() {
        return serverWorkspace;
    }

    // ============================================================
    // Directory entry model
    // ============================================================

    public static class DirectoryEntry {
        public final String name;
        public final String type; // "directory" or "file"

        public DirectoryEntry(String name, String type) {
            this.name = name;
            this.type = type;
        }

        public boolean isDirectory() {
            return "directory".equals(type);
        }
    }

    // ============================================================
    // Listener management
    // ============================================================

    public interface MessageListener {
        void onMessage(String type, JsonObject data);
    }

    public interface ConnectionListener {
        void onConnectionChanged(boolean connected);
    }

    public interface SessionListListener {
        void onSessionList(List<SessionInfo> sessions);
    }

    public interface ServerInfoListener {
        void onServerInfo(String os, String pathSeparator, String[] commonPaths, String workspace);
    }

    public interface DirectoryListListener {
        void onDirectoryList(String path, String parent, List<DirectoryEntry> entries);
    }

    public interface ProfileListListener {
        void onProfileList(List<ProfileInfo> profiles, String activeId);
    }

    public void addMessageListener(MessageListener listener) {
        synchronized (messageListeners) {
            if (!messageListeners.contains(listener)) {
                messageListeners.add(listener);
            }
        }
    }

    public void removeMessageListener(MessageListener listener) {
        synchronized (messageListeners) {
            messageListeners.remove(listener);
        }
    }

    public void addConnectionListener(ConnectionListener listener) {
        synchronized (connectionListeners) {
            if (!connectionListeners.contains(listener)) {
                connectionListeners.add(listener);
            }
        }
    }

    public void removeConnectionListener(ConnectionListener listener) {
        synchronized (connectionListeners) {
            connectionListeners.remove(listener);
        }
    }

    public void addSessionListListener(SessionListListener listener) {
        synchronized (sessionListListeners) {
            if (!sessionListListeners.contains(listener)) {
                sessionListListeners.add(listener);
            }
        }
    }

    public void removeSessionListListener(SessionListListener listener) {
        synchronized (sessionListListeners) {
            sessionListListeners.remove(listener);
        }
    }

    public void addServerInfoListener(ServerInfoListener listener) {
        synchronized (serverInfoListeners) {
            if (!serverInfoListeners.contains(listener)) {
                serverInfoListeners.add(listener);
            }
        }
    }

    public void removeServerInfoListener(ServerInfoListener listener) {
        synchronized (serverInfoListeners) {
            serverInfoListeners.remove(listener);
        }
    }

    public void addDirectoryListListener(DirectoryListListener listener) {
        synchronized (directoryListListeners) {
            if (!directoryListListeners.contains(listener)) {
                directoryListListeners.add(listener);
            }
        }
    }

    public void removeDirectoryListListener(DirectoryListListener listener) {
        synchronized (directoryListListeners) {
            directoryListListeners.remove(listener);
        }
    }

    public void addProfileListListener(ProfileListListener listener) {
        synchronized (profileListListeners) {
            if (!profileListListeners.contains(listener)) {
                profileListListeners.add(listener);
            }
        }
    }

    public void removeProfileListListener(ProfileListListener listener) {
        synchronized (profileListListeners) {
            profileListListeners.remove(listener);
        }
    }

    private void notifyMessage(String type, JsonObject data) {
        mainHandler.post(() -> {
            synchronized (messageListeners) {
                for (MessageListener listener : new ArrayList<>(messageListeners)) {
                    listener.onMessage(type, data);
                }
            }
        });
    }

    private void notifyConnectionChanged(boolean connected) {
        mainHandler.post(() -> {
            synchronized (connectionListeners) {
                for (ConnectionListener listener : new ArrayList<>(connectionListeners)) {
                    listener.onConnectionChanged(connected);
                }
            }
        });
    }

    private void notifySessionList(List<SessionInfo> sessions) {
        mainHandler.post(() -> {
            synchronized (sessionListListeners) {
                for (SessionListListener listener : new ArrayList<>(sessionListListeners)) {
                    listener.onSessionList(sessions);
                }
            }
        });
    }

    private void notifyServerInfo(String os, String pathSeparator, String[] commonPaths) {
        final String ws = serverWorkspace;
        mainHandler.post(() -> {
            synchronized (serverInfoListeners) {
                for (ServerInfoListener listener : new ArrayList<>(serverInfoListeners)) {
                    listener.onServerInfo(os, pathSeparator, commonPaths, ws);
                }
            }
        });
    }

    private void notifyDirectoryList(String path, String parent, List<DirectoryEntry> entries) {
        mainHandler.post(() -> {
            synchronized (directoryListListeners) {
                for (DirectoryListListener listener : new ArrayList<>(directoryListListeners)) {
                    listener.onDirectoryList(path, parent, entries);
                }
            }
        });
    }

    private void notifyProfileList(List<ProfileInfo> profiles, String activeId) {
        mainHandler.post(() -> {
            synchronized (profileListListeners) {
                for (ProfileListListener listener : new ArrayList<>(profileListListeners)) {
                    listener.onProfileList(profiles, activeId);
                }
            }
        });
    }
}
