using System;
using System.Threading;
using System.Windows.Forms;

namespace CCRemoteLauncher
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            // Single-instance guard: a second launch just exits with a hint.
            using (var mutex = new Mutex(true, "CCRemoteLauncher_SingleInstance_8e0f7a12", out bool isNew))
            {
                if (!isNew)
                {
                    MessageBox.Show("CC Remote Launcher is already running.", "CC Remote",
                        MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm());

                GC.KeepAlive(mutex);
            }
        }
    }
}
