using System;
using System.Diagnostics;
using System.Drawing;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

namespace CCRemoteLauncher
{
    /// <summary>
    /// Single-window launcher: start/stop/restart the Node server process and stream
    /// its stdout/stderr into a live log view. No session-level controls — those live
    /// in the Android app. The launcher only manages the server process itself.
    /// </summary>
    internal sealed class MainForm : Form
    {
        private const int MaxLogLines = 2000;

        private readonly TextBox _log;
        private readonly Button _btnStart;
        private readonly Button _btnStop;
        private readonly Button _btnRestart;
        private readonly Button _btnClear;
        private readonly Button _btnOpenDir;
        private readonly Label _status;

        private Process _proc;
        private string _serverDir;
        private int _port = 11199;
        private bool _closing;

        public MainForm()
        {
            string version = Assembly.GetExecutingAssembly().GetName().Version is Version v
                ? $"{v.Major}.{v.Minor}.{v.Build}"
                : "?";

            Text = $"CC Remote 服务端启动器  v{version}";
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
            _btnStart = MakeButton("启动服务", (s, e) => StartServer());
            _btnStop = MakeButton("停止服务", (s, e) => StopServer(restart: false));
            _btnRestart = MakeButton("重启服务", (s, e) => RestartServer());
            _btnClear = MakeButton("清空日志", (s, e) => _log.Clear());
            _btnOpenDir = MakeButton("打开服务端目录", (s, e) => OpenServerDir());
            bar.Controls.AddRange(new Control[] { _btnStart, _btnStop, _btnRestart, _btnClear, _btnOpenDir });

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

            Controls.Add(_log);
            Controls.Add(_status);
            Controls.Add(bar);

            Load += (s, e) => Initialize();
            FormClosing += OnFormClosing;
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

        private void Initialize()
        {
            _serverDir = ServerLocator.EnsureServerDir(AppendLine);
            if (_serverDir == null)
            {
                AppendLine("[启动器] 找不到服务端(内置或本地 server 目录均不可用)。");
                UpdateState();
                return;
            }
            _port = ServerLocator.ReadPort(_serverDir);
            UpdateState();
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

                AppendLine("[启动器] 正在启动服务端 …");
                _proc.Start();
                _proc.BeginOutputReadLine();
                _proc.BeginErrorReadLine();
            }
            catch (Exception ex)
            {
                AppendLine("[启动器] 启动失败: " + ex.Message);
                AppendLine("[启动器] 请确认系统已安装 Node.js,且 node 在 PATH 中。");
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
            AppendLine($"[启动器] 正在停止服务端 (PID {pid}) …");

            // Detach so the Exited handler doesn't fight us, then kill the whole tree
            // (node spawns claude children). .NET Framework has no Kill(entireProcessTree),
            // so use taskkill /T /F.
            try { _proc.Exited -= OnProcExited; } catch { }
            KillTree(pid);
            try { if (!_proc.HasExited) _proc.Kill(); } catch { }
            _proc = null;

            UpdateState();
            if (restart) StartServer();
        }

        private void RestartServer()
        {
            AppendLine("[启动器] 重启服务端 …");
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
                AppendLine($"[启动器] 服务端已退出 (exit code {code})。");
                _proc = null;
                UpdateState();
            }));
        }

        private void UpdateState()
        {
            bool running = IsRunning;
            _btnStart.Enabled = !running && _serverDir != null;
            _btnStop.Enabled = running;
            _btnRestart.Enabled = running;
            _btnOpenDir.Enabled = _serverDir != null;

            if (running)
            {
                _status.Text = $"● 运行中    127.0.0.1:{_port}    （会话操作请在 Android App 中进行）";
                _status.ForeColor = Color.FromArgb(81, 207, 102);
            }
            else
            {
                _status.Text = "○ 已停止";
                _status.ForeColor = Color.FromArgb(248, 81, 73);
            }
        }

        private void OpenServerDir()
        {
            if (_serverDir == null) return;
            try { Process.Start("explorer.exe", _serverDir); }
            catch (Exception ex) { AppendLine("[启动器] 打开目录失败: " + ex.Message); }
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
            if (IsRunning)
            {
                try { _proc.Exited -= OnProcExited; } catch { }
                KillTree(_proc.Id);
                try { if (!_proc.HasExited) _proc.Kill(); } catch { }
            }
        }
    }
}
