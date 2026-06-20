package com.romp.ccremote.model;

/**
 * A single chat message in the terminal conversation.
 */
public class ChatMessage {
    public static final int TYPE_USER = 0;
    public static final int TYPE_CLAUDE = 1;
    public static final int TYPE_TOOL = 2;

    public int type;       // TYPE_USER / TYPE_CLAUDE / TYPE_TOOL
    public String text;    // message content
    public long timestamp; // System.currentTimeMillis()
    public boolean showRendered = true; // true = render Markdown, false = plain text
    public String toolName; // tool name e.g. "bash", "read" — only set for TYPE_TOOL
    public String toolId;   // claude tool_use id — used to fill in detail later (TYPE_TOOL)
    public String toolDetail; // tool argument summary e.g. "npm test" (TYPE_TOOL)
    public boolean toolDone; // true once the tool phase finished (TYPE_TOOL)

    public ChatMessage(int type, String text) {
        this(type, text, System.currentTimeMillis());
    }

    public ChatMessage(int type, String text, long timestamp) {
        this.type = type;
        this.text = text;
        this.timestamp = timestamp;
    }

    /** Constructor for TYPE_TOOL messages. */
    public ChatMessage(String toolName) {
        this.type = TYPE_TOOL;
        this.toolName = toolName;
        this.text = "";
        this.timestamp = System.currentTimeMillis();
    }

    /** Constructor for TYPE_TOOL messages carrying a tool_use id + detail. */
    public ChatMessage(String toolName, String toolId, String toolDetail) {
        this.type = TYPE_TOOL;
        this.toolName = toolName;
        this.toolId = toolId;
        this.toolDetail = toolDetail;
        this.text = "";
        this.timestamp = System.currentTimeMillis();
    }

    public boolean isUser() { return type == TYPE_USER; }

    /** Serialize this message to a JSON entry matching the server's chat_history format. */
    public com.google.gson.JsonObject toEntry() {
        com.google.gson.JsonObject obj = new com.google.gson.JsonObject();
        obj.addProperty("role", type == TYPE_USER ? "user" : "assistant");
        if (text != null) obj.addProperty("text", text);
        obj.addProperty("ts", timestamp);
        return obj;
    }

    /** Create a ChatMessage from a server chat_history entry. */
    public static ChatMessage fromEntry(com.google.gson.JsonObject entry) {
        String role = entry.has("role") ? entry.get("role").getAsString() : "assistant";
        String text = entry.has("text") ? entry.get("text").getAsString() : "";
        long ts = entry.has("ts") && !entry.get("ts").isJsonNull()
                ? entry.get("ts").getAsLong() : System.currentTimeMillis();
        int type = "user".equals(role) ? TYPE_USER : TYPE_CLAUDE;
        return new ChatMessage(type, text, ts);
    }
}
