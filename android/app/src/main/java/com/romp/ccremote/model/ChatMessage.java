package com.romp.ccremote.model;

/**
 * A single chat message in the terminal conversation.
 */
public class ChatMessage {
    public static final int TYPE_USER = 0;
    public static final int TYPE_CLAUDE = 1;

    public int type;       // TYPE_USER or TYPE_CLAUDE
    public String text;    // message content
    public long timestamp; // System.currentTimeMillis()
    public boolean showRendered = true; // true = render Markdown, false = plain text

    public ChatMessage(int type, String text) {
        this(type, text, System.currentTimeMillis());
    }

    public ChatMessage(int type, String text, long timestamp) {
        this.type = type;
        this.text = text;
        this.timestamp = timestamp;
    }

    public boolean isUser() { return type == TYPE_USER; }
}
