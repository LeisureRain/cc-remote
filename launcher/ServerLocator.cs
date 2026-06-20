using System;
using System.IO;
using System.Text.RegularExpressions;

namespace CCRemoteLauncher
{
    /// <summary>
    /// Locates the bundled Node server and reads its configured port.
    /// </summary>
    internal static class ServerLocator
    {
        /// <summary>
        /// Find the server directory containing <c>src/index.js</c>.
        /// Prefers the distribution layout (&lt;exeDir&gt;/server); otherwise walks up
        /// parent directories looking for a sibling "server" folder (dev layout).
        /// Returns null if not found.
        /// </summary>
        public static string FindServerDir()
        {
            string baseDir = AppContext.BaseDirectory;

            // 1) Distribution layout: <exeDir>/server
            string dist = Path.Combine(baseDir, "server");
            if (IsServerDir(dist)) return dist;

            // 2) Dev layout: walk up to the repo root and use its "server" folder
            var dir = new DirectoryInfo(baseDir);
            while (dir != null)
            {
                string candidate = Path.Combine(dir.FullName, "server");
                if (IsServerDir(candidate)) return candidate;
                dir = dir.Parent;
            }

            return null;
        }

        private static bool IsServerDir(string dir)
        {
            return !string.IsNullOrEmpty(dir) && File.Exists(Path.Combine(dir, "src", "index.js"));
        }

        /// <summary>
        /// Read the "port" value from server/config.json. Falls back to 11199.
        /// Uses a lightweight regex to avoid a JSON dependency.
        /// </summary>
        public static int ReadPort(string serverDir)
        {
            try
            {
                string cfg = Path.Combine(serverDir, "config.json");
                if (File.Exists(cfg))
                {
                    string text = File.ReadAllText(cfg);
                    Match m = Regex.Match(text, "\"port\"\\s*:\\s*(\\d+)");
                    if (m.Success && int.TryParse(m.Groups[1].Value, out int p)) return p;
                }
            }
            catch
            {
                // ignore — fall through to default
            }
            return 11199;
        }
    }
}
