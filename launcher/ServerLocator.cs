using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text.RegularExpressions;

namespace CCRemoteLauncher
{
    /// <summary>
    /// Provides the server directory the launcher runs. The whole server is embedded
    /// in the exe as <c>server-bundle.zip</c>; on launch it is extracted to a stable
    /// per-user data folder so a single downloaded exe is fully self-contained.
    /// If no bundle is embedded (plain dev build), falls back to a sibling server/ folder.
    /// </summary>
    internal static class ServerLocator
    {
        private const string BundleResourceName = "server-bundle.zip";

        /// <summary>Per-user data root: %LOCALAPPDATA%\CC-Remote\server</summary>
        public static string DataServerDir =>
            Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "CC-Remote", "server");

        /// <summary>
        /// Ensure a runnable server directory exists and return it (null if none).
        /// <paramref name="log"/> receives human-readable progress/diagnostic lines.
        /// </summary>
        public static string EnsureServerDir(Action<string> log)
        {
            // Prefer the embedded bundle (real distribution).
            if (HasEmbeddedBundle())
            {
                try
                {
                    string dir = ExtractBundleIfNeeded(log);
                    return dir;
                }
                catch (Exception ex)
                {
                    log("[启动器] 解压内置服务端失败: " + ex.Message);
                    // fall through to folder lookup
                }
            }

            // Dev fallback: a sibling/ancestor server/ folder with src/index.js.
            string folder = FindSiblingServerDir();
            if (folder != null) log("[启动器] 使用本地 server 目录: " + folder);
            return folder;
        }

        private static bool HasEmbeddedBundle()
        {
            using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream(BundleResourceName))
                return s != null;
        }

        /// <summary>
        /// Extract the embedded bundle to <see cref="DataServerDir"/>. Skips extraction
        /// when the on-disk stamp already matches this build's version. Never overwrites
        /// an existing config.json (preserves user edits); always refreshes code.
        /// </summary>
        private static string ExtractBundleIfNeeded(Action<string> log)
        {
            string target = DataServerDir;
            string stampFile = Path.Combine(target, ".bundle-version");
            string version = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "0";

            if (File.Exists(Path.Combine(target, "src", "index.js")) &&
                File.Exists(stampFile) &&
                File.ReadAllText(stampFile).Trim() == version)
            {
                log("[启动器] 内置服务端已就绪: " + target);
                return target;
            }

            log("[启动器] 正在释放内置服务端到: " + target);
            Directory.CreateDirectory(target);

            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(BundleResourceName))
            using (var zip = new ZipArchive(stream, ZipArchiveMode.Read))
            {
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    string rel = entry.FullName
                        .Replace('/', Path.DirectorySeparatorChar)
                        .Replace('\\', Path.DirectorySeparatorChar);
                    string dest = Path.Combine(target, rel);

                    // Directory entry
                    if (string.IsNullOrEmpty(entry.Name))
                    {
                        Directory.CreateDirectory(dest);
                        continue;
                    }

                    Directory.CreateDirectory(Path.GetDirectoryName(dest));

                    // Preserve a config.json the user may have edited.
                    if (string.Equals(entry.Name, "config.json", StringComparison.OrdinalIgnoreCase)
                        && File.Exists(dest))
                    {
                        continue;
                    }

                    entry.ExtractToFile(dest, overwrite: true);
                }
            }

            File.WriteAllText(stampFile, version);
            log("[启动器] 内置服务端释放完成。");
            return target;
        }

        private static string FindSiblingServerDir()
        {
            string baseDir = AppContext.BaseDirectory;

            string dist = Path.Combine(baseDir, "server");
            if (IsServerDir(dist)) return dist;

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
        /// Read the "port" value from &lt;serverDir&gt;/config.json. Falls back to 11199.
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
