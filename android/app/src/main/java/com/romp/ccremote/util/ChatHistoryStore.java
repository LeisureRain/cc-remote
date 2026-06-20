package com.romp.ccremote.util;

import android.content.Context;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.romp.ccremote.model.ChatMessage;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Local mirror of the server's chat history for offline browsing.
 *
 * Each session's chat history is stored as a JSON array in
 * {filesDir}/sessions/{sessionId}.json, using the same
 * {@code [{role, text, ts}, ...]} format as the server's chat_history.entries.
 *
 * The server is the source of truth — when a chat_history message arrives,
 * the local file is overwritten unconditionally.
 */
public class ChatHistoryStore {
    private static final String SESSIONS_DIR = "sessions";
    private static final Gson gson = new Gson();

    private static ChatHistoryStore instance;
    private final File sessionsDir;

    private ChatHistoryStore(Context context) {
        sessionsDir = new File(context.getFilesDir(), SESSIONS_DIR);
    }

    public static synchronized void init(Context context) {
        if (instance == null) {
            instance = new ChatHistoryStore(context.getApplicationContext());
        }
    }

    public static ChatHistoryStore getInstance() {
        return instance;
    }

    // ---- public API ----

    /**
     * Load the locally cached chat history for a session.
     * Returns an empty list if no cache file exists.
     */
    public List<ChatMessage> load(String sessionId) {
        List<ChatMessage> messages = new ArrayList<>();
        File file = sessionFile(sessionId);
        if (!file.exists()) return messages;

        try (BufferedReader r = new BufferedReader(
                new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
            JsonArray arr = JsonParser.parseString(sb.toString()).getAsJsonArray();
            for (JsonElement el : arr) {
                ChatMessage msg = ChatMessage.fromEntry(el.getAsJsonObject());
                messages.add(msg);
            }
        } catch (Exception e) {
            // Corrupted file — delete and return empty
            file.delete();
        }
        return messages;
    }

    /**
     * Overwrite the local cache for a session.
     * Called when the server's chat_history arrives (source of truth).
     */
    public void save(String sessionId, List<ChatMessage> messages) {
        ensureSessionsDir();
        File file = sessionFile(sessionId);
        JsonArray arr = new JsonArray();
        for (ChatMessage m : messages) {
            if (m.type == ChatMessage.TYPE_TOOL) continue;
            arr.add(m.toEntry());
        }
        writeFile(file, gson.toJson(arr));
    }

    /**
     * Overwrite the local cache directly from the server's JSON entries array.
     * Avoids double deserialization/re-serialization.
     */
    public void saveFromEntries(String sessionId, JsonArray entries) {
        ensureSessionsDir();
        File file = sessionFile(sessionId);
        writeFile(file, gson.toJson(entries));
    }

    /**
     * Append a complete turn (user message + assistant reply) to an existing
     * history file. If the file doesn't exist yet, saves just those two entries.
     * Only appends non-tool, non-placeholder messages.
     */
    public void appendTurn(String sessionId, ChatMessage userMsg, ChatMessage claudeMsg) {
        if (userMsg == null && claudeMsg == null) return;
        ensureSessionsDir();

        List<ChatMessage> existing = load(sessionId);
        if (userMsg != null) existing.add(userMsg);
        if (claudeMsg != null) existing.add(claudeMsg);

        save(sessionId, existing);
    }

    /** Delete the local cache for a session. */
    public void delete(String sessionId) {
        File file = sessionFile(sessionId);
        if (file.exists()) file.delete();
    }

    // ---- internal ----

    private File sessionFile(String sessionId) {
        return new File(sessionsDir, sessionId + ".json");
    }

    private void ensureSessionsDir() {
        if (!sessionsDir.exists()) sessionsDir.mkdirs();
    }

    private void writeFile(File file, String json) {
        try (OutputStreamWriter w = new OutputStreamWriter(
                new FileOutputStream(file), StandardCharsets.UTF_8)) {
            w.write(json);
        } catch (Exception e) {
            // best effort — don't crash the UI
        }
    }
}
