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

    public ChatMessage(int type, String text) {
        this.type = type;
        this.text = text;
        this.timestamp = System.currentTimeMillis();
    }

    public boolean isUser() { return type == TYPE_USER; }
}
