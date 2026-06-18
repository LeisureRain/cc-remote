package com.romp.ccremote.model;

/**
 * Represents a Claude Code session on the server
 */
public class SessionInfo {
    public String id;
    public String directory;
    public String createdAt;
    public String status;      // "running" or "exited"
    public Integer exitCode;
    public int clientCount;
    public int bufferSize;

    public SessionInfo() {}

    public boolean isRunning() {
        return "running".equals(status);
    }

    public String getDisplayTitle() {
        // Show directory name as title
        String dir = directory != null ? directory : "/";
        if (dir.endsWith("/") || dir.endsWith("\\")) {
            dir = dir.substring(0, dir.length() - 1);
        }
        int lastSep = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'));
        if (lastSep >= 0 && lastSep < dir.length() - 1) {
            return dir.substring(lastSep + 1);
        }
        return dir;
    }

    public String getDisplayStatus() {
        if (isRunning()) {
            return "● Running";
        }
        return "✕ Exited (" + (exitCode != null ? exitCode : "?") + ")";
    }
}
