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
                    log("[Launcher] Failed to extract embedded server: " + ex.Message);
                    // fall through to folder lookup
                }
            }

            // Dev fallback: a sibling/ancestor server/ folder with src/index.js.
            string folder = FindSiblingServerDir();
            if (folder != null) log("[Launcher] Using local server directory: " + folder);
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
                log("[Launcher] Embedded server ready: " + target);
                return target;
            }

            log("[Launcher] Extracting embedded server to: " + target);
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
            log("[Launcher] Embedded server extracted.");
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

        /// <summary>
        /// Read the "workspace" value from &lt;serverDir&gt;/config.json (JSON-unescaped).
        /// Empty string means "no restriction".
        /// </summary>
        public static string ReadWorkspace(string serverDir)
        {
            try
            {
                string cfg = Path.Combine(serverDir, "config.json");
                if (File.Exists(cfg))
                {
                    string text = File.ReadAllText(cfg);
                    Match m = Regex.Match(text, "\"workspace\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
                    if (m.Success)
                    {
                        // Unescape the JSON string (paths use \\ for backslashes).
                        return m.Groups[1].Value.Replace("\\\\", "\\").Replace("\\\"", "\"").Replace("\\/", "/");
                    }
                }
            }
            catch
            {
                // ignore
            }
            return string.Empty;
        }

        /// <summary>
        /// Write back only "port" and "workspace" in &lt;serverDir&gt;/config.json, preserving
        /// every other field and the file's formatting. Uses MatchEvaluators so path
        /// characters ($, \) are never reinterpreted.
        /// </summary>
        public static void SaveConfig(string serverDir, int port, string workspace)
        {
            string cfg = Path.Combine(serverDir, "config.json");
            string text = File.ReadAllText(cfg);

            text = Regex.Replace(text, "(\"port\"\\s*:\\s*)\\d+",
                m => m.Groups[1].Value + port);

            string esc = (workspace ?? string.Empty).Replace("\\", "\\\\").Replace("\"", "\\\"");
            if (Regex.IsMatch(text, "\"workspace\"\\s*:\\s*\"(?:[^\"\\\\]|\\\\.)*\""))
            {
                text = Regex.Replace(text, "(\"workspace\"\\s*:\\s*\")(?:[^\"\\\\]|\\\\.)*(\")",
                    m => m.Groups[1].Value + esc + m.Groups[2].Value);
            }
            else
            {
                // No workspace key present — insert one right after the opening brace.
                text = new Regex("\\{").Replace(text, "{\r\n  \"workspace\": \"" + esc + "\",", 1);
            }

            File.WriteAllText(cfg, text);
        }
    }
}
