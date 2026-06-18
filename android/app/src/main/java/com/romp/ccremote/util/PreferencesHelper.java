package com.romp.ccremote.util;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * SharedPreferences helper for saving server connection settings
 */
public class PreferencesHelper {
    private static final String PREFS_NAME = "remote_claw_prefs";
    private static final String KEY_SERVER_IP = "server_ip";
    private static final String KEY_SERVER_PORT = "server_port";
    private static final String KEY_AUTH_TOKEN = "auth_token";
    private static final String KEY_LAST_DIRECTORY = "last_directory";
    private static final String KEY_RECENT_DIRECTORIES = "recent_dirs";

    private static SharedPreferences prefs;

    public static void init(Context context) {
        prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public static String getServerIp() {
        return prefs.getString(KEY_SERVER_IP, "192.168.1.100");
    }

    public static void setServerIp(String ip) {
        prefs.edit().putString(KEY_SERVER_IP, ip).apply();
    }

    public static int getServerPort() {
        return prefs.getInt(KEY_SERVER_PORT, 11199);
    }

    public static void setServerPort(int port) {
        prefs.edit().putInt(KEY_SERVER_PORT, port).apply();
    }

    public static String getAuthToken() {
        return prefs.getString(KEY_AUTH_TOKEN, "");
    }

    public static void setAuthToken(String token) {
        prefs.edit().putString(KEY_AUTH_TOKEN, token).apply();
    }

    public static String getLastDirectory() {
        return prefs.getString(KEY_LAST_DIRECTORY, "/");
    }

    public static void setLastDirectory(String dir) {
        prefs.edit().putString(KEY_LAST_DIRECTORY, dir).apply();
    }

    /** Recent directories for quick access (max 5). */
    public static java.util.List<String> getRecentDirectories() {
        String json = prefs.getString(KEY_RECENT_DIRECTORIES, "[]");
        try {
            java.lang.reflect.Type listType =
                new com.google.gson.reflect.TypeToken<java.util.List<String>>(){}.getType();
            java.util.List<String> dirs = new com.google.gson.Gson().fromJson(json, listType);
            return dirs != null ? dirs : new java.util.ArrayList<String>();
        } catch (Exception e) { return new java.util.ArrayList<String>(); }
    }

    public static void addRecentDirectory(String dir) {
        java.util.List<String> dirs = getRecentDirectories();
        dirs.remove(dir);
        dirs.add(0, dir);
        if (dirs.size() > 5) dirs = new java.util.ArrayList<>(dirs.subList(0, 5));
        prefs.edit().putString(KEY_RECENT_DIRECTORIES, new com.google.gson.Gson().toJson(dirs)).apply();
    }

    public static String getWebSocketUrl() {
        String url = "ws://" + getServerIp() + ":" + getServerPort();
        String token = getAuthToken();
        if (token != null && !token.isEmpty()) {
            try {
                url += "?token=" + java.net.URLEncoder.encode(token, "UTF-8");
            } catch (Exception e) {
                url += "?token=" + token;
            }
        }
        return url;
    }

    /** HTTP origin for web-based terminal in WebView */
    public static String getHttpOrigin() {
        return "http://" + getServerIp() + ":" + getServerPort();
    }

    public static String getInputDraft(String sessionId) {
        return prefs.getString("draft_" + sessionId, "");
    }

    public static void setInputDraft(String sessionId, String text) {
        prefs.edit().putString("draft_" + sessionId, text).apply();
    }

    public static void clearInputDraft(String sessionId) {
        prefs.edit().remove("draft_" + sessionId).apply();
    }
}
