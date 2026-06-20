package com.romp.ccremote.ui;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.Menu;
import android.view.MenuItem;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.HorizontalScrollView;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.widget.Toolbar;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.romp.ccremote.R;
import com.romp.ccremote.model.ProfileInfo;
import com.romp.ccremote.model.SessionInfo;
import com.romp.ccremote.util.PreferencesHelper;
import com.romp.ccremote.websocket.WebSocketManager;
import com.romp.ccremote.websocket.WebSocketManager.DirectoryEntry;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends AppCompatActivity {

    private WebSocketManager wsManager;
    private SessionAdapter adapter;
    private RecyclerView sessionList;
    private TextView emptyText;
    private SwipeRefreshLayout swipeRefresh;
    private View statusDot;
    private TextView statusText;
    private TextView statusServer;
    private TextView statusProfile;

    // Profile cache (updated by WebSocket listener)
    private List<ProfileInfo> cachedProfiles = new ArrayList<>();
    private String cachedActiveId = "";
    private AlertDialog profileDialog;

    // Server info from last server_info response
    private String serverOs = null;
    private String serverPathSeparator = "/";
    private String[] serverCommonPaths = new String[0];
    private String serverWorkspace = null;

    private final WebSocketManager.SessionListListener sessionListListener = this::onSessionList;
    private final WebSocketManager.ConnectionListener connectionListener = this::onConnectionChanged;
    private final WebSocketManager.ServerInfoListener serverInfoListener = this::onServerInfo;
    private final WebSocketManager.ProfileListListener profileListListener = this::onProfileList;

    private final WebSocketManager.MessageListener messageListener = (type, data) -> {
        // Auto-refresh session list when a session is created, killed or deleted
        if ("session_created".equals(type) || "session_killed".equals(type) || "session_deleted".equals(type)) {
            refreshSessions();
        }
        // Auto-connect to newly created session
        if ("session_created".equals(type)) {
            String sid = data.has("session_id") ? data.get("session_id").getAsString() : null;
            String dir = data.has("directory") ? data.get("directory").getAsString() : "";
            if (sid != null) {
                openTerminal(sid, dir, "running");
            }
        }
        // Show connection errors to the user
        if ("error".equals(type)) {
            String msg = data.has("message") ? data.get("message").getAsString() : "Connection error";
            runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show());
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        wsManager = WebSocketManager.getInstance();

        // Setup toolbar
        Toolbar toolbar = findViewById(R.id.toolbar);
        setSupportActionBar(toolbar);
        toolbar.setNavigationOnClickListener(v -> openSettings());

        // Setup views
        statusDot = findViewById(R.id.status_dot);
        statusText = findViewById(R.id.status_text);
        statusServer = findViewById(R.id.status_server);
        statusProfile = findViewById(R.id.status_profile);
        statusProfile.setOnClickListener(v -> showProfileDialog());

        swipeRefresh = findViewById(R.id.swipe_refresh);
        swipeRefresh.setOnRefreshListener(this::refreshSessions);

        sessionList = findViewById(R.id.session_list);
        sessionList.setLayoutManager(new LinearLayoutManager(this));

        emptyText = findViewById(R.id.empty_text);

        adapter = new SessionAdapter(this::onSessionClicked);
        sessionList.setAdapter(adapter);

        // Setup buttons
        findViewById(R.id.btn_new_session).setOnClickListener(v -> showNewSessionDialog());
        findViewById(R.id.btn_settings).setOnClickListener(v -> openSettings());

        updateStatusBar();
        ensureNotificationPermission();
    }

    /**
     * Request POST_NOTIFICATIONS at runtime on Android 13+ so reply/event
     * notifications actually appear. Uses literal values because the project
     * compiles against SDK 31 (the TIRAMISU/permission constants don't exist
     * there yet); harmless no-op on apps targeting below 33.
     */
    private void ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            String perm = "android.permission.POST_NOTIFICATIONS";
            if (checkSelfPermission(perm) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{perm}, 1001);
            }
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        wsManager.addSessionListListener(sessionListListener);
        wsManager.addConnectionListener(connectionListener);
        wsManager.addServerInfoListener(serverInfoListener);
        wsManager.addMessageListener(messageListener);
        wsManager.addProfileListListener(profileListListener);

        // Try to connect if not connected
        if (!wsManager.isConnected()) {
            wsManager.connect();
        } else {
            refreshSessions();
            // Request server info to have OS-aware path prompts
            wsManager.sendServerInfo();
            wsManager.sendListProfiles();
        }

        // Refresh cached server info from WebSocketManager
        if (wsManager.getServerOs() != null) {
            serverOs = wsManager.getServerOs();
            serverPathSeparator = wsManager.getServerPathSeparator();
            serverCommonPaths = wsManager.getServerCommonPaths();
            serverWorkspace = wsManager.getServerWorkspace();
        }

        updateStatusBar();
    }

    @Override
    protected void onPause() {
        super.onPause();
        wsManager.removeSessionListListener(sessionListListener);
        wsManager.removeConnectionListener(connectionListener);
        wsManager.removeServerInfoListener(serverInfoListener);
        wsManager.removeMessageListener(messageListener);
        wsManager.removeProfileListListener(profileListListener);
    }

    private void onSessionList(List<SessionInfo> sessions) {
        runOnUiThread(() -> {
            swipeRefresh.setRefreshing(false);
            adapter.setSessions(sessions);

            if (sessions == null || sessions.isEmpty()) {
                emptyText.setVisibility(View.VISIBLE);
                sessionList.setVisibility(View.GONE);
            } else {
                emptyText.setVisibility(View.GONE);
                sessionList.setVisibility(View.VISIBLE);
            }
        });
    }

    private void onConnectionChanged(boolean connected) {
        runOnUiThread(() -> {
            updateStatusBar();
            if (connected) {
                refreshSessions();
                wsManager.sendServerInfo();
                wsManager.sendListProfiles();
                serverWorkspace = wsManager.getServerWorkspace();
            }
        });
    }

    private void onServerInfo(String os, String pathSeparator, String[] commonPaths, String workspace) {
        serverOs = os;
        serverPathSeparator = pathSeparator;
        serverCommonPaths = commonPaths;
        if (workspace != null) serverWorkspace = workspace;
    }

    private void updateStatusBar() {
        boolean connected = wsManager.isConnected();
        if (connected) {
            statusDot.setBackgroundResource(R.drawable.status_dot_green);
            statusText.setText(R.string.msg_connected);
        } else {
            statusDot.setBackgroundResource(R.drawable.status_dot_gray);
            statusText.setText(R.string.msg_disconnected);
        }
        String serverInfo;
        try {
            serverInfo = PreferencesHelper.getServerIp() + ":" + PreferencesHelper.getServerPort();
        } catch (Exception e) {
            serverInfo = "not configured";
        }
        statusServer.setText(serverInfo);
    }

    private void onProfileList(List<ProfileInfo> profiles, String activeId) {
        cachedProfiles = profiles != null ? profiles : new ArrayList<>();
        cachedActiveId = activeId != null ? activeId : "";
        runOnUiThread(() -> {
            updateProfileStatusBar();
            // If the profile picker is open, rebuild it so it reflects the
            // latest list/active state after a switch/create/rename/delete.
            if (profileDialog != null && profileDialog.isShowing()) {
                profileDialog.dismiss();
                showProfileDialog();
            }
        });
    }

    private void updateProfileStatusBar() {
        // Find the active profile name from cache
        String name = "Default";
        for (ProfileInfo p : cachedProfiles) {
            if (p.id.equals(cachedActiveId)) {
                name = p.name;
                break;
            }
        }
        statusProfile.setText("[" + name + "]");
        statusProfile.setVisibility(View.VISIBLE);
    }

    private void refreshSessions() {
        if (wsManager.isConnected()) {
            wsManager.sendListSessions();
        } else {
            swipeRefresh.setRefreshing(false);
        }
    }

    private void onSessionClicked(SessionInfo session) {
        openTerminal(session.id, session.directory, session.status);
    }

    private void openTerminal(String id, String directory, String status) {
        Intent intent = new Intent(this, TerminalActivity.class);
        intent.putExtra("session_id", id);
        intent.putExtra("session_directory", directory);
        intent.putExtra("session_status", status);
        startActivity(intent);
    }

    // ============================================================
    // New Session Dialog — with directory picker
    // ============================================================

    private void showNewSessionDialog() {
        if (!wsManager.isConnected()) {
            Toast.makeText(this, "Not connected to server. Please check Settings and ensure the server is running.", Toast.LENGTH_LONG).show();
            return;
        }

        // Build the directory-picker dialog UI programmatically
        final int padH = (int) (12 * getResources().getDisplayMetrics().density);
        final int padV = (int) (8 * getResources().getDisplayMetrics().density);

        // Ensure we have the latest workspace from WebSocketManager
        String ws = wsManager.getServerWorkspace();
        if (ws != null) serverWorkspace = ws;

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(padH, padV, padH, padV);
        root.setBackgroundColor(0xFF161B22);

        // --- Row 1: path label + text field ---
        TextView pathLabel = new TextView(this);
        pathLabel.setText("Working directory:");
        pathLabel.setTextColor(0xFFBBBBBB);
        pathLabel.setTextSize(13);
        root.addView(pathLabel);

        final EditText input = new EditText(this);
        input.setTextColor(0xFFE0E0E0);
        input.setHintTextColor(0xFF888888);
        input.setBackgroundResource(R.drawable.input_bg);
        input.setSingleLine(true);
        input.setPadding(padH + 4, padV + 2, padH + 4, padV + 2);

        // OS-aware path hint
        boolean isWin = serverOs != null && serverOs.contains("win");

        // Default directory: last used → server workspace → OS default
        String defaultDir = null;
        try {
            String lastDir = PreferencesHelper.getLastDirectory();
            if (lastDir != null && !lastDir.isEmpty()) {
                defaultDir = lastDir;
            }
        } catch (Exception e) { /* ignore */ }
        if (defaultDir == null && serverWorkspace != null && !serverWorkspace.isEmpty()) {
            defaultDir = serverWorkspace;
        }
        if (defaultDir == null) {
            defaultDir = isWin ? "C:\\" : "/";
        }
        if (serverWorkspace != null && !serverWorkspace.isEmpty()) {
            input.setHint(serverWorkspace);
        } else if (isWin) {
            input.setHint("D:\\workspace\\project");
        } else {
            input.setHint("/home/user/project");
        }
        input.setText(defaultDir);
        input.setSelection(defaultDir.length());
        root.addView(input);

        // --- Recent directories ---
        List<String> recentDirs = PreferencesHelper.getRecentDirectories();
        if (!recentDirs.isEmpty()) {
            TextView recentLabel = new TextView(this);
            recentLabel.setText("Recent:");
            recentLabel.setTextColor(0xFF8B949E);
            recentLabel.setTextSize(12);
            recentLabel.setPadding(0, (int)(12 * getResources().getDisplayMetrics().density), 0, 4);
            root.addView(recentLabel);
            root.addView(buildChipRow(recentDirs, input, 0xFFFFD43B));
        }

        // --- Quick paths from server ---
        if (serverCommonPaths.length > 0) {
            TextView quickLabel = new TextView(this);
            quickLabel.setText("Quick paths:");
            quickLabel.setTextColor(0xFF8B949E);
            quickLabel.setTextSize(12);
            quickLabel.setPadding(0, (int)(8 * getResources().getDisplayMetrics().density), 0, 4);
            root.addView(quickLabel);

            List<String> paths = new ArrayList<>();
            for (String p : serverCommonPaths) paths.add(p);
            root.addView(buildChipRow(paths, input, 0xFF74C0FC));
        }

        // --- Row 3: Browse button ---
        LinearLayout browseRow = new LinearLayout(this);
        browseRow.setOrientation(LinearLayout.HORIZONTAL);
        browseRow.setPadding(0, (int)(8 * getResources().getDisplayMetrics().density), 0, 0);

        TextView browseBtn = new TextView(this);
        browseBtn.setText("📁 Browse...");
        browseBtn.setTextColor(0xFF51CF66);
        browseBtn.setTextSize(14);
        browseBtn.setPadding(0, padV, padH, padV);
        browseBtn.setOnClickListener(v -> showDirectoryBrowser(input));
        browseRow.addView(browseBtn);

        // OS indicator
        if (serverOs != null) {
            TextView osLabel = new TextView(this);
            osLabel.setText("Server: " + serverOs);
            osLabel.setTextColor(0xFF888888);
            osLabel.setTextSize(12);
            osLabel.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
            osLabel.setLayoutParams(new LinearLayout.LayoutParams(
                    0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            browseRow.addView(osLabel);
        }

        root.addView(browseRow);

        // --- Show dialog ---
        // Custom title view with white text
        TextView titleView = new TextView(this);
        titleView.setText("Start Claude Code");
        titleView.setTextColor(0xFFFFFFFF);
        titleView.setTextSize(18);
        titleView.setPadding(padH * 2, padV * 3, padH * 2, padV);
        titleView.setTypeface(null, android.graphics.Typeface.BOLD);
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setCustomTitle(titleView)
                .setView(root)
                .setPositiveButton("Start", (d, which) -> {
                    String directory = input.getText().toString().trim();
                    if (directory.isEmpty()) {
                        Toast.makeText(MainActivity.this, "Please enter a directory path", Toast.LENGTH_SHORT).show();
                        return;
                    }
                    PreferencesHelper.setLastDirectory(directory);
                    PreferencesHelper.addRecentDirectory(directory);
                    wsManager.sendCreateSession(directory);
                    Toast.makeText(MainActivity.this, "Creating session...", Toast.LENGTH_SHORT).show();
                })
                .setNegativeButton("Cancel", null)
                .create();
        dialog.show();

        // Style dialog background
        if (dialog.getWindow() != null) {
            dialog.getWindow().setBackgroundDrawableResource(R.drawable.dialog_bg);
        }
        // Style the buttons
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setTextColor(0xFF51CF66);
        dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setTextColor(0xFF888888);
    }

    // ============================================================
    // Directory browser sub-dialog
    // ============================================================

    private AlertDialog browserDialog;
    private TextView browserPathText;
    private String browserCurrentPath = "/";
    private WebSocketManager.DirectoryListListener pendingDirListener; // track active listener

    private void showDirectoryBrowser(EditText targetInput) {
        // Remove any stale listener from a previous browse session
        if (pendingDirListener != null) {
            wsManager.removeDirectoryListListener(pendingDirListener);
            pendingDirListener = null;
        }

        // Use the input field path as the starting point
        String initPath = targetInput.getText().toString().trim();
        boolean isWin = wsManager.getServerOs() != null && wsManager.getServerOs().contains("win");
        if (!initPath.isEmpty()) {
            browserCurrentPath = initPath;
        } else if (serverWorkspace != null && !serverWorkspace.isEmpty()) {
            browserCurrentPath = serverWorkspace;
        } else {
            browserCurrentPath = isWin ? "C:\\" : "/";
        }

        int padH = (int) (14 * getResources().getDisplayMetrics().density);
        int padV = (int) (9 * getResources().getDisplayMetrics().density);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(0xFF161B22);

        // ---- Current path display ----
        LinearLayout headerRow = new LinearLayout(this);
        headerRow.setOrientation(LinearLayout.HORIZONTAL);
        headerRow.setPadding(0, 4, 0, 8);

        browserPathText = new TextView(this);
        browserPathText.setText(browserCurrentPath);
        browserPathText.setTextColor(0xFF74C0FC);
        browserPathText.setTextSize(12);
        browserPathText.setPadding(padH, 6, padH, 6);
        headerRow.addView(browserPathText);
        root.addView(headerRow);

        // ---- Separator ----
        View sep = new View(this);
        sep.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1));
        sep.setBackgroundColor(0x33FFFFFF);
        root.addView(sep);

        // ---- Directory list (ScrollView of LinearLayout) ----
        ScrollView scroll = new ScrollView(this);
        scroll.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, (int)(250 * getResources().getDisplayMetrics().density)));

        final LinearLayout dirContainer = new LinearLayout(this);
        dirContainer.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(dirContainer);
        root.addView(scroll);

        // ---- Drive row (Windows) ----
        if (isWin) {
            View sepD = new View(this);
            sepD.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1));
            sepD.setBackgroundColor(0x33FFFFFF);
            root.addView(sepD);

            LinearLayout drivesRow = new LinearLayout(this);
            drivesRow.setOrientation(LinearLayout.HORIZONTAL);
            drivesRow.setPadding(14, 6, 14, 2);
            TextView dl = new TextView(this);
            dl.setText("Drives: ");
            dl.setTextColor(0xFF888888);
            dl.setTextSize(12);
            dl.setPadding(0, 4, 6, 0);
            drivesRow.addView(dl);
            for (char d = 'C'; d <= 'F'; d++) {
                final String dp = d + ":\\";
                TextView dc = new TextView(this);
                dc.setText(d + ":");
                dc.setTextColor(0xFF74C0FC);
                dc.setTextSize(12);
                dc.setBackgroundResource(R.drawable.input_bg);
                dc.setPadding(8, 4, 8, 4);
                LinearLayout.LayoutParams lpd = new LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                lpd.setMargins(0, 0, 8, 0);
                dc.setLayoutParams(lpd);
                dc.setOnClickListener(v -> wsManager.sendListDirectory(dp));
                drivesRow.addView(dc);
            }
            root.addView(drivesRow);
        }

        // Build a fresh directory list listener
        final WebSocketManager.DirectoryListListener dirListListener = (path, parent, entries) -> {
            runOnUiThread(() -> {
                browserCurrentPath = path;
                browserPathText.setText(path);
                dirContainer.removeAllViews();

                // ".." row — server returns null parent when at boundary
                if (parent != null) {
                    dirContainer.addView(buildDirRow("📁 .. (up)", parent, targetInput, true, true));
                }
                // Directory rows
                String sepStr = serverPathSeparator != null ? serverPathSeparator : "/";
                for (DirectoryEntry e : entries) {
                    if (!"directory".equals(e.type)) continue;
                    String childPath = path + (path.endsWith(sepStr) ? "" : sepStr) + e.name;
                    dirContainer.addView(buildDirRow("📁 " + e.name, childPath, targetInput, false, false));
                }
            });
        };
        wsManager.addDirectoryListListener(dirListListener);
        pendingDirListener = dirListListener;
        final WebSocketManager.DirectoryListListener ref = dirListListener;

        // Custom title with white text
        TextView browserTitleView = new TextView(this);
        browserTitleView.setText("Browse Directory");
        browserTitleView.setTextColor(0xFFFFFFFF);
        browserTitleView.setTextSize(18);
        int bph = (int) (14 * getResources().getDisplayMetrics().density);
        int bpv = (int) (9 * getResources().getDisplayMetrics().density);
        browserTitleView.setPadding(bph * 2, bpv * 3, bph * 2, bpv);
        browserTitleView.setTypeface(null, android.graphics.Typeface.BOLD);

        browserDialog = new AlertDialog.Builder(this)
                .setCustomTitle(browserTitleView)
                .setView(root)
                .setPositiveButton("Select current", (d, which) -> {
                    targetInput.setText(browserCurrentPath);
                    targetInput.setSelection(browserCurrentPath.length());
                    wsManager.removeDirectoryListListener(ref);
                    pendingDirListener = null;
                })
                .setNegativeButton("Cancel", (d, which) -> {
                    wsManager.removeDirectoryListListener(ref);
                    pendingDirListener = null;
                })
                .setOnDismissListener(d -> {
                    wsManager.removeDirectoryListListener(ref);
                    pendingDirListener = null;
                })
                .create();
        browserDialog.show();
        if (browserDialog.getWindow() != null) {
            browserDialog.getWindow().setBackgroundDrawableResource(R.drawable.dialog_bg);
        }
        browserDialog.getButton(AlertDialog.BUTTON_POSITIVE).setTextColor(0xFF51CF66);
        browserDialog.getButton(AlertDialog.BUTTON_NEGATIVE).setTextColor(0xFF888888);

        // Send the path to list its subdirectories
        wsManager.sendListDirectory(browserCurrentPath);
    }

    /**
     * Build one directory row: name + optional "Navigate" button.
     * Clicking name = select; clicking ">" = navigate into.
     */
    private LinearLayout buildDirRow(String label, String path, EditText targetInput, boolean isUp, boolean isUpRow) {
        int ph = (int) (12 * getResources().getDisplayMetrics().density);
        int pv = (int) (8 * getResources().getDisplayMetrics().density);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(0, 2, 0, 2);

        // Name — click = select (or navigate up for "..")
        TextView nameView = new TextView(this);
        nameView.setText(label);
        nameView.setTextColor(isUpRow ? 0xFFFFD43B : 0xFFE0E0E0);
        nameView.setTextSize(14);
        nameView.setPadding(ph, pv, 0, pv);
        LinearLayout.LayoutParams nameLp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        nameView.setLayoutParams(nameLp);
        nameView.setOnClickListener(v -> {
            if (isUp) {
                navigateUp();
                return;
            }
            targetInput.setText(path);
            targetInput.setSelection(path.length());
            WebSocketManager m = WebSocketManager.getInstance();
            // Remove our listener
            if (browserDialog != null) browserDialog.dismiss();
        });
        row.addView(nameView);

        if (!isUpRow) {
            // ">" navigate button
            TextView navBtn = new TextView(this);
            navBtn.setText(" >");
            navBtn.setTextColor(0xFF74C0FC);
            navBtn.setTextSize(16);
            navBtn.setGravity(Gravity.CENTER);
            navBtn.setBackgroundResource(R.drawable.input_bg);
            int btnW = (int) (40 * getResources().getDisplayMetrics().density);
            int btnH = (int) (32 * getResources().getDisplayMetrics().density);
            LinearLayout.LayoutParams btnLp = new LinearLayout.LayoutParams(btnW, btnH);
            btnLp.gravity = Gravity.CENTER_VERTICAL;
            btnLp.setMargins(ph, 0, ph, 0);
            navBtn.setLayoutParams(btnLp);
            navBtn.setOnClickListener(v -> {
                wsManager.sendListDirectory(path);
            });
            row.addView(navBtn);
        }

        return row;
    }

    /** Build a horizontal scrollable row of clickable path chips. */
    private HorizontalScrollView buildChipRow(List<String> paths, EditText targetInput, int color) {
        HorizontalScrollView hscroll = new HorizontalScrollView(this);
        hscroll.setHorizontalScrollBarEnabled(false);
        hscroll.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        hscroll.setBackgroundColor(0x0D000000); // subtle dark tint

        LinearLayout container = new LinearLayout(this);
        container.setOrientation(LinearLayout.HORIZONTAL);
        container.setPadding(0, 4, 0, 4);

        int padChip = (int) (8 * getResources().getDisplayMetrics().density);
        for (String p : paths) {
            TextView chip = new TextView(this);
            // Truncate display text
            String label = p.length() > 30 ? "…" + p.substring(p.length() - 29) : p;
            chip.setText(label);
            chip.setTextColor(color);
            chip.setTextSize(11);
            chip.setSingleLine(true);
            chip.setBackgroundResource(R.drawable.input_bg);
            chip.setPadding(padChip, 4, padChip, 4);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.setMargins(0, 0, 6, 0);
            chip.setLayoutParams(lp);
            chip.setOnClickListener(v -> {
                targetInput.setText(p);
                targetInput.setSelection(p.length());
            });
            container.addView(chip);
        }
        hscroll.addView(container);
        return hscroll;
    }

    // Navigate up from the current browser path
    private void navigateUp() {
        String current = browserCurrentPath;
        String sep = serverPathSeparator != null ? serverPathSeparator : "/";
        boolean isWin = wsManager.getServerOs() != null && wsManager.getServerOs().contains("win");

        // Normalize to forward slashes for calculation
        String norm = current.replace('\\', '/');
        if (norm.endsWith("/") && norm.length() > 1) norm = norm.substring(0, norm.length() - 1);

        int lastSep = norm.lastIndexOf('/');
        if (lastSep < 0) return;

        String upPath = norm.substring(0, lastSep);
        if (upPath.isEmpty()) {
            upPath = "/";
        }
        if (isWin && upPath.length() == 2 && upPath.charAt(1) == ':') {
            upPath += "/";
        }
        if (isWin && upPath.equals(norm)) return; // Already at drive root

        // Ensure correct separator for the server's platform
        if (isWin) upPath = upPath.replace('/', '\\');

        wsManager.sendListDirectory(upPath);
    }

    // ============================================================
    // Menu & Settings
    // ============================================================

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        getMenuInflater().inflate(R.menu.main_menu, menu);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == R.id.action_about) {
            showAboutDialog();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    private void showAboutDialog() {
        String version;
        try {
            version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (PackageManager.NameNotFoundException e) {
            version = "?";
        }
        String message = "CC Remote\n\n"
                + "Version: " + version + "\n\n"
                + "Author: romp\n"
                + "Email: srpol@outlook.com\n\n"
                + "Remote Claude Code via Android.\n"
                + "Code from your couch.";

        new AlertDialog.Builder(this)
                .setTitle("About")
                .setMessage(message)
                .setPositiveButton("OK", null)
                .create()
                .show();
    }

    // ============================================================
    // Profile management dialog
    // ============================================================

    private void showProfileDialog() {
        if (!wsManager.isConnected()) {
            Toast.makeText(this, "Not connected to server", Toast.LENGTH_SHORT).show();
            return;
        }

        final int padH = (int) (12 * getResources().getDisplayMetrics().density);
        final int padV = (int) (8 * getResources().getDisplayMetrics().density);

        // Separate profiles by source
        List<ProfileInfo> ccProfiles = new ArrayList<>();
        List<ProfileInfo> localProfiles = new ArrayList<>();
        for (ProfileInfo p : cachedProfiles) {
            if (p.isCCSwitch()) ccProfiles.add(p);
            else localProfiles.add(p);
        }

        // Build profile list — each item is a selectable row stored in a flat list
        // alongside its view so we can update the radio dot.
        LinearLayout listRoot = new LinearLayout(this);
        listRoot.setOrientation(LinearLayout.VERTICAL);
        listRoot.setPadding(0, 0, 0, padV);

        final java.util.List<View> itemViews = new ArrayList<>();
        final int[] selectedIdx = { -1 };

        // — CC Switch section —
        if (!ccProfiles.isEmpty()) {
            listRoot.addView(sectionHeader("⚡ CC Switch", padH, padV));
            for (ProfileInfo p : ccProfiles) {
                View item = profileItem(p, padH, padV, true, selectedIdx, itemViews, cachedActiveId);
                itemViews.add(item);
                listRoot.addView(item);
            }
        }

        // — Local section —
        listRoot.addView(sectionHeader("📁 Local", padH, padV));
        for (ProfileInfo p : localProfiles) {
            View item = profileItem(p, padH, padV, true, selectedIdx, itemViews, cachedActiveId);
            itemViews.add(item);
            listRoot.addView(item);
        }

        // Set initial selection to the currently-active profile
        for (int i = 0; i < cachedProfiles.size(); i++) {
            if (cachedProfiles.get(i).id.equals(cachedActiveId)) {
                selectedIdx[0] = i;
                updateRadioDot(itemViews.get(i), true);
                break;
            }
        }

        // Wrap in ScrollView so long lists don't overflow
        ScrollView scrollView = new ScrollView(this);
        scrollView.addView(listRoot);

        // Bottom bar — Switch + contextual actions
        LinearLayout btnRow = new LinearLayout(this);
        btnRow.setOrientation(LinearLayout.HORIZONTAL);
        btnRow.setPadding(0, padV, 0, 0);

        // Switch button (always present)
        TextView switchBtn = dialogButton("Switch", 0xFF51CF66, padH, padV);
        switchBtn.setOnClickListener(v -> {
            if (selectedIdx[0] < 0 || selectedIdx[0] >= cachedProfiles.size()) {
                Toast.makeText(this, "Select a profile first", Toast.LENGTH_SHORT).show();
                return;
            }
            ProfileInfo sel = cachedProfiles.get(selectedIdx[0]);
            new AlertDialog.Builder(this)
                    .setTitle("Switch Profile")
                    .setMessage("Switch to \"" + sel.name + "\"? Any running sessions will be "
                            + "restarted to pick up the new provider/model.")
                    .setPositiveButton("Switch", (d, w) -> {
                        wsManager.sendSwitchProfile(sel.id, sel.source);
                        wsManager.sendListProfiles();
                        Toast.makeText(this, "Switching to " + sel.name + " · restarting sessions…", Toast.LENGTH_SHORT).show();
                        if (profileDialog != null) profileDialog.dismiss();
                    })
                    .setNegativeButton("Cancel", null).create().show();
        });
        btnRow.addView(switchBtn);

        // New profile button (for local section)
        TextView newBtn = dialogButton("+ New", 0xFF74C0FC, padH, padV);
        newBtn.setOnClickListener(v -> {
            if (profileDialog != null) profileDialog.dismiss();
            showCreateProfileDialog();
        });
        btnRow.addView(newBtn);

        // Only show rename/delete for native profiles
        TextView renameBtn = dialogButton("Rename", 0xFFFFD43B, padH, padV);
        renameBtn.setOnClickListener(v -> {
            if (selectedIdx[0] < 0 || selectedIdx[0] >= cachedProfiles.size()) {
                Toast.makeText(this, "Select a profile first", Toast.LENGTH_SHORT).show();
                return;
            }
            ProfileInfo sel = cachedProfiles.get(selectedIdx[0]);
            if (sel.isCCSwitch()) {
                Toast.makeText(this, "CC Switch profiles cannot be renamed here", Toast.LENGTH_SHORT).show();
                return;
            }
            if (profileDialog != null) profileDialog.dismiss();
            showRenameProfileDialog(sel);
        });
        btnRow.addView(renameBtn);

        TextView deleteBtn = dialogButton("Delete", 0xFFFF6B6B, padH, padV);
        deleteBtn.setOnClickListener(v -> {
            if (selectedIdx[0] < 0 || selectedIdx[0] >= cachedProfiles.size()) {
                Toast.makeText(this, "Select a profile first", Toast.LENGTH_SHORT).show();
                return;
            }
            ProfileInfo sel = cachedProfiles.get(selectedIdx[0]);
            if (sel.isCCSwitch()) {
                Toast.makeText(this, "CC Switch profiles cannot be deleted here", Toast.LENGTH_SHORT).show();
                return;
            }
            if (profileDialog != null) profileDialog.dismiss();
            confirmDeleteProfile(sel);
        });
        btnRow.addView(deleteBtn);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(padH, padV, padH, padV);
        root.setBackgroundColor(0xFF161B22);
        root.addView(scrollView);
        root.addView(btnRow);

        // Title
        TextView titleView = new TextView(this);
        titleView.setText("Profiles");
        titleView.setTextColor(0xFFFFFFFF);
        titleView.setTextSize(18);
        titleView.setPadding(padH * 2, padV * 2, padH * 2, padV);
        titleView.setTypeface(null, android.graphics.Typeface.BOLD);

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setCustomTitle(titleView)
                .setView(root)
                .setNegativeButton("Close", null)
                .create();
        profileDialog = dialog;
        dialog.setOnDismissListener(d -> { if (profileDialog == dialog) profileDialog = null; });
        dialog.show();
        if (dialog.getWindow() != null) {
            dialog.getWindow().setBackgroundDrawableResource(R.drawable.dialog_bg);
        }
        dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setTextColor(0xFF888888);
    }

    /** Section header label for the profile list. */
    private TextView sectionHeader(String text, int padH, int padV) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextColor(0xFF8B949E);
        tv.setTextSize(11);
        tv.setPadding(padH, padV * 2, padH, padV / 2);
        tv.setTypeface(null, android.graphics.Typeface.BOLD);
        return tv;
    }

    /** Build a single selectable profile row. */
    private View profileItem(ProfileInfo p, int padH, int padV, boolean showModel,
                              final int[] selectedIdx, List<View> itemViews, String activeId) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(padH, padV, padH, padV);
        row.setBackgroundColor(0xFF0D1117);
        // Rounded corners via drawable
        row.setBackgroundResource(R.drawable.input_bg);

        // Radio dot
        TextView dot = new TextView(this);
        dot.setText("○");
        dot.setTextColor(0xFF8B949E);
        dot.setTextSize(16);
        dot.setPadding(0, 0, padH, 0);
        row.addView(dot);

        // Profile name + model
        LinearLayout textCol = new LinearLayout(this);
        textCol.setOrientation(LinearLayout.VERTICAL);

        TextView nameView = new TextView(this);
        nameView.setText(p.name);
        nameView.setTextColor(0xFFE0E0E0);
        nameView.setTextSize(14);
        textCol.addView(nameView);

        if (showModel && p.model != null && !p.model.isEmpty()) {
            TextView modelView = new TextView(this);
            modelView.setText(p.model);
            modelView.setTextColor(0xFF8B949E);
            modelView.setTextSize(11);
            modelView.setPadding(0, 2, 0, 0);
            textCol.addView(modelView);
        }
        row.addView(textCol);

        // Spacer
        View spacer = new View(this);
        spacer.setLayoutParams(new LinearLayout.LayoutParams(0, 1, 1f));
        row.addView(spacer);

        // Checkmark if active
        if (p.id.equals(activeId)) {
            TextView check = new TextView(this);
            check.setText("✓");
            check.setTextColor(0xFF51CF66);
            check.setTextSize(14);
            row.addView(check);
        }

        // Click → select
        int myIdx = itemViews.size(); // index in the flat list
        row.setOnClickListener(v -> {
            // Deselect old
            if (selectedIdx[0] >= 0 && selectedIdx[0] < itemViews.size()) {
                updateRadioDot(itemViews.get(selectedIdx[0]), false);
            }
            // Select new
            selectedIdx[0] = myIdx;
            updateRadioDot(row, true);
        });

        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(0, 0, 0, 4);
        row.setLayoutParams(lp);

        return row;
    }

    private void updateRadioDot(View itemView, boolean selected) {
        if (itemView instanceof LinearLayout) {
            LinearLayout row = (LinearLayout) itemView;
            if (row.getChildCount() > 0 && row.getChildAt(0) instanceof TextView) {
                TextView dot = (TextView) row.getChildAt(0);
                dot.setText(selected ? "●" : "○");
                dot.setTextColor(selected ? 0xFF51CF66 : 0xFF8B949E);
            }
        }
    }

    private TextView dialogButton(String text, int color, int padH, int padV) {
        TextView btn = new TextView(this);
        btn.setText(text);
        btn.setTextColor(color);
        btn.setTextSize(13);
        btn.setGravity(Gravity.CENTER);
        btn.setBackgroundResource(R.drawable.input_bg);
        btn.setPadding(padH, padV / 2, padH, padV / 2);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        lp.setMargins(2, 0, 2, 0);
        btn.setLayoutParams(lp);
        return btn;
    }

    private void showCreateProfileDialog() {
        final int padH = (int) (12 * getResources().getDisplayMetrics().density);
        final int padV = (int) (8 * getResources().getDisplayMetrics().density);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(padH, padV, padH, padV);
        root.setBackgroundColor(0xFF161B22);

        // Name field
        TextView nameLabel = new TextView(this);
        nameLabel.setText("Profile name:");
        nameLabel.setTextColor(0xFFBBBBBB);
        nameLabel.setTextSize(13);
        root.addView(nameLabel);

        final EditText nameInput = new EditText(this);
        nameInput.setTextColor(0xFFE0E0E0);
        nameInput.setHintTextColor(0xFF888888);
        nameInput.setHint("My Profile");
        nameInput.setBackgroundResource(R.drawable.input_bg);
        nameInput.setSingleLine(true);
        nameInput.setPadding(padH + 4, padV + 2, padH + 4, padV + 2);
        root.addView(nameInput);

        // Content field (settings.json JSON)
        TextView contentLabel = new TextView(this);
        contentLabel.setText("Content (settings.json JSON):");
        contentLabel.setTextColor(0xFFBBBBBB);
        contentLabel.setTextSize(13);
        contentLabel.setPadding(0, padV, 0, 0);
        root.addView(contentLabel);

        final EditText contentInput = new EditText(this);
        contentInput.setTextColor(0xFFE0E0E0);
        contentInput.setHintTextColor(0xFF888888);
        contentInput.setHint("{\n  \"model\": \"claude-sonnet-4-6\",\n  \"thinkingBudget\": 8000\n}");
        contentInput.setBackgroundResource(R.drawable.input_bg);
        contentInput.setMinLines(6);
        contentInput.setMaxLines(12);
        contentInput.setGravity(Gravity.TOP | Gravity.START);
        contentInput.setPadding(padH + 4, padV + 2, padH + 4, padV + 2);
        root.addView(contentInput);

        TextView titleView = new TextView(this);
        titleView.setText("Create Profile");
        titleView.setTextColor(0xFFFFFFFF);
        titleView.setTextSize(18);
        titleView.setPadding(padH * 2, padV * 2, padH * 2, padV);
        titleView.setTypeface(null, android.graphics.Typeface.BOLD);

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setCustomTitle(titleView)
                .setView(root)
                .setPositiveButton("Create", (d, which) -> {
                    String name = nameInput.getText().toString().trim();
                    if (name.isEmpty()) {
                        Toast.makeText(MainActivity.this, "Profile name is required", Toast.LENGTH_SHORT).show();
                        return;
                    }
                    String contentStr = contentInput.getText().toString().trim();
                    JsonObject content;
                    if (contentStr.isEmpty()) {
                        content = new JsonObject();
                    } else {
                        try {
                            content = JsonParser.parseString(contentStr).getAsJsonObject();
                        } catch (Exception e) {
                            Toast.makeText(MainActivity.this, "Invalid JSON: " + e.getMessage(), Toast.LENGTH_LONG).show();
                            return;
                        }
                    }
                    wsManager.sendCreateProfile(name, content);
                    wsManager.sendListProfiles(); // Refresh on next response
                })
                .setNegativeButton("Cancel", null)
                .create();
        dialog.show();
        if (dialog.getWindow() != null) {
            dialog.getWindow().setBackgroundDrawableResource(R.drawable.dialog_bg);
        }
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setTextColor(0xFF51CF66);
        dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setTextColor(0xFF888888);
    }

    private void showRenameProfileDialog(ProfileInfo profile) {
        final int padH = (int) (12 * getResources().getDisplayMetrics().density);
        final int padV = (int) (8 * getResources().getDisplayMetrics().density);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(padH, padV, padH, padV);
        root.setBackgroundColor(0xFF161B22);

        TextView label = new TextView(this);
        label.setText("New name:");
        label.setTextColor(0xFFBBBBBB);
        label.setTextSize(13);
        root.addView(label);

        final EditText input = new EditText(this);
        input.setTextColor(0xFFE0E0E0);
        input.setBackgroundResource(R.drawable.input_bg);
        input.setSingleLine(true);
        input.setText(profile.name);
        input.setSelection(profile.name.length());
        input.setPadding(padH + 4, padV + 2, padH + 4, padV + 2);
        root.addView(input);

        TextView titleView = new TextView(this);
        titleView.setText("Rename Profile");
        titleView.setTextColor(0xFFFFFFFF);
        titleView.setTextSize(18);
        titleView.setPadding(padH * 2, padV * 2, padH * 2, padV);
        titleView.setTypeface(null, android.graphics.Typeface.BOLD);

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setCustomTitle(titleView)
                .setView(root)
                .setPositiveButton("Rename", (d, which) -> {
                    String newName = input.getText().toString().trim();
                    if (newName.isEmpty()) {
                        Toast.makeText(MainActivity.this, "Name cannot be empty", Toast.LENGTH_SHORT).show();
                        return;
                    }
                    wsManager.sendUpdateProfile(profile.id, newName, null);
                    wsManager.sendListProfiles();
                })
                .setNegativeButton("Cancel", null)
                .create();
        dialog.show();
        if (dialog.getWindow() != null) {
            dialog.getWindow().setBackgroundDrawableResource(R.drawable.dialog_bg);
        }
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setTextColor(0xFFFFD43B);
        dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setTextColor(0xFF888888);
    }

    private void confirmDeleteProfile(ProfileInfo profile) {
        new AlertDialog.Builder(this)
                .setTitle("Delete Profile")
                .setMessage("Delete \"" + profile.name + "\"?")
                .setPositiveButton("Delete", (d, which) -> {
                    wsManager.sendDeleteProfile(profile.id);
                    wsManager.sendListProfiles();
                })
                .setNegativeButton("Cancel", null)
                .create()
                .show();
    }

    private void openSettings() {
        Intent intent = new Intent(this, SettingsActivity.class);
        startActivity(intent);
    }
}
