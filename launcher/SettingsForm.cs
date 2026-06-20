using System;
using System.Drawing;
using System.Windows.Forms;

namespace CCRemoteLauncher
{
    /// <summary>
    /// Modal dialog to edit the two server settings users change most often:
    /// the listening port and the workspace directory. Other config.json fields
    /// are left untouched.
    /// </summary>
    internal sealed class SettingsForm : Form
    {
        private readonly NumericUpDown _port;
        private readonly TextBox _workspace;

        public int Port => (int)_port.Value;
        public string Workspace => _workspace.Text.Trim();

        public SettingsForm(int port, string workspace)
        {
            Text = "服务端设置";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = false;
            ClientSize = new Size(470, 196);
            Font = new Font("Segoe UI", 9f);

            var lblPort = new Label
            {
                Text = "监听端口:",
                Left = 16, Top = 22, Width = 90,
                TextAlign = ContentAlignment.MiddleLeft,
            };
            _port = new NumericUpDown
            {
                Left = 110, Top = 20, Width = 110,
                Minimum = 1, Maximum = 65535,
                Value = (port >= 1 && port <= 65535) ? port : 11199,
            };

            var lblWs = new Label
            {
                Text = "工作区目录(留空 = 不限制):",
                Left = 16, Top = 62, Width = 300,
            };
            _workspace = new TextBox
            {
                Left = 16, Top = 86, Width = 340,
                Text = workspace ?? string.Empty,
            };
            var browse = new Button { Text = "浏览…", Left = 362, Top = 84, Width = 90, FlatStyle = FlatStyle.System };
            browse.Click += (s, e) =>
            {
                using (var dlg = new FolderBrowserDialog())
                {
                    if (!string.IsNullOrEmpty(_workspace.Text)) dlg.SelectedPath = _workspace.Text;
                    if (dlg.ShowDialog(this) == DialogResult.OK) _workspace.Text = dlg.SelectedPath;
                }
            };

            var note = new Label
            {
                Text = "保存后会自动重启服务端以生效。",
                Left = 16, Top = 124, Width = 430,
                ForeColor = Color.Gray,
            };

            var ok = new Button { Text = "保存", Left = 286, Top = 156, Width = 80, DialogResult = DialogResult.OK, FlatStyle = FlatStyle.System };
            var cancel = new Button { Text = "取消", Left = 372, Top = 156, Width = 80, DialogResult = DialogResult.Cancel, FlatStyle = FlatStyle.System };

            Controls.AddRange(new Control[] { lblPort, _port, lblWs, _workspace, browse, note, ok, cancel });
            AcceptButton = ok;
            CancelButton = cancel;
        }
    }
}
