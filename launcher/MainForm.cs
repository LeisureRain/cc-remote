using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace CCRemoteLauncher
{
    /// <summary>
    /// Single-window launcher: start/stop/restart the Node server process and stream
    /// its stdout/stderr into a live log view. Also shows a read-only session list
    /// (polled from the server's /health endpoint) so you can see active sessions and
    /// client connections at a glance — mirroring the Android session list. There are
    /// still no session-level *controls* here (create/stop/delete live in the Android app).
    /// </summary>
    internal sealed class MainForm : Form
    {
        private const int MaxLogLines = 2000;

        private readonly TextBox _log;
        private readonly ListView _sessions;
        private readonly SplitContainer _split;
        private readonly System.Windows.Forms.Timer _pollTimer;
        private readonly Button _btnStart;
        private readonly Button _btnStop;
        private readonly Button _btnRestart;
        private readonly Button _btnClear;
        private readonly Button _btnOpenDir;
        private readonly Button _btnSettings;
        private readonly Button _btnAbout;
        private readonly Label _status;

        private Process _proc;
        private string _serverDir;
        private int _port = 11199;
        private bool _closing;
        private volatile bool _fetching;   // guards overlapping /health polls
        private int _uiSessionCount;       // last rendered session count (for status line)
        private int _uiClientCount;        // last rendered total client count
        private bool _uiPollOk;            // whether the last /health poll succeeded

        private NotifyIcon _trayIcon;
        private ContextMenuStrip _trayMenu;

        public MainForm()
        {
            string version = Assembly.GetExecutingAssembly().GetName().Version is Version v
                ? $"{v.Major}.{v.Minor}.{v.Build}"
                : "?";

            Text = $"CC Remote Launcher  v{version}";
            TryLoadIcon();
            Width = 820;
            Height = 540;
            MinimumSize = new Size(560, 360);
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Segoe UI", 9f);

            // --- top button bar ---
            var bar = new FlowLayoutPanel
            {
                Dock = DockStyle.Top,
                Height = 44,
                Padding = new Padding(8, 8, 8, 4),
                FlowDirection = FlowDirection.LeftToRight,
                WrapContents = false,
            };
            _btnStart = MakeButton("Start", (s, e) => StartServer());
            _btnStop = MakeButton("Stop", (s, e) => StopServer(restart: false));
            _btnRestart = MakeButton("Restart", (s, e) => RestartServer());
            _btnSettings = MakeButton("Settings", (s, e) => OnSettings());
            _btnClear = MakeButton("Clear Log", (s, e) => _log.Clear());
            _btnOpenDir = MakeButton("Open Server Folder", (s, e) => OpenServerDir());
            _btnAbout = MakeButton("About", (s, e) => OnAbout());
            bar.Controls.AddRange(new Control[] { _btnStart, _btnStop, _btnRestart, _btnSettings, _btnClear, _btnOpenDir, _btnAbout });

            // --- status line ---
            _status = new Label
            {
                Dock = DockStyle.Bottom,
                Height = 24,
                TextAlign = ContentAlignment.MiddleLeft,
                Padding = new Padding(10, 0, 0, 0),
                BackColor = Color.FromArgb(30, 30, 46),
                ForeColor = Color.Gainsboro,
            };

            // --- log view ---
            _log = new TextBox
            {
                Dock = DockStyle.Fill,
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Both,
                WordWrap = false,
                BackColor = Color.FromArgb(13, 17, 23),
                ForeColor = Color.FromArgb(201, 209, 217),
                Font = new Font("Consolas", 9.5f),
                BorderStyle = BorderStyle.None,
            };

            // --- session list (read-only, polled from /health) ---
            var sessHeader = new Label
            {
                Dock = DockStyle.Top,
                Height = 22,
                Text = "  Sessions (auto-refresh every 3s; manage sessions in the Android app)",
                TextAlign = ContentAlignment.MiddleLeft,
                BackColor = Color.FromArgb(22, 27, 34),
                ForeColor = Color.Gainsboro,
            };
            _sessions = new ListView
            {
                Dock = DockStyle.Fill,
                View = View.Details,
                FullRowSelect = true,
                MultiSelect = false,
                HideSelection = true,
                ShowItemToolTips = true,
                BackColor = Color.FromArgb(13, 17, 23),
                ForeColor = Color.FromArgb(201, 209, 217),
                BorderStyle = BorderStyle.None,
                Font = new Font("Segoe UI", 9f),
            };
            _sessions.Columns.Add("Session", 160);
            _sessions.Columns.Add("Status", 90);
            _sessions.Columns.Add("Clients", 60, HorizontalAlignment.Center);
            _sessions.Columns.Add("Messages", 55, HorizontalAlignment.Center);
            _sessions.Columns.Add("Created", 120);
            _sessions.Columns.Add("Directory", 320);
            // Last column (Directory) flexes to fill the panel so the table never needs a
            // horizontal scrollbar; recompute whenever the list is resized.
            _sessions.Resize += (s, e) => FitSessionColumns();

            // --- split: session list on top, log below ---
            _split = new SplitContainer
            {
                Dock = DockStyle.Fill,
                Orientation = Orientation.Horizontal,
                SplitterWidth = 6,
                BackColor = Color.FromArgb(30, 30, 46),
                Panel1MinSize = 80,
                Panel2MinSize = 120,
            };
            _split.Panel1.Controls.Add(_sessions);
            _split.Panel1.Controls.Add(sessHeader);
            _split.Panel2.Controls.Add(_log);

            Controls.Add(_split);
            Controls.Add(_status);
            Controls.Add(bar);

            // Poll the server's /health for the session list while it's running.
            _pollTimer = new System.Windows.Forms.Timer { Interval = 3000 };
            _pollTimer.Tick += (s, e) => PollSessions();

            Load += (s, e) => Initialize();
            FormClosing += OnFormClosing;
            Resize += OnFormResize;

            SetupTrayIcon();
        }

        private Button MakeButton(string text, EventHandler onClick)
        {
            var b = new Button
            {
                Text = text,
                AutoSize = true,
                Height = 30,
                Padding = new Padding(8, 2, 8, 2),
                Margin = new Padding(0, 0, 6, 0),
                FlatStyle = FlatStyle.System,
            };
            b.Click += onClick;
            return b;
        }

        private void TryLoadIcon()
        {
            try
            {
                using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("app.ico"))
                {
                    if (s != null) Icon = new Icon(s);
                }
            }
            catch
            {
                // non-fatal — default icon is fine
            }
        }

        private void Initialize()
        {
            _serverDir = ServerLocator.EnsureServerDir(AppendLine);
            if (_serverDir == null)
            {
                AppendLine("[Launcher] Server not found (no embedded bundle or local server/ directory).");
                UpdateState();
                return;
            }
            _port = ServerLocator.ReadPort(_serverDir);
            // Give the session list a sensible initial share of the window.
            try { _split.SplitterDistance = 170; } catch { /* tiny window — ignore */ }
            FitSessionColumns();
            UpdateState();
            _pollTimer.Start();
            StartServer(); // auto-start on launch
        }

        private bool IsRunning => _proc != null && !_proc.HasExited;

        private void StartServer()
        {
            if (IsRunning) return;
            if (_serverDir == null) { Initialize(); return; }

            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "node",
                    Arguments = "src/index.js",
                    WorkingDirectory = _serverDir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                };

                _proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
                _proc.OutputDataReceived += (s, e) => { if (e.Data != null) AppendLine(e.Data); };
                _proc.ErrorDataReceived += (s, e) => { if (e.Data != null) AppendLine(e.Data); };
                _proc.Exited += OnProcExited;

                AppendLine("[Launcher] Starting server …");
                _proc.Start();
                _proc.BeginOutputReadLine();
                _proc.BeginErrorReadLine();
            }
            catch (Exception ex)
            {
                AppendLine("[Launcher] Failed to start: " + ex.Message);
                AppendLine("[Launcher] Make sure Node.js is installed and 'node' is on PATH.");
                _proc = null;
            }
            UpdateState();
        }

        private void StopServer(bool restart)
        {
            if (!IsRunning)
            {
                _proc = null;
                UpdateState();
                if (restart) StartServer();
                return;
            }

            int pid = _proc.Id;
            AppendLine($"[Launcher] Stopping server (PID {pid}) …");

            // Detach so the Exited handler doesn't fight us, then kill the whole tree
            // (node spawns claude children). .NET Framework has no Kill(entireProcessTree),
            // so use taskkill /T /F.
            try { _proc.Exited -= OnProcExited; } catch { }
            KillTree(pid);
            try { if (!_proc.HasExited) _proc.Kill(); } catch { }
            _proc = null;

            UpdateState();
            PollSessions();   // clear the session list immediately on stop
            if (restart) StartServer();
        }

        private void RestartServer()
        {
            AppendLine("[Launcher] Restarting server …");
            StopServer(restart: true);
        }

        private static void KillTree(int pid)
        {
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "taskkill",
                    Arguments = $"/PID {pid} /T /F",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                };
                using (var p = Process.Start(psi))
                {
                    p.WaitForExit(5000);
                }
            }
            catch
            {
                // best effort
            }
        }

        private void OnProcExited(object sender, EventArgs e)
        {
            // Raised on a background thread — marshal to UI.
            if (_closing) return;
            BeginInvoke((Action)(() =>
            {
                int code = -1;
                try { code = _proc?.ExitCode ?? -1; } catch { }
                AppendLine($"[Launcher] Server exited (exit code {code}).");
                _proc = null;
                UpdateState();
                PollSessions();   // server gone — clear the session list now
            }));
        }

        private void UpdateState()
        {
            bool running = IsRunning;
            _btnStart.Enabled = !running && _serverDir != null;
            _btnStop.Enabled = running;
            _btnRestart.Enabled = running;
            _btnOpenDir.Enabled = _serverDir != null;
            _btnSettings.Enabled = _serverDir != null;

            if (running)
            {
                string counts = _uiPollOk
                    ? $"    Sessions {_uiSessionCount}    Clients {_uiClientCount}"
                    : "    (connecting…)";
                _status.Text = $"● Running    127.0.0.1:{_port}{counts}";
                _status.ForeColor = Color.FromArgb(81, 207, 102);
            }
            else
            {
                _status.Text = "○ Stopped";
                _status.ForeColor = Color.FromArgb(248, 81, 73);
            }
        }

        // ==========================================================
        // System tray (minimize-to-tray)
        // ==========================================================

        private void SetupTrayIcon()
        {
            _trayMenu = new ContextMenuStrip();
            _trayMenu.Items.Add("&Restore", null, (s, e) => RestoreFromTray());
            _trayMenu.Items.Add(new ToolStripSeparator());
            _trayMenu.Items.Add("E&xit", null, (s, e) => Close());

            _trayIcon = new NotifyIcon
            {
                Icon = Icon,   // reuse the form's icon loaded in TryLoadIcon
                Text = "CC Remote Launcher",
                ContextMenuStrip = _trayMenu,
                Visible = false,
            };
            _trayIcon.DoubleClick += (s, e) => RestoreFromTray();
        }

        private void OnFormResize(object sender, EventArgs e)
        {
            if (WindowState == FormWindowState.Minimized)
            {
                Hide();
                _trayIcon.Visible = true;
            }
        }

        private void RestoreFromTray()
        {
            _trayIcon.Visible = false;
            Show();
            WindowState = FormWindowState.Normal;
            BringToFront();
            Activate();
        }

        // ==========================================================
        // Session list — poll the server's /health and render (read-only)
        // ==========================================================

        /// <summary>
        /// Size the last column (Directory) to absorb the leftover width so the table fits
        /// the panel exactly and never shows a horizontal scrollbar. ClientSize.Width
        /// already excludes the vertical scrollbar when one is present.
        /// </summary>
        private void FitSessionColumns()
        {
            if (_sessions == null || _sessions.Columns.Count == 0) return;

            int fixedWidth = 0;
            for (int i = 0; i < _sessions.Columns.Count - 1; i++)
                fixedWidth += _sessions.Columns[i].Width;

            int last = _sessions.Columns.Count - 1;
            int avail = _sessions.ClientSize.Width - fixedWidth - 4; // 4px guard
            _sessions.Columns[last].Width = Math.Max(60, avail);
        }

        private void PollSessions()
        {
            if (!IsRunning)
            {
                // Server down — drop any stale rows and reset the status counters.
                if (_uiPollOk || _sessions.Items.Count > 0)
                {
                    _uiPollOk = false; _uiSessionCount = 0; _uiClientCount = 0;
                    _sessions.Items.Clear();
                    UpdateState();
                }
                return;
            }
            if (_fetching) return;   // don't pile up requests if one is slow
            _fetching = true;

            int port = _port;
            System.Threading.ThreadPool.QueueUserWorkItem(_ =>
            {
                List<SessionRow> rows = null;
                int clients = 0;
                bool ok = false;
                try
                {
                    string json = FetchHealth(port);
                    ParseHealth(json, out rows, out clients);
                    ok = true;
                }
                catch
                {
                    ok = false; // server starting up or not reachable yet
                }

                try
                {
                    BeginInvoke((Action)(() =>
                    {
                        _fetching = false;
                        RenderSessions(ok, rows, clients);
                    }));
                }
                catch
                {
                    _fetching = false; // form closing — nothing to render
                }
            });
        }

        private static string FetchHealth(int port)
        {
            var req = (HttpWebRequest)WebRequest.Create($"http://127.0.0.1:{port}/health");
            req.Method = "GET";
            req.Timeout = 2500;
            req.ReadWriteTimeout = 2500;
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
            {
                return sr.ReadToEnd();
            }
        }

        private static void ParseHealth(string json, out List<SessionRow> rows, out int clients)
        {
            rows = new List<SessionRow>();
            clients = 0;
            var ser = new JavaScriptSerializer();
            if (!(ser.DeserializeObject(json) is Dictionary<string, object> root)) return;
            if (root.TryGetValue("clients", out var c)) clients = ToInt(c);
            if (root.TryGetValue("sessions", out var s) && s is object[] arr)
            {
                foreach (var o in arr)
                {
                    if (!(o is Dictionary<string, object> m)) continue;
                    rows.Add(new SessionRow
                    {
                        Id = ToStr(m, "id"),
                        Directory = ToStr(m, "directory"),
                        Status = ToStr(m, "status"),
                        CreatedAt = ToStr(m, "createdAt"),
                        ClientCount = ToInt(m.TryGetValue("clientCount", out var cc) ? cc : 0),
                        BufferSize = ToInt(m.TryGetValue("bufferSize", out var bs) ? bs : 0),
                        ExitCode = m.TryGetValue("exitCode", out var ec) && ec != null ? ToInt(ec) : (int?)null,
                    });
                }
            }
        }

        private void RenderSessions(bool ok, List<SessionRow> rows, int clients)
        {
            _uiPollOk = ok;
            _uiSessionCount = (ok && rows != null) ? rows.Count : 0;
            // Prefer the server's top-level live-connection count, but fall back to the
            // sum of per-session watchers so the figure is never stuck at 0 against an
            // older server that doesn't emit the top-level `clients` field.
            int sessionClients = (ok && rows != null) ? rows.Sum(r => r.ClientCount) : 0;
            _uiClientCount = ok ? Math.Max(clients, sessionClients) : 0;

            _sessions.BeginUpdate();
            try
            {
                _sessions.Items.Clear();
                if (ok && rows != null)
                {
                    foreach (var r in rows)
                    {
                        var it = new ListViewItem(r.DisplayName());
                        it.SubItems.Add(r.DisplayStatus());
                        it.SubItems.Add(r.ClientCount.ToString());
                        it.SubItems.Add(r.BufferSize.ToString());
                        it.SubItems.Add(r.DisplayCreated());
                        it.SubItems.Add(r.Directory ?? "");
                        it.ForeColor =
                            r.Status == "running" ? Color.FromArgb(81, 207, 102) :
                            r.Status == "stopped" ? Color.FromArgb(240, 200, 80) :
                                                    Color.FromArgb(150, 150, 150);
                        it.ToolTipText = "Session ID: " + r.Id;
                        _sessions.Items.Add(it);
                    }
                }
            }
            finally
            {
                _sessions.EndUpdate();
            }

            UpdateState();
        }

        private static string ToStr(Dictionary<string, object> m, string key)
            => (m.TryGetValue(key, out var v) && v != null) ? v.ToString() : "";

        private static int ToInt(object v)
        {
            try { return v == null ? 0 : Convert.ToInt32(v); }
            catch { return 0; }
        }

        /// <summary>One row of the session list, mirroring the Android SessionInfo.</summary>
        private sealed class SessionRow
        {
            public string Id;
            public string Directory;
            public string Status;     // "running" | "stopped" | "exited"
            public string CreatedAt;  // ISO 8601
            public int ClientCount;
            public int BufferSize;
            public int? ExitCode;

            public string DisplayName()
            {
                string dir = Directory ?? "/";
                dir = dir.TrimEnd('/', '\\');
                int sep = Math.Max(dir.LastIndexOf('/'), dir.LastIndexOf('\\'));
                return (sep >= 0 && sep < dir.Length - 1) ? dir.Substring(sep + 1) : dir;
            }

            public string DisplayStatus()
            {
                switch (Status)
                {
                    case "running": return "● Running";
                    case "stopped": return "⏸ Paused";
                    default: return "✕ Exited (" + (ExitCode?.ToString() ?? "?") + ")";
                }
            }

            public string DisplayCreated()
            {
                if (DateTime.TryParse(CreatedAt, out var dt))
                    return dt.ToLocalTime().ToString("MM-dd HH:mm");
                return CreatedAt ?? "";
            }
        }

        private void OpenServerDir()
        {
            if (_serverDir == null) return;
            try { Process.Start("explorer.exe", _serverDir); }
            catch (Exception ex) { AppendLine("[Launcher] Failed to open folder: " + ex.Message); }
        }

        private void OnAbout()
        {
            string version = Assembly.GetExecutingAssembly().GetName().Version is Version v
                ? $"{v.Major}.{v.Minor}.{v.Build}"
                : "?";
            string text = string.Join(Environment.NewLine,
                $"CC Remote Launcher v{version}",
                "",
                "Remote Claude Code — control your desktop AI coding assistant from your phone.",
                "",
                "Author:  romp",
                "Email:   srpol@outlook.com",
                "",
                "GitHub: https://github.com/LeisureRain/cc-remote");
            MessageBox.Show(this, text, "About CC Remote", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        private void OnSettings()
        {
            if (_serverDir == null) return;

            int curPort = ServerLocator.ReadPort(_serverDir);
            string curWs = ServerLocator.ReadWorkspace(_serverDir);

            using (var dlg = new SettingsForm(curPort, curWs))
            {
                if (dlg.ShowDialog(this) != DialogResult.OK) return;
                if (dlg.Port == curPort && dlg.Workspace == curWs) return;

                try
                {
                    ServerLocator.SaveConfig(_serverDir, dlg.Port, dlg.Workspace);
                    _port = dlg.Port;
                    string ws = string.IsNullOrEmpty(dlg.Workspace) ? "(unrestricted)" : dlg.Workspace;
                    AppendLine($"[Launcher] Config updated: port={dlg.Port}, workspace={ws}");
                }
                catch (Exception ex)
                {
                    AppendLine("[Launcher] Failed to save config: " + ex.Message);
                    return;
                }

                if (IsRunning)
                {
                    AppendLine("[Launcher] Restarting server to apply new config …");
                    RestartServer();
                }
                else
                {
                    UpdateState();
                }
            }
        }

        private void AppendLine(string line)
        {
            if (_log.InvokeRequired)
            {
                _log.BeginInvoke((Action)(() => AppendLine(line)));
                return;
            }

            _log.AppendText(line + Environment.NewLine);

            // Ring-buffer trim to keep memory bounded.
            if (_log.Lines.Length > MaxLogLines + 200)
            {
                string[] lines = _log.Lines;
                _log.Lines = lines.Skip(lines.Length - MaxLogLines).ToArray();
            }

            _log.SelectionStart = _log.TextLength;
            _log.ScrollToCaret();
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            _closing = true;
            _pollTimer.Stop();
            _trayIcon.Visible = false;
            _trayIcon.Dispose();
            if (IsRunning)
            {
                try { _proc.Exited -= OnProcExited; } catch { }
                KillTree(_proc.Id);
                try { if (!_proc.HasExited) _proc.Kill(); } catch { }
            }
        }
    }
}
