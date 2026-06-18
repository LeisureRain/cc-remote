package com.romp.ccremote.ui;

import android.os.Bundle;
import android.view.MenuItem;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.widget.Toolbar;

import com.google.android.material.textfield.TextInputEditText;
import com.romp.ccremote.R;
import com.romp.ccremote.util.PreferencesHelper;
import com.romp.ccremote.websocket.WebSocketManager;

public class SettingsActivity extends AppCompatActivity {

    private TextInputEditText inputIp;
    private TextInputEditText inputPort;
    private TextInputEditText inputToken;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_settings);

        Toolbar toolbar = findViewById(R.id.toolbar);
        setSupportActionBar(toolbar);
        if (getSupportActionBar() != null) {
            getSupportActionBar().setDisplayHomeAsUpEnabled(true);
            getSupportActionBar().setDisplayShowTitleEnabled(true);
        }

        inputIp = findViewById(R.id.input_ip);
        inputPort = findViewById(R.id.input_port);
        inputToken = findViewById(R.id.input_token);

        // Load current settings
        String savedIp = "192.168.1.100";
        int savedPort = 11199;
        String savedToken = "";
        try {
            savedIp = PreferencesHelper.getServerIp();
            savedPort = PreferencesHelper.getServerPort();
            savedToken = PreferencesHelper.getAuthToken();
        } catch (Exception e) { /* defaults */ }

        inputIp.setText(savedIp);
        inputPort.setText(String.valueOf(savedPort));
        inputToken.setText(savedToken);

        findViewById(R.id.btn_save).setOnClickListener(v -> saveSettings());
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == android.R.id.home) {
            onBackPressed();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    private void saveSettings() {
        String ip = inputIp.getText().toString().trim();
        String portStr = inputPort.getText().toString().trim();
        String token = inputToken.getText().toString().trim();

        if (ip.isEmpty()) {
            Toast.makeText(this, "Please enter server IP address", Toast.LENGTH_SHORT).show();
            return;
        }

        int port;
        try {
            port = Integer.parseInt(portStr);
            if (port < 1 || port > 65535) throw new NumberFormatException();
        } catch (NumberFormatException e) {
            Toast.makeText(this, "Please enter a valid port (1-65535)", Toast.LENGTH_SHORT).show();
            return;
        }

        PreferencesHelper.setServerIp(ip);
        PreferencesHelper.setServerPort(port);
        PreferencesHelper.setAuthToken(token);

        Toast.makeText(this, "Settings saved. Reconnecting...", Toast.LENGTH_SHORT).show();
        WebSocketManager.getInstance().reconnect();
        finish();
    }
}
