package com.romp.ccremote;

import android.app.Application;

import com.romp.ccremote.websocket.WebSocketManager;
import com.romp.ccremote.util.ChatHistoryStore;
import com.romp.ccremote.util.PreferencesHelper;

/**
 * Application class - initializes global singletons
 */
public class ClawApplication extends Application {
    private static ClawApplication instance;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        PreferencesHelper.init(this);
        ChatHistoryStore.init(this);
        WebSocketManager.init();
        com.romp.ccremote.service.ClawForegroundService.initChannel(this);
    }

    public static ClawApplication getInstance() {
        return instance;
    }
}
