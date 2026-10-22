using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace VencordMeSetup
{
    internal class DiscordInstall
    {
        public string Branch;
        public string AppDir;
        public string ResourcesDir;
        public string Version;
        public bool HasAsar;
        public bool HasBackup;
        public bool IsOurs;
        public string Status;
    }

    internal static class Payload
    {
        public const string DataFolder = "VencordMe";

        private static string overrideDataDir;

        // Where new dist files come from when updating without rebuilding the exe:
        // a folder next to the installer (update mode used by --update-dist).
        public static string ExternalDistDir;

        public const string OpenAsarUrl = "https://github.com/GooseMod/OpenAsar/releases/download/nightly/app.asar";

        public static string OverrideDataDir
        {
            get { return overrideDataDir; }
            set { overrideDataDir = value; }
        }

        public static readonly string[] DistFiles =
        {
            "patcher.js",
            "preload.js",
            "renderer.js",
            "renderer.css",
            "patcher.js.LEGAL.txt",
            "renderer.js.LEGAL.txt"
        };

        public static string DataDir
        {
            get
            {
                if (!string.IsNullOrEmpty(overrideDataDir))
                    return overrideDataDir;
                return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), DataFolder);
            }
        }

        public static string DistDir
        {
            get { return Path.Combine(DataDir, "dist"); }
        }

        public static string SettingsDir
        {
            get { return Path.Combine(DataDir, "settings"); }
        }

        public static bool HasProfile
        {
            get
            {
                using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("settings.mine.json"))
                    return s != null;
            }
        }

        public static void CopyResource(string name, string dest)
        {
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
            {
                if (s == null)
                    throw new InvalidOperationException("Embedded resource not found: " + name);
                using (FileStream f = File.Create(dest))
                {
                    s.CopyTo(f);
                }
            }
        }

        // overwriteSettings = replace an existing settings.json
        // withProfile       = write the bundled profile (your settings, pnygo off)
        //                    instead of the "everything disabled" defaults
        public static void Extract(bool overwriteSettings, bool withProfile, Action<string> log)
        {
            Directory.CreateDirectory(DistDir);
            for (int i = 0; i < DistFiles.Length; i++)
            {
                string file = DistFiles[i];
                CopyResource(file, Path.Combine(DistDir, file));
                log("  dist\\" + file + "  (" + new FileInfo(Path.Combine(DistDir, file)).Length + " bytes)");
            }

            if (withProfile && !HasProfile)
                throw new InvalidOperationException("This setup was built without a settings profile.");

            Directory.CreateDirectory(SettingsDir);
            string settingsFile = Path.Combine(SettingsDir, "settings.json");
            if (overwriteSettings || withProfile || !File.Exists(settingsFile))
            {
                CopyResource(withProfile ? "settings.mine.json" : "settings.json", settingsFile);
                log("  settings\\settings.json  (" + new FileInfo(settingsFile).Length + " bytes)"
                    + (withProfile ? "  <- your settings profile" : ""));
            }
            else
            {
                log("  settings\\settings.json  kept existing file");
            }

            string cssFile = Path.Combine(SettingsDir, "quickCss.css");
            if (!File.Exists(cssFile))
            {
                CopyResource("quickCss.css", cssFile);
                log("  settings\\quickCss.css");
            }
            else
            {
                log("  settings\\quickCss.css  kept existing file");
            }
        }
    }

    internal static class Discord
    {
        private static readonly string[] BranchFolders = { "Discord", "DiscordCanary", "DiscordPTB" };
        private static readonly string[] BranchNames = { "Stable", "Canary", "PTB" };
        private static readonly string[] ProcessNames = { "Discord", "DiscordCanary", "DiscordPTB" };
        private static readonly string[] ExeNames = { "Discord.exe", "DiscordCanary.exe", "DiscordPTB.exe" };

        public static List<DiscordInstall> Detect()
        {
            List<DiscordInstall> found = new List<DiscordInstall>();
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

            for (int b = 0; b < BranchFolders.Length; b++)
            {
                string root = Path.Combine(local, BranchFolders[b]);
                if (!Directory.Exists(root))
                    continue;

                string[] dirs = Directory.GetDirectories(root, "app-*");
                Array.Sort(dirs, StringComparer.OrdinalIgnoreCase);

                for (int i = dirs.Length - 1; i >= 0; i--)
                {
                    string appDir = dirs[i];
                    string res = Path.Combine(appDir, "resources");
                    string asar = Path.Combine(res, "app.asar");
                    string bak = Path.Combine(res, "_app.asar");

                    bool hasAsar = File.Exists(asar);
                    bool hasBak = File.Exists(bak);
                    if (!hasAsar && !hasBak)
                        continue;

                    DiscordInstall d = new DiscordInstall();
                    d.Branch = BranchNames[b];
                    d.AppDir = appDir;
                    d.ResourcesDir = res;
                    d.Version = Path.GetFileName(appDir).Replace("app-", "");
                    d.HasAsar = hasAsar;
                    d.HasBackup = hasBak;
                    d.IsOurs = hasAsar && LooksLikeOurs(asar);
                    bool patcher = hasAsar && IsPatchAsar(asar);
                    d.Status = d.IsOurs ? "VencordMe" : (patcher || hasBak ? "Patched" : "Vanilla");
                    found.Add(d);
                }
            }

            return found;
        }

        // Build an install entry from any folder the user picked with Browse...:
        // the resources folder itself, an app-x.y.z folder, or a parent of them.
        public static DiscordInstall FromPath(string path)
        {
            if (string.IsNullOrEmpty(path) || !Directory.Exists(path))
                return null;

            string p = Path.GetFullPath(path).TrimEnd('\\', '/');
            string res = IsResourcesDir(p) ? p : FindResourcesUnder(p, 2, 300);
            if (res == null)
                return null;

            string appDir = Path.GetDirectoryName(res);
            string version = Path.GetFileName(appDir);
            if (version.StartsWith("app-", StringComparison.OrdinalIgnoreCase))
                version = version.Substring(4);
            else
                version = "custom";

            string branch = "Custom";
            for (int i = 0; i < BranchFolders.Length; i++)
            {
                if (res.IndexOf("\\" + BranchFolders[i] + "\\", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    branch = BranchNames[i];
                    break;
                }
            }

            DiscordInstall d = new DiscordInstall();
            d.Branch = branch;
            d.AppDir = appDir;
            d.ResourcesDir = res;
            d.Version = version;
            d.HasAsar = File.Exists(Path.Combine(res, "app.asar"));
            d.HasBackup = File.Exists(Path.Combine(res, "_app.asar"));
            d.IsOurs = d.HasAsar && LooksLikeOurs(Path.Combine(res, "app.asar"));
            bool patcher = d.HasAsar && IsPatchAsar(Path.Combine(res, "app.asar"));
            d.Status = d.IsOurs ? "VencordMe" : (patcher || d.HasBackup ? "Patched" : "Vanilla");
            return d;
        }

        private static bool IsResourcesDir(string dir)
        {
            if (!Directory.Exists(dir))
                return false;
            return File.Exists(Path.Combine(dir, "app.asar")) ||
                   File.Exists(Path.Combine(dir, "_app.asar"));
        }

        // Looks for a resources folder below root, at most depth levels down,
        // giving up after maxVisited directories so picking C:\ stays responsive.
        private static string FindResourcesUnder(string root, int depth, int maxVisited)
        {
            if (depth < 0 || maxVisited <= 0)
                return null;

            try
            {
                string[] apps = Directory.GetDirectories(root, "app-*");
                Array.Sort(apps, StringComparer.OrdinalIgnoreCase);
                for (int i = apps.Length - 1; i >= 0; i--)
                {
                    string cand = Path.Combine(apps[i], "resources");
                    if (IsResourcesDir(cand))
                        return cand;
                }

                string direct = Path.Combine(root, "resources");
                if (IsResourcesDir(direct))
                    return direct;

                if (depth > 0)
                {
                    string[] kids = Directory.GetDirectories(root);
                    Array.Sort(kids, StringComparer.OrdinalIgnoreCase);
                    for (int i = 0; i < kids.Length; i++)
                    {
                        string name = Path.GetFileName(kids[i]);
                        if (name.StartsWith(".", StringComparison.Ordinal) ||
                            name.Equals("node_modules", StringComparison.OrdinalIgnoreCase))
                            continue;

                        string found = FindResourcesUnder(kids[i], depth - 1, maxVisited - 1);
                        if (found != null)
                            return found;
                    }
                }
            }
            catch
            {
            }
            return null;
        }

        public static bool LooksLikeOurs(string asarPath)
        {
            try
            {
                byte[] head = new byte[4096];
                using (FileStream fs = File.OpenRead(asarPath))
                {
                    int read = fs.Read(head, 0, head.Length);
                    string text = Encoding.ASCII.GetString(head, 0, read);
                    return text.Contains("VencordMe");
                }
            }
            catch
            {
                return false;
            }
        }

        private static uint ReadUInt32LE(byte[] b, int offset)
        {
            return (uint)(b[offset] | (b[offset + 1] << 8) | (b[offset + 2] << 16) | (b[offset + 3] << 24));
        }

        // True when the file is a Vencord-style patch asar: a tiny archive whose
        // index.js is just require("...\\patcher.js"). Used to avoid restoring
        // over an untouched original.
        public static bool IsPatchAsar(string asarPath)
        {
            try
            {
                byte[] head = new byte[65536];
                int read;
                using (FileStream fs = File.OpenRead(asarPath))
                {
                    read = fs.Read(head, 0, head.Length);
                }

                if (read < 16)
                    return false;

                uint first = ReadUInt32LE(head, 0);
                uint hss = ReadUInt32LE(head, 12);
                if (first != 4 || hss == 0 || hss > 65520)
                    return false;
                if (16L + hss > read)
                    return false;

                string json = Encoding.UTF8.GetString(head, 16, (int)hss);
                if (json.IndexOf("\"index.js\"") < 0 || json.IndexOf("\"package.json\"") < 0)
                    return false;

                System.Text.RegularExpressions.Match m =
                    System.Text.RegularExpressions.Regex.Match(json, "\"index\\.js\":\\{\"size\":(\\d+)");
                if (!m.Success)
                    return false;

                int size = int.Parse(m.Groups[1].Value);
                if (size <= 0 || 16L + hss + size > read)
                    return false;

                string indexJs = Encoding.UTF8.GetString(head, 16 + (int)hss, size);
                return indexJs.StartsWith("require(");
            }
            catch
            {
                return false;
            }
        }

        public static bool IsRunning()
        {
            for (int i = 0; i < ProcessNames.Length; i++)
            {
                if (Process.GetProcessesByName(ProcessNames[i]).Length > 0)
                    return true;
            }
            return false;
        }

        // Only kill the process(s) that belong to the branches the user actually
        // selected (or, in CLI mode, one specific install). Killing every
        // Discord.exe / DiscordCanary.exe / DiscordPTB.exe globally was the bug:
        // installing on one branch closed every Discord on the PC.
        public static bool IsRunning(IEnumerable<DiscordInstall> targets)
        {
            if (targets == null)
                return IsRunning();
            foreach (DiscordInstall d in targets)
            {
                string proc = ProcessNameForBranch(d.Branch);
                if (proc != null && Process.GetProcessesByName(proc).Length > 0)
                    return true;
            }
            return false;
        }

        private static string ProcessNameForBranch(string branch)
        {
            int idx = Array.IndexOf(BranchNames, branch);
            return idx >= 0 ? ProcessNames[idx] : null;
        }

        public static bool Close(IEnumerable<DiscordInstall> targets, Action<string> log)
        {
            List<Process> procs = new List<Process>();
            List<string> names = new List<string>();
            foreach (DiscordInstall d in targets)
            {
                string p = ProcessNameForBranch(d.Branch);
                if (p != null && !names.Contains(p))
                    names.Add(p);
            }
            if (names.Count == 0)
                return true;

            foreach (string name in names)
            {
                try
                {
                    procs.AddRange(Process.GetProcessesByName(name));
                }
                catch
                {
                }
            }

            if (procs.Count == 0)
            {
                log("Discord is not running.");
                return true;
            }

            log("Closing Discord (" + procs.Count + " process(es): " + string.Join(", ", names) + ")...");
            for (int i = 0; i < procs.Count; i++)
            {
                try { procs[i].Kill(); }
                catch (Exception ex) { log("  could not close " + procs[i].ProcessName + ": " + ex.Message); }
            }

            for (int wait = 0; wait < 60; wait++)
            {
                Thread.Sleep(100);
                bool any = false;
                foreach (string name in names)
                {
                    if (Process.GetProcessesByName(name).Length > 0)
                    {
                        any = true;
                        break;
                    }
                }
                if (!any)
                {
                    log("Discord closed.");
                    return true;
                }
            }

            log("WARNING: Discord is still running.");
            return false;
        }

        public static void Launch(DiscordInstall d)
        {
            if (d == null)
                return;

            int idx = Array.IndexOf(BranchNames, d.Branch);
            if (idx < 0)
                idx = 0;

            string update = Path.Combine(d.AppDir, "..", "Update.exe");
            try
            {
                if (File.Exists(update))
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = update,
                        Arguments = "--processStart " + ExeNames[idx],
                        UseShellExecute = false,
                        WorkingDirectory = Path.GetDirectoryName(update)
                    });
                    return;
                }
            }
            catch
            {
            }

            string exe = Path.Combine(d.AppDir, ExeNames[idx]);
            if (File.Exists(exe))
            {
                try { Process.Start(exe); }
                catch
                {
                }
            }
        }

        public static void InstallOne(DiscordInstall d, Action<string> log)
        {
            string asar = Path.Combine(d.ResourcesDir, "app.asar");
            string bak = Path.Combine(d.ResourcesDir, "_app.asar");

            if (!File.Exists(asar) && !File.Exists(bak))
            {
                log("  skipped (no app.asar)");
                return;
            }

            if (File.Exists(asar) && !File.Exists(bak))
            {
                File.Move(asar, bak);
                log("  backed up original app.asar -> _app.asar");
            }
            else if (File.Exists(bak))
            {
                log("  backup _app.asar already present, keeping it");
            }

            byte[] data = Asar.Generate(Path.Combine(Payload.DistDir, "patcher.js"));
            File.WriteAllBytes(asar, data);
            log("  wrote app.asar (" + data.Length + " bytes) -> " + d.ResourcesDir);
        }

        public static void UninstallOne(DiscordInstall d, Action<string> log)
        {
            string asar = Path.Combine(d.ResourcesDir, "app.asar");
            string bak = Path.Combine(d.ResourcesDir, "_app.asar");

            if (!File.Exists(bak))
            {
                log("  skipped (no backup _app.asar)");
                return;
            }

            if (File.Exists(asar))
            {
                if (IsPatchAsar(asar))
                {
                    File.Delete(asar);
                    log("  removed patched app.asar");
                }
                else
                {
                    log("  app.asar is not a patcher, leaving it alone");
                    return;
                }
            }

            File.Move(bak, asar);
            log("  restored original app.asar");
        }

        public static void Launch()
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            for (int b = 0; b < BranchFolders.Length; b++)
            {
                string root = Path.Combine(local, BranchFolders[b]);
                if (!Directory.Exists(root))
                    continue;

                string update = Path.Combine(root, "Update.exe");
                if (File.Exists(update))
                {
                    try
                    {
                        Process.Start(new ProcessStartInfo
                        {
                            FileName = update,
                            Arguments = "--processStart " + ExeNames[b],
                            UseShellExecute = false,
                            WorkingDirectory = root
                        });
                        return;
                    }
                    catch
                    {
                    }
                }
            }
        }
    }

    internal static class OpenAsar
    {
        public static bool IsOpenAsar(string resourcesDir)
        {
            try
            {
                string asar = Path.Combine(resourcesDir, "app.asar");
                if (!File.Exists(asar))
                    return false;
                byte[] head = new byte[65536];
                int read;
                using (FileStream fs = File.OpenRead(asar))
                    read = fs.Read(head, 0, head.Length);
                return read > 0 && Encoding.ASCII.GetString(head, 0, read).Contains("OpenAsar");
            }
            catch
            {
                return false;
            }
        }

        // Download the nightly OpenAsar app.asar over the patch asar.
        // The original app is always _app.asar (InstallOne made it), so restoring
        // stays possible. Returns null on success, else an error string.
        public static string Install(string resourcesDir)
        {
            try
            {
                string asar = Path.Combine(resourcesDir, "app.asar");
                string bak = Path.Combine(resourcesDir, "_app.asar");
                if (!File.Exists(bak))
                {
                    if (!File.Exists(asar))
                        return "no app.asar in " + resourcesDir;
                    File.Move(asar, bak);
                }

                byte[] data;
                using (System.Net.WebClient wc = new System.Net.WebClient())
                {
                    data = wc.DownloadData(Payload.OpenAsarUrl);
                }
                if (data == null || data.Length < 1024)
                    return "downloaded OpenAsar looks wrong (" + (data == null ? 0 : data.Length) + " bytes)";

                File.WriteAllBytes(asar, data);
                return null;
            }
            catch (Exception ex)
            {
                return ex.Message;
            }
        }

        public static string Uninstall(string resourcesDir)
        {
            try
            {
                string asar = Path.Combine(resourcesDir, "app.asar");
                string bak = Path.Combine(resourcesDir, "_app.asar");
                if (!File.Exists(bak))
                    return "no _app.asar backup in " + resourcesDir;

                if (File.Exists(asar))
                {
                    if (Discord.IsPatchAsar(asar) || IsOpenAsar(resourcesDir))
                        File.Delete(asar);
                    else
                        return "app.asar is not a patcher/OpenAsar, leaving it alone";
                }
                File.Move(bak, asar);
                return null;
            }
            catch (Exception ex)
            {
                return ex.Message;
            }
        }
    }

    internal static class Asar
    {
        private static void WriteUInt32LE(Stream s, uint value)
        {
            s.WriteByte((byte)(value & 0xFF));
            s.WriteByte((byte)((value >> 8) & 0xFF));
            s.WriteByte((byte)((value >> 16) & 0xFF));
            s.WriteByte((byte)((value >> 24) & 0xFF));
        }

        public static byte[] Generate(string patcherPath)
        {
            string escaped = patcherPath.Replace("\\", "\\\\");
            byte[] index = Encoding.UTF8.GetBytes("require(\"" + escaped + "\")");
            byte[] package = Encoding.UTF8.GetBytes("{\n\t\"name\": \"discord\",\n\t\"main\": \"index.js\"\n}");

            string header = "{\"files\":{\"index.js\":{\"size\":" + index.Length +
                            ",\"offset\":\"0\"},\"package.json\":{\"size\":" + package.Length +
                            ",\"offset\":\"" + index.Length + "\"}}}";

            int pad = (4 - (header.Length % 4)) % 4;
            if (pad != 0)
                header += new string(' ', pad);

            byte[] headerBytes = Encoding.UTF8.GetBytes(header);
            int hss = headerBytes.Length;
            int hs = hss + 4;
            int h = hs + 4;

            using (MemoryStream ms = new MemoryStream())
            {
                WriteUInt32LE(ms, 4);
                WriteUInt32LE(ms, (uint)h);
                WriteUInt32LE(ms, (uint)hs);
                WriteUInt32LE(ms, (uint)hss);
                ms.Write(headerBytes, 0, headerBytes.Length);
                ms.Write(index, 0, index.Length);
                ms.Write(package, 0, package.Length);
                return ms.ToArray();
            }
        }
    }

    internal static class Program
    {
        private const int AttachParentProcess = -1;

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AttachConsole(int dwProcessId);

        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                if (args.Length > 0)
                    return RunCli(args);

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm());
                return 0;
            }
            catch (Exception ex)
            {
                MessageBox.Show("Unexpected error:\r\n\r\n" + ex, "VencordMe Setup",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        private static int RunCli(string[] args)
        {
            AttachConsole(AttachParentProcess);

            // WinExe apps get no stdout by default. When the parent redirected
            // our output (--list > file) we must wire it up ourselves.
            try
            {
                Stream stdout = Console.OpenStandardOutput();
                if (stdout != null && stdout.CanWrite)
                    Console.SetOut(new StreamWriter(stdout) { AutoFlush = true });
            }
            catch
            {
            }

            string cmd = args[0].ToLowerInvariant();

            if (cmd == "--help" || cmd == "/?" || cmd == "-h")
            {
                Console.WriteLine("VencordMe Setup");
                Console.WriteLine("  (no args)                     launch the setup window");
                Console.WriteLine("  --install [--yes] [--reset] [--with-profile]");
                Console.WriteLine("                                 patch every detected Discord");
                Console.WriteLine("  --with-profile                 apply the bundled settings profile");
                Console.WriteLine("                                 (your settings, pnygo stays disabled)");
                Console.WriteLine("  --uninstall [--yes]           restore every detected Discord");
                Console.WriteLine("  --list                        list detected Discord installs");
                Console.WriteLine("  --patch <resourcesDir>        patch one resources folder (testing)");
                Console.WriteLine("  --unpatch <resourcesDir>      restore one resources folder (testing)");
                Console.WriteLine("  --data-dir <dir>              override the %APPDATA%\\VencordMe folder");
                Console.WriteLine("  --gen-asar <path> <out>       generate an app.asar (debug)");
                return 0;
            }

            Action<string> log = delegate(string m)
            {
                Console.WriteLine(m);
            };

            bool yes = HasFlag(args, "--yes");
            bool reset = HasFlag(args, "--reset");
            bool withProfile = HasFlag(args, "--with-profile");

            if (cmd == "--list")
            {
                List<DiscordInstall> list = Discord.Detect();
                foreach (DiscordInstall d in list)
                {
                    string oa = OpenAsar.IsOpenAsar(d.ResourcesDir) ? " +OpenAsar" : "";
                    Console.WriteLine("{0,-7} {1,-12} {2,-9}{3} {4}", d.Branch, d.Version, d.Status, oa, d.AppDir);
                }
                if (list.Count == 0)
                    Console.WriteLine("No Discord installation found.");
                return 0;
            }

            if (cmd == "--openasar" || cmd == "--uninstall-openasar")
            {
                List<DiscordInstall> targets = Discord.Detect();
                if (targets.Count == 0)
                {
                    Console.WriteLine("No Discord installation found.");
                    return 1;
                }

                if (cmd == "--openasar")
                {
                    if (!yes && Discord.IsRunning(targets))
                    {
                        DialogResult r = MessageBox.Show(
                            "VencordMe needs to close Discord to install OpenAsar.\r\n\r\nClose Discord now?",
                            "VencordMe Setup", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                        if (r != DialogResult.Yes)
                        {
                            Console.WriteLine("Aborted: Discord must be closed.");
                            return 1;
                        }
                    }
                    if (Discord.IsRunning(targets))
                        Discord.Close(targets, log);
                }

                int ok = 0;
                foreach (DiscordInstall d in targets)
                {
                    string err = cmd == "--openasar" ? OpenAsar.Install(d.ResourcesDir) : OpenAsar.Uninstall(d.ResourcesDir);
                    if (err == null)
                    {
                        ok++;
                        log(d.Branch + " " + d.Version + ": " + (cmd == "--openasar" ? "OpenAsar installed" : "OpenAsar removed"));
                    }
                    else
                        log(d.Branch + " " + d.Version + "  FAILED: " + err);
                }
                Console.WriteLine((cmd == "--openasar" ? "OpenAsar on " : "OpenAsar removed from ") + ok + " of " + targets.Count + " installation(s).");
                return ok == targets.Count ? 0 : 1;
            }

            if (cmd == "--gen-asar")
            {
                if (args.Length < 3)
                {
                    Console.WriteLine("usage: --gen-asar <patcherPath> <outputFile>");
                    return 2;
                }
                byte[] data = Asar.Generate(args[1]);
                File.WriteAllBytes(args[2], data);
                Console.WriteLine("wrote " + args[2] + " (" + data.Length + " bytes)");
                return 0;
            }

            for (int i = 0; i < args.Length - 1; i++)
            {
                if (string.Equals(args[i], "--data-dir", StringComparison.OrdinalIgnoreCase))
                    Payload.OverrideDataDir = args[i + 1];
            }

            if (cmd == "--patch" || cmd == "--unpatch")
            {
                if (args.Length < 2)
                {
                    Console.WriteLine("usage: --patch|--unpatch <resourcesDir> [--data-dir <dir>]");
                    return 2;
                }

                string res = args[1];
                if (!Directory.Exists(res))
                {
                    Console.WriteLine("No such directory: " + res);
                    return 2;
                }

                DiscordInstall d = new DiscordInstall();
                d.Branch = "Test";
                d.AppDir = Path.GetDirectoryName(res);
                d.ResourcesDir = res;
                d.Version = "test";

                if (cmd == "--patch")
                {
                    if (!File.Exists(Path.Combine(Payload.DistDir, "patcher.js")))
                        Payload.Extract(false, HasFlag(args, "--with-profile"), log);
                    Discord.InstallOne(d, log);
                }
                else
                {
                    Discord.UninstallOne(d, log);
                }
                return 0;
            }

            if (withProfile && !Payload.HasProfile)
            {
                Console.WriteLine("This setup was built without a settings profile.");
                return 2;
            }

            List<DiscordInstall> detected = cmd == "--install" || cmd == "--uninstall" ? Discord.Detect() : null;
            if (detected != null && detected.Count == 0)
            {
                Console.WriteLine("No Discord installation found.");
                return 1;
            }

            if (cmd == "--install")
            {
                if (!yes && Discord.IsRunning(detected))
                {
                    DialogResult r = MessageBox.Show(
                        "VencordMe needs to close Discord to patch it.\r\n\r\nClose Discord now?",
                        "VencordMe Setup", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                    if (r != DialogResult.Yes)
                    {
                        Console.WriteLine("Aborted: Discord must be closed.");
                        return 1;
                    }
                }
                if (Discord.IsRunning(detected))
                    Discord.Close(detected, log);

                log("Data folder: " + Payload.DataDir);
                Payload.Extract(reset, withProfile, log);

                List<DiscordInstall> list = detected;
                int ok = 0;
                foreach (DiscordInstall d in list)
                {
                    try
                    {
                        Discord.InstallOne(d, log);
                        ok++;
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine("  FAILED: " + ex.Message);
                    }
                }
                Console.WriteLine("Patched " + ok + " of " + list.Count + " installation(s).");
                return ok == list.Count ? 0 : 1;
            }

            if (cmd == "--uninstall")
            {
                if (!yes && Discord.IsRunning(detected))
                {
                    DialogResult r = MessageBox.Show(
                        "VencordMe needs to close Discord to restore it.\r\n\r\nClose Discord now?",
                        "VencordMe Setup", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                    if (r != DialogResult.Yes)
                    {
                        Console.WriteLine("Aborted: Discord must be closed.");
                        return 1;
                    }
                }
                if (Discord.IsRunning(detected))
                    Discord.Close(detected, log);

                List<DiscordInstall> list = detected;
                int ok = 0;
                foreach (DiscordInstall d in list)
                {
                    try
                    {
                        Discord.UninstallOne(d, log);
                        ok++;
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine("  FAILED: " + ex.Message);
                    }
                }
                Console.WriteLine("Restored " + ok + " of " + list.Count + " installation(s).");
                Console.WriteLine("Your VencordMe data is still in " + Payload.DataDir);
                return ok == list.Count ? 0 : 1;
            }

            Console.WriteLine("Unknown option: " + args[0]);
            return 2;
        }

        private static bool HasFlag(string[] args, string flag)
        {
            for (int i = 0; i < args.Length; i++)
            {
                if (string.Equals(args[i], flag, StringComparison.OrdinalIgnoreCase))
                    return true;
            }
            return false;
        }
    }

    // =====================================================================
    //  UI layer. Everything below is presentation only: the install /
    //  uninstall logic lives in Discord / Payload / Asar above and is unchanged.
    //  Written for C# 5 (csc /langversion:5): no ?. , no $"" , no =>.
    // =====================================================================

    internal static class Native
    {
        [DllImport("user32.dll")]
        public static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        [DllImport("dwmapi.dll")]
        public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    }

    internal static class Ui
    {
        public const int TitleH = 40;
        public const int RailW = 232;

        public static readonly Color Bg = Color.FromArgb(0x0D, 0x0E, 0x12);
        public static readonly Color Rail = Color.FromArgb(0x10, 0x12, 0x17);
        public static readonly Color Panel = Color.FromArgb(0x14, 0x16, 0x1C);
        public static readonly Color Line = Color.FromArgb(0x23, 0x26, 0x32);
        public static readonly Color LineHi = Color.FromArgb(0x3A, 0x3F, 0x52);
        public static readonly Color Fg = Color.FromArgb(0xF1, 0xF3, 0xF9);
        public static readonly Color Mute = Color.FromArgb(0x9A, 0xA1, 0xB6);
        public static readonly Color Accent = Color.FromArgb(0x7D, 0x8C, 0xFF);
        public static readonly Color AccentInk = Color.FromArgb(0x0B, 0x0D, 0x18);
        public static readonly Color Danger = Color.FromArgb(0xFF, 0x7A, 0x7A);
        public static readonly Color Ok = Color.FromArgb(0x6E, 0xE7, 0xA8);
        public static readonly Color Warn = Color.FromArgb(0xE0, 0xA8, 0x3A);

        public static readonly Font Body = new Font("Segoe UI", 9F);
        public static readonly Font BodyB = new Font("Segoe UI Semibold", 9.5F);
        public static readonly Font Small = new Font("Segoe UI", 8.5F);
        public static readonly Font Mono = new Font("Consolas", 8.75F);
        public static readonly Font Big = new Font("Segoe UI Semibold", 20F);
        public static readonly Font Btn = new Font("Segoe UI Semibold", 10F);

        public static Color Lerp(Color a, Color b, float t)
        {
            if (t < 0f) t = 0f;
            if (t > 1f) t = 1f;
            return Color.FromArgb(
                (int)(a.A + (b.A - a.A) * t),
                (int)(a.R + (b.R - a.R) * t),
                (int)(a.G + (b.G - a.G) * t),
                (int)(a.B + (b.B - a.B) * t));
        }

        // Moves v toward target; sets more = true while it is still travelling.
        public static float Approach(float v, float target, ref bool more)
        {
            float d = target - v;
            if (Math.Abs(d) < 0.02f)
                return target;
            more = true;
            return v + d * 0.28f;
        }

        public static GraphicsPath Round(RectangleF r, float radius)
        {
            GraphicsPath p = new GraphicsPath();
            float d = radius * 2f;
            if (d > r.Width) d = r.Width;
            if (d > r.Height) d = r.Height;
            if (d <= 0.5f)
            {
                p.AddRectangle(r);
                return p;
            }
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        public static void Quality(Graphics g)
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        }
    }

    // Base for custom-painted controls that ease between states on a 15 ms timer.
    // The timer only runs while something is moving.
    internal abstract class AnimControl : Control
    {
        private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();

        protected AnimControl()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw |
                     ControlStyles.Selectable | ControlStyles.StandardClick, true);
            timer.Interval = 15;
            timer.Tick += delegate
            {
                bool more = Step();
                Invalidate();
                if (!more)
                    timer.Stop();
            };
        }

        // Advance the animation one frame; return true while still moving.
        protected abstract bool Step();

        protected void Animate()
        {
            if (!timer.Enabled)
                timer.Start();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
                timer.Dispose();
            base.Dispose(disposing);
        }
    }

    internal enum BtnKind
    {
        Primary,
        Secondary,
        Danger,
        Ghost
    }

    internal class FlatButton : AnimControl
    {
        private float hover;
        private float press;
        private bool isHover;
        private bool isDown;
        public BtnKind Kind = BtnKind.Secondary;

        public FlatButton()
        {
            TabStop = true;
            Cursor = Cursors.Hand;
            Font = Ui.Btn;
            BackColor = Ui.Bg;
            AccessibleRole = AccessibleRole.PushButton;
        }

        protected override bool Step()
        {
            bool more = false;
            hover = Ui.Approach(hover, (isHover && Enabled) ? 1f : 0f, ref more);
            press = Ui.Approach(press, isDown ? 1f : 0f, ref more);
            return more;
        }

        protected override void OnMouseEnter(EventArgs e) { base.OnMouseEnter(e); isHover = true; Animate(); }
        protected override void OnMouseLeave(EventArgs e) { base.OnMouseLeave(e); isHover = false; isDown = false; Animate(); }
        protected override void OnEnabledChanged(EventArgs e) { base.OnEnabledChanged(e); Animate(); Invalidate(); }
        protected override void OnGotFocus(EventArgs e) { base.OnGotFocus(e); Invalidate(); }
        protected override void OnLostFocus(EventArgs e) { base.OnLostFocus(e); isDown = false; Animate(); Invalidate(); }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button == MouseButtons.Left) { isDown = true; Animate(); }
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            isDown = false;
            Animate();
        }

        protected override bool IsInputKey(Keys keyData)
        {
            Keys key = keyData & Keys.KeyCode;
            if (key == Keys.Enter || key == Keys.Space)
                return true;
            return base.IsInputKey(keyData);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter)
            {
                isDown = true;
                Animate();
                e.Handled = true;
            }
        }

        protected override void OnKeyUp(KeyEventArgs e)
        {
            base.OnKeyUp(e);
            if ((e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter) && isDown)
            {
                isDown = false;
                Animate();
                if (Enabled)
                    OnClick(EventArgs.Empty);
                e.Handled = true;
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            float k = g.DpiX / 96f;
            Ui.Quality(g);
            g.Clear(BackColor);

            Color fill;
            Color border;
            Color fg;
            if (Kind == BtnKind.Primary)
            {
                fill = Ui.Lerp(Ui.Accent, Color.White, 0.14f * hover);
                fill = Ui.Lerp(fill, Color.Black, 0.12f * press);
                border = fill;
                fg = Ui.AccentInk;
            }
            else if (Kind == BtnKind.Danger)
            {
                fill = Ui.Lerp(Ui.Panel, Ui.Lerp(Ui.Panel, Ui.Danger, 0.10f), hover);
                fill = Ui.Lerp(fill, Color.Black, 0.15f * press);
                border = Ui.Lerp(Ui.Line, Ui.Danger, hover);
                fg = Ui.Danger;
            }
            else if (Kind == BtnKind.Ghost)
            {
                fill = Ui.Lerp(BackColor, Ui.Panel, hover);
                fill = Ui.Lerp(fill, Color.Black, 0.15f * press);
                border = fill;
                fg = Ui.Accent;
            }
            else
            {
                fill = Ui.Lerp(Ui.Panel, Ui.Lerp(Ui.Panel, Color.White, 0.05f), hover);
                fill = Ui.Lerp(fill, Color.Black, 0.15f * press);
                border = Ui.Lerp(Ui.Line, Ui.LineHi, hover);
                fg = Ui.Fg;
            }

            if (!Enabled)
            {
                fill = Ui.Lerp(fill, BackColor, 0.5f);
                border = Ui.Lerp(border, BackColor, 0.5f);
                fg = Ui.Lerp(fg, BackColor, 0.55f);
            }

            RectangleF r = new RectangleF(0.5f, 0.5f, Width - 1f, Height - 1f);
            Brush fillBrush;
            if (Kind == BtnKind.Primary && Enabled)
                fillBrush = new LinearGradientBrush(r, Ui.Lerp(fill, Color.White, 0.16f),
                    Ui.Lerp(fill, Color.Black, 0.10f), LinearGradientMode.Vertical);
            else
                fillBrush = new SolidBrush(fill);
            using (GraphicsPath p = Ui.Round(r, 11f * k))
            using (fillBrush)
            using (Pen pen = new Pen(border, 1f))
            {
                g.FillPath(fillBrush, p);
                g.DrawPath(pen, p);
            }

            TextRenderer.DrawText(g, Text, Font, ClientRectangle, fg,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter |
                TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);

            if (Focused && ShowFocusCues)
            {
                RectangleF fr = new RectangleF(2f * k, 2f * k, Width - 4f * k, Height - 4f * k);
                using (GraphicsPath fp = Ui.Round(fr, 9f * k))
                using (Pen fpen = new Pen(Ui.Accent, 1.5f * k))
                {
                    g.DrawPath(fpen, fp);
                }
            }
        }
    }

    internal class ToggleSwitch : AnimControl
    {
        private bool on;
        private float t;
        private float hover;
        private bool isHover;

        public ToggleSwitch()
        {
            TabStop = true;
            Cursor = Cursors.Hand;
            Font = Ui.Body;
            ForeColor = Ui.Fg;
            BackColor = Ui.Bg;
            AccessibleRole = AccessibleRole.CheckButton;
        }

        public bool Checked
        {
            get { return on; }
            set
            {
                if (on == value)
                    return;
                on = value;
                if (!IsHandleCreated)
                    t = on ? 1f : 0f;
                Animate();
                Invalidate();
            }
        }

        protected override bool Step()
        {
            bool more = false;
            t = Ui.Approach(t, on ? 1f : 0f, ref more);
            hover = Ui.Approach(hover, isHover ? 1f : 0f, ref more);
            return more;
        }

        protected override void OnMouseEnter(EventArgs e) { base.OnMouseEnter(e); isHover = true; Animate(); }
        protected override void OnMouseLeave(EventArgs e) { base.OnMouseLeave(e); isHover = false; Animate(); }
        protected override void OnGotFocus(EventArgs e) { base.OnGotFocus(e); Invalidate(); }
        protected override void OnLostFocus(EventArgs e) { base.OnLostFocus(e); Invalidate(); }

        protected override void OnClick(EventArgs e)
        {
            base.OnClick(e);
            Checked = !Checked;
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (e.KeyCode == Keys.Space)
            {
                Checked = !Checked;
                e.Handled = true;
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            float k = g.DpiX / 96f;
            Ui.Quality(g);
            g.Clear(BackColor);

            float tw = 38f * k;
            float th = 22f * k;
            float ty = (Height - th) / 2f;
            RectangleF track = new RectangleF(1f * k, ty, tw, th);
            Color off = Ui.Lerp(Color.FromArgb(0x2A, 0x2E, 0x3D), Color.White, 0.06f * hover);
            Color trackColor = Ui.Lerp(off, Ui.Accent, t);

            using (GraphicsPath p = Ui.Round(track, th / 2f))
            using (SolidBrush b = new SolidBrush(trackColor))
            {
                g.FillPath(b, p);
            }

            float kd = 16f * k;
            float kx = track.X + 3f * k + (tw - kd - 6f * k) * t;
            Color knob = Ui.Lerp(Color.White, Ui.AccentInk, t);
            using (SolidBrush kb = new SolidBrush(knob))
            {
                g.FillEllipse(kb, kx, track.Y + 3f * k, kd, kd);
            }

            if (Focused && ShowFocusCues)
            {
                RectangleF fr = new RectangleF(track.X - 3f * k, track.Y - 3f * k, tw + 6f * k, th + 6f * k);
                using (GraphicsPath fp = Ui.Round(fr, fr.Height / 2f))
                using (Pen fpen = new Pen(Ui.Accent, 1.5f * k))
                {
                    g.DrawPath(fpen, fp);
                }
            }

            int tx = (int)(track.Right + 14f * k);
            Rectangle textRect = new Rectangle(tx, 0, Math.Max(10, Width - tx), Height);
            TextRenderer.DrawText(g, Text, Font, textRect, ForeColor,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine |
                TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);
        }
    }

    // Selectable cards instead of a ListView. Click a selected card again to clear
    // the selection (nothing selected = every listed installation is targeted).
    internal class InstallList : AnimControl
    {
        private readonly List<DiscordInstall> items = new List<DiscordInstall>();
        private readonly List<float> selT = new List<float>();
        private readonly List<float> hotT = new List<float>();
        private int selected = -1;
        private int hot = -1;
        private float scroll;
        private float k = 1f;

        public InstallList()
        {
            TabStop = true;
            BackColor = Ui.Bg;
            AccessibleRole = AccessibleRole.List;
        }

        public DiscordInstall Selected
        {
            get { return (selected >= 0 && selected < items.Count) ? items[selected] : null; }
        }

        // True when exactly one card is highlighted (user picked a specific install).
        public bool HasSelection
        {
            get { return selected >= 0; }
        }

        public void SetItems(List<DiscordInstall> found, string selectResourcesDir)
        {
            items.Clear();
            selT.Clear();
            hotT.Clear();
            selected = -1;
            hot = -1;
            scroll = 0f;

            foreach (DiscordInstall d in found)
            {
                if (selectResourcesDir != null &&
                    string.Equals(d.ResourcesDir, selectResourcesDir, StringComparison.OrdinalIgnoreCase))
                {
                    selected = items.Count;
                }
                items.Add(d);
                selT.Add(0f);
                hotT.Add(0f);
            }

            EnsureVisible();
            Animate();
            Invalidate();
        }

        private float CardH() { return 54f * k; }
        private float Gap() { return 8f * k; }

        private float Total()
        {
            if (items.Count == 0)
                return 0f;
            return items.Count * CardH() + (items.Count - 1) * Gap();
        }

        private void ClampScroll()
        {
            float max = Math.Max(0f, Total() - Height);
            if (scroll > max) scroll = max;
            if (scroll < 0f) scroll = 0f;
        }

        private void EnsureVisible()
        {
            if (selected < 0)
                return;
            float top = selected * (CardH() + Gap());
            float bottom = top + CardH();
            if (top < scroll)
                scroll = top;
            else if (bottom > scroll + Height)
                scroll = bottom - Height;
            ClampScroll();
        }

        private int IndexAt(int mouseY)
        {
            float y = -scroll;
            for (int i = 0; i < items.Count; i++)
            {
                if (mouseY >= y && mouseY < y + CardH())
                    return i;
                y += CardH() + Gap();
            }
            return -1;
        }

        private void SetSelected(int index)
        {
            if (index == selected)
                return;
            selected = index;
            EnsureVisible();
            Animate();
            Invalidate();
        }

        protected override bool Step()
        {
            bool more = false;
            for (int i = 0; i < items.Count; i++)
            {
                selT[i] = Ui.Approach(selT[i], i == selected ? 1f : 0f, ref more);
                hotT[i] = Ui.Approach(hotT[i], i == hot ? 1f : 0f, ref more);
            }
            return more;
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            int i = IndexAt(e.Y);
            if (i != hot)
            {
                hot = i;
                Cursor = i >= 0 ? Cursors.Hand : Cursors.Default;
                Animate();
            }
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            hot = -1;
            Animate();
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left)
                return;
            Focus();
            int i = IndexAt(e.Y);
            SetSelected(i == selected ? -1 : i);
        }

        public void ScrollBy(int delta)
        {
            scroll -= (delta / 120f) * CardH() * 0.6f;
            ClampScroll();
            Invalidate();
        }

        protected override void OnMouseWheel(MouseEventArgs e)
        {
            base.OnMouseWheel(e);
            ScrollBy(e.Delta);
            HandledMouseEventArgs h = e as HandledMouseEventArgs;
            if (h != null)
                h.Handled = true;
        }

        protected override bool IsInputKey(Keys keyData)
        {
            Keys key = keyData & Keys.KeyCode;
            if (key == Keys.Up || key == Keys.Down || key == Keys.Home || key == Keys.End)
                return true;
            return base.IsInputKey(keyData);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (items.Count == 0)
                return;

            int n;
            if (e.KeyCode == Keys.Down)
                n = selected < 0 ? 0 : Math.Min(selected + 1, items.Count - 1);
            else if (e.KeyCode == Keys.Up)
                n = selected < 0 ? 0 : Math.Max(selected - 1, 0);
            else if (e.KeyCode == Keys.Home)
                n = 0;
            else if (e.KeyCode == Keys.End)
                n = items.Count - 1;
            else
                return;

            e.Handled = true;
            SetSelected(n);
        }

        protected override void OnGotFocus(EventArgs e) { base.OnGotFocus(e); Invalidate(); }
        protected override void OnLostFocus(EventArgs e) { base.OnLostFocus(e); Invalidate(); }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            k = g.DpiX / 96f;
            Ui.Quality(g);
            g.Clear(BackColor);

            if (items.Count == 0)
            {
                RectangleF box = new RectangleF(0.5f, 0.5f, Width - 1f, Math.Min(Height - 1f, 72f * k));
                using (GraphicsPath p = Ui.Round(box, 12f * k))
                using (Pen pen = new Pen(Ui.Line, 1f))
                {
                    g.DrawPath(pen, p);
                }
                TextRenderer.DrawText(g, "No Discord installation found",
                    Ui.BodyB, new Rectangle((int)(18 * k), (int)(14 * k), Width, (int)(22 * k)),
                    Ui.Fg, TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
                TextRenderer.DrawText(g, "Use Browse... to point at your copy.",
                    Ui.Small, new Rectangle((int)(18 * k), (int)(38 * k), Width, (int)(20 * k)),
                    Ui.Mute, TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
                return;
            }

            ClampScroll();
            float h = CardH();
            float y = -scroll;
            for (int i = 0; i < items.Count; i++)
            {
                if (y + h >= 0f && y <= Height)
                    DrawCard(g, i, new RectangleF(0.5f, y + 0.5f, Width - 1f, h - 1f));
                y += h + Gap();
            }

            float total = Total();
            if (total > Height)
            {
                float barH = Math.Max(24f * k, Height * Height / total);
                float barY = (Height - barH) * (scroll / (total - Height));
                using (GraphicsPath bp = Ui.Round(new RectangleF(Width - 4f * k, barY, 3f * k, barH), 1.5f * k))
                using (SolidBrush bb = new SolidBrush(Color.FromArgb(120, Ui.LineHi)))
                {
                    g.FillPath(bb, bp);
                }
            }

            if (Focused && ShowFocusCues && selected < 0)
            {
                using (Pen fpen = new Pen(Color.FromArgb(90, Ui.Accent), 1.5f * k))
                {
                    g.DrawRectangle(fpen, 1f, 1f, Width - 3f, Height - 3f);
                }
            }
        }

        private void DrawCard(Graphics g, int i, RectangleF r)
        {
            DiscordInstall d = items[i];
            float st = selT[i];
            float ht = hotT[i];

            Color fill = Ui.Lerp(Ui.Panel, Ui.Lerp(Ui.Panel, Ui.Accent, 0.12f), st);
            Color border = Ui.Lerp(Ui.Lerp(Ui.Line, Ui.LineHi, ht), Ui.Accent, st);
            using (GraphicsPath p = Ui.Round(r, 12f * k))
            using (LinearGradientBrush b = new LinearGradientBrush(r, Ui.Lerp(fill, Color.White, 0.045f), fill, LinearGradientMode.Vertical))
            using (Pen pen = new Pen(border, 1f))
            {
                g.FillPath(b, p);
                g.DrawPath(pen, p);
            }

            // radio mark
            float cx = r.Left + 26f * k;
            float cy = r.Top + r.Height / 2f;
            float rad = 9f * k;
            using (Pen ring = new Pen(Ui.Lerp(Ui.LineHi, Ui.Accent, st), 2f * k))
            {
                g.DrawEllipse(ring, cx - rad + k, cy - rad + k, 2f * rad - 2f * k, 2f * rad - 2f * k);
            }
            float ir = 4f * k * st;
            if (ir > 0.3f)
            {
                using (SolidBrush ib = new SolidBrush(Ui.Accent))
                {
                    g.FillEllipse(ib, cx - ir, cy - ir, 2f * ir, 2f * ir);
                }
            }

            // status pill (right)
            string status = d.Status ?? "";
            Color sc = d.IsOurs ? Ui.Ok : (d.Status == "Patched" ? Ui.Warn : Ui.Mute);
            Size ts = TextRenderer.MeasureText(g, status, Ui.Small, Size.Empty,
                TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
            float pw = ts.Width + 18f * k;
            float ph = 20f * k;
            RectangleF pill = new RectangleF(r.Right - 14f * k - pw, cy - ph / 2f, pw, ph);
            using (GraphicsPath pp = Ui.Round(pill, ph / 2f))
            using (SolidBrush pb = new SolidBrush(Ui.Lerp(fill, sc, 0.10f)))
            using (Pen ppen = new Pen(Ui.Lerp(fill, sc, 0.55f), 1f))
            {
                g.FillPath(pb, pp);
                g.DrawPath(ppen, pp);
            }
            TextRenderer.DrawText(g, status, Ui.Small,
                new Rectangle((int)pill.X, (int)pill.Y, (int)pill.Width, (int)pill.Height), sc,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter |
                TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);

            // branch + version, then path
            int tx = (int)(cx + rad + 14f * k);
            int right = (int)(pill.Left - 12f * k);
            string branch = d.Branch ?? "";
            Size bs = TextRenderer.MeasureText(g, branch, Ui.BodyB, Size.Empty,
                TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
            TextRenderer.DrawText(g, branch, Ui.BodyB, new Point(tx, (int)(r.Top + 9f * k)), Ui.Fg,
                TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
            int vx = tx + bs.Width + (int)(8f * k);
            if (right - vx > 20)
            {
                TextRenderer.DrawText(g, d.Version ?? "", Ui.Small,
                    new Rectangle(vx, (int)(r.Top + 11f * k), right - vx, (int)(18f * k)), Ui.Mute,
                    TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);
            }
            if (right - tx > 20)
            {
                TextRenderer.DrawText(g, d.AppDir ?? "", Ui.Mono,
                    new Rectangle(tx, (int)(r.Top + 31f * k), right - tx, (int)(18f * k)), Ui.Mute,
                    TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.PathEllipsis);
            }
        }
    }

    // Read-only log: each new line eases in, colours follow the line's meaning.
    internal class LogView : AnimControl
    {
        private readonly List<string> lines = new List<string>();
        private readonly List<float> alpha = new List<float>();
        private float scroll;
        private float lastMax;
        private bool follow = true;
        private float k = 1f;
        private float lineH = 16f;

        public LogView()
        {
            TabStop = false;
            SetStyle(ControlStyles.Selectable, false);
            BackColor = Ui.Bg;
        }

        public void Append(string text)
        {
            if (text == null)
                text = "";
            string[] parts = text.Replace("\r", "").Split('\n');
            for (int i = 0; i < parts.Length; i++)
            {
                lines.Add(parts[i]);
                alpha.Add(0f);
            }
            if (lines.Count > 1500)
            {
                lines.RemoveRange(0, 300);
                alpha.RemoveRange(0, 300);
            }
            Animate();
            Invalidate();
        }

        public string AllText()
        {
            return string.Join("\r\n", lines.ToArray());
        }

        protected override bool Step()
        {
            bool more = false;
            for (int i = Math.Max(0, alpha.Count - 60); i < alpha.Count; i++)
                alpha[i] = Ui.Approach(alpha[i], 1f, ref more);
            return more;
        }

        private static Color KindColor(string s)
        {
            if (s.StartsWith("==", StringComparison.Ordinal))
                return Ui.Accent;
            if (s.IndexOf("FAILED", StringComparison.Ordinal) >= 0 ||
                s.StartsWith("Aborted", StringComparison.Ordinal) ||
                s.StartsWith("Could not", StringComparison.Ordinal) ||
                s.StartsWith("WARNING", StringComparison.Ordinal))
                return Ui.Danger;
            if (s.StartsWith("Done", StringComparison.Ordinal))
                return Ui.Ok;
            if (s.StartsWith("  ", StringComparison.Ordinal))
                return Ui.Mute;
            return Ui.Fg;
        }

        public void ScrollBy(int delta)
        {
            scroll -= (delta / 120f) * lineH * 3f;
            if (scroll < 0f) scroll = 0f;
            if (scroll > lastMax) scroll = lastMax;
            follow = scroll >= lastMax - 1f;
            Invalidate();
        }

        protected override void OnMouseWheel(MouseEventArgs e)
        {
            base.OnMouseWheel(e);
            ScrollBy(e.Delta);
            HandledMouseEventArgs h = e as HandledMouseEventArgs;
            if (h != null)
                h.Handled = true;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            k = g.DpiX / 96f;
            Ui.Quality(g);
            g.Clear(BackColor);

            RectangleF r = new RectangleF(0.5f, 0.5f, Width - 1f, Height - 1f);
            using (GraphicsPath p = Ui.Round(r, 12f * k))
            using (SolidBrush b = new SolidBrush(Ui.Panel))
            using (Pen pen = new Pen(Ui.Line, 1f))
            {
                g.FillPath(b, p);
                g.DrawPath(pen, p);
            }

            Rectangle inner = new Rectangle((int)(14 * k), (int)(10 * k),
                Math.Max(10, Width - (int)(28 * k)), Math.Max(10, Height - (int)(20 * k)));

            if (lines.Count == 0)
            {
                TextRenderer.DrawText(g, "Activity will appear here.", Ui.Small, inner, Ui.Mute,
                    TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix);
                return;
            }

            lineH = Ui.Mono.GetHeight(g) + 3f * k;
            float total = lines.Count * lineH;
            lastMax = Math.Max(0f, total - inner.Height);
            if (follow)
                scroll = lastMax;
            if (scroll > lastMax) scroll = lastMax;
            if (scroll < 0f) scroll = 0f;

            g.SetClip(inner);
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
            int first = Math.Max(0, (int)(scroll / lineH));
            for (int i = first; i < lines.Count; i++)
            {
                float y = inner.Top + i * lineH - scroll + (1f - alpha[i]) * 5f * k;
                if (y > inner.Bottom)
                    break;
                Color c = Color.FromArgb((int)(255f * alpha[i]), KindColor(lines[i]));
                using (SolidBrush tb = new SolidBrush(c))
                {
                    g.DrawString(lines[i], Ui.Mono, tb, inner.Left, y);
                }
            }
            g.ResetClip();

            if (lastMax > 0f)
            {
                float barH = Math.Max(20f * k, inner.Height * inner.Height / total);
                float barY = inner.Top + (inner.Height - barH) * (scroll / lastMax);
                using (GraphicsPath bp = Ui.Round(new RectangleF(Width - 7f * k, barY, 3f * k, barH), 1.5f * k))
                using (SolidBrush bb = new SolidBrush(Color.FromArgb(120, Ui.LineHi)))
                {
                    g.FillPath(bb, bp);
                }
            }
        }
    }

    // Thin indeterminate bar shown while the worker thread is running.
    internal class BusyBar : AnimControl
    {
        private bool active;
        private float phase;
        private float fade;

        public BusyBar()
        {
            TabStop = false;
            SetStyle(ControlStyles.Selectable, false);
            BackColor = Ui.Bg;
        }

        public bool Active
        {
            get { return active; }
            set
            {
                active = value;
                Animate();
                Invalidate();
            }
        }

        protected override bool Step()
        {
            bool more = false;
            fade = Ui.Approach(fade, active ? 1f : 0f, ref more);
            if (active || fade > 0f)
            {
                phase += 0.012f;
                if (phase > 1f) phase = 0f;
                more = true;
            }
            return more;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            Ui.Quality(g);
            g.Clear(BackColor);
            RectangleF track = new RectangleF(0f, 0f, Width, Height);
            using (GraphicsPath p = Ui.Round(track, Height / 2f))
            using (SolidBrush tb = new SolidBrush(Ui.Line))
            {
                g.FillPath(tb, p);
                if (fade > 0f)
                {
                    float segW = Math.Max(10f, Width * 0.32f);
                    float x = -segW + phase * (Width + segW);
                    g.SetClip(p);
                    using (SolidBrush sb = new SolidBrush(Color.FromArgb((int)(255f * fade), Ui.Accent)))
                    {
                        g.FillRectangle(sb, x, 0f, segW, Height);
                    }
                    g.ResetClip();
                }
            }
        }
    }

    internal class Logo : Control
    {
        public Logo()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw |
                     ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            TabStop = false;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            float k = g.DpiX / 96f;
            Ui.Quality(g);
            RectangleF r = new RectangleF(0.5f, 0.5f, Width - 1f, Height - 1f);
            using (GraphicsPath p = Ui.Round(r, 15f * k))
            using (SolidBrush b = new SolidBrush(Ui.Panel))
            using (Pen pen = new Pen(Ui.Line, 1f))
            {
                g.FillPath(b, p);
                g.DrawPath(pen, p);
            }
            using (Pen cp = new Pen(Ui.Accent, 5f * k))
            {
                cp.StartCap = LineCap.Round;
                cp.EndCap = LineCap.Round;
                cp.LineJoin = LineJoin.Round;
                PointF[] pts = new PointF[]
                {
                    new PointF(Width * 0.24f, Height * 0.37f),
                    new PointF(Width * 0.50f, Height * 0.74f),
                    new PointF(Width * 0.76f, Height * 0.37f)
                };
                g.DrawLines(cp, pts);
            }
        }
    }

    internal class TitleBar : Control
    {
        public TitleBar()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            BackColor = Ui.Bg;
            TabStop = false;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            float k = g.DpiX / 96f;
            g.Clear(BackColor);
            TextRenderer.DrawText(g, Text, Ui.Small,
                new Rectangle((int)(18 * k), 0, Math.Max(10, Width - (int)(18 * k)), Height), Ui.Mute,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine |
                TextFormatFlags.NoPrefix);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            Form f = FindForm();
            if (e.Button == MouseButtons.Left && f != null)
            {
                Native.ReleaseCapture();
                Native.SendMessage(f.Handle, 0xA1, (IntPtr)2, IntPtr.Zero); // WM_NCLBUTTONDOWN, HTCAPTION
            }
        }
    }

    internal enum CapKind
    {
        Minimize,
        Close
    }

    internal class CaptionButton : AnimControl
    {
        private float hover;
        private bool isHover;
        public CapKind Kind = CapKind.Minimize;

        public CaptionButton()
        {
            SetStyle(ControlStyles.Selectable, false);
            TabStop = false;
            BackColor = Ui.Bg;
        }

        protected override bool Step()
        {
            bool more = false;
            hover = Ui.Approach(hover, isHover ? 1f : 0f, ref more);
            return more;
        }

        protected override void OnMouseEnter(EventArgs e) { base.OnMouseEnter(e); isHover = true; Animate(); }
        protected override void OnMouseLeave(EventArgs e) { base.OnMouseLeave(e); isHover = false; Animate(); }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            float k = g.DpiX / 96f;
            Ui.Quality(g);

            bool close = Kind == CapKind.Close;
            Color bg = Ui.Lerp(Ui.Bg, close ? Ui.Danger : Ui.Panel, hover);
            Color glyph = close
                ? Ui.Lerp(Ui.Mute, Color.FromArgb(0x1A, 0x0A, 0x0A), hover)
                : Ui.Lerp(Ui.Mute, Ui.Fg, hover);
            g.Clear(bg);

            float cx = Width / 2f;
            float cy = Height / 2f;
            float d = 5f * k;
            using (Pen pen = new Pen(glyph, 1.4f * k))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                if (close)
                {
                    g.DrawLine(pen, cx - d, cy - d, cx + d, cy + d);
                    g.DrawLine(pen, cx - d, cy + d, cx + d, cy - d);
                }
                else
                {
                    g.DrawLine(pen, cx - d, cy, cx + d, cy);
                }
            }
        }
    }

    // Window background: rail, divider lines. Child controls sit on top of it.
    internal class Surface : Panel
    {
        public Surface()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            BackColor = Ui.Bg;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            float k = g.DpiX / 96f;
            g.Clear(Ui.Bg);
            int top = (int)(Ui.TitleH * k);
            int railW = (int)(Ui.RailW * k);
            using (SolidBrush rb = new SolidBrush(Ui.Rail))
            using (Pen lp = new Pen(Ui.Line, 1f))
            {
                g.FillRectangle(rb, 0, top, railW, Math.Max(0, Height - top));

                // soft accent glow behind the logo
                g.SetClip(new Rectangle(0, top, railW, Math.Max(0, Height - top)));
                using (GraphicsPath gp = new GraphicsPath())
                {
                    gp.AddEllipse(-railW * 0.35f, top - railW * 0.45f, railW * 1.7f, railW * 1.5f);
                    using (PathGradientBrush pg = new PathGradientBrush(gp))
                    {
                        pg.CenterColor = Color.FromArgb(85, Ui.Accent);
                        pg.SurroundColors = new Color[] { Color.FromArgb(0, Ui.Accent) };
                        g.FillPath(pg, gp);
                    }
                }
                g.ResetClip();

                g.DrawLine(lp, railW, top, railW, Height);
                g.DrawLine(lp, 0, top - 1, Width, top - 1);
            }
        }
    }

    internal class MainForm : Form
    {
        private readonly InstallList list;
        private readonly LogView logView;
        private readonly BusyBar busyBar;
        private readonly FlatButton installButton;
        private readonly FlatButton installSettingsButton;
        private readonly FlatButton uninstallButton;
        private readonly FlatButton refreshButton;
        private readonly FlatButton browseButton;
        private readonly ToggleSwitch closeBox;
        private readonly ToggleSwitch resetBox;
        private readonly ToggleSwitch wipeBox;
        private readonly Label statusLabel;
        private readonly System.Windows.Forms.Timer fadeTimer = new System.Windows.Forms.Timer();
        private readonly List<DiscordInstall> customInstalls = new List<DiscordInstall>();
        private readonly bool drawOwnBorder;
        private bool busy;
        private float scale = 1f;

        // Options are read on the UI thread and handed to the worker as a snapshot.
        private sealed class RunOptions
        {
            public bool CloseDiscord;
            public bool Reset;
            public bool Wipe;
        }

        private enum ActionKind
        {
            Install,
            InstallWithSettings,
            Uninstall
        }

        // Design coordinates (96 dpi) -> device pixels. We scale ourselves because
        // AutoScale does not reach controls nested inside the custom Surface panel.
        private int S(int v)
        {
            return (int)Math.Round(v * scale);
        }

        public MainForm()
        {
            using (Graphics sg = Graphics.FromHwnd(IntPtr.Zero))
            {
                scale = sg.DpiX / 96f;
            }
            if (scale < 1f)
                scale = 1f;

            Text = "VencordMe Setup";
            FormBorderStyle = FormBorderStyle.None;
            AutoScaleMode = AutoScaleMode.None;
            ClientSize = new Size(S(780), S(620));
            MinimumSize = new Size(S(720), S(560));
            StartPosition = FormStartPosition.CenterScreen;
            Font = Ui.Body;
            BackColor = Ui.Bg;
            Padding = new Padding(S(5));
            ResizeRedraw = true;
            Opacity = 0;
            drawOwnBorder = Environment.OSVersion.Version.Build < 22000;

            Surface root = new Surface();
            root.Dock = DockStyle.Fill;
            Controls.Add(root);

            // ---- title bar (root is 770 x 610 design px) ----
            TitleBar bar = new TitleBar();
            bar.Text = "VencordMe Setup";
            bar.Location = new Point(0, 0);
            bar.Size = new Size(S(678), S(Ui.TitleH - 1));
            bar.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            root.Controls.Add(bar);

            CaptionButton minBtn = new CaptionButton();
            minBtn.Kind = CapKind.Minimize;
            minBtn.AccessibleName = "Minimize";
            minBtn.Location = new Point(S(678), 0);
            minBtn.Size = new Size(S(46), S(Ui.TitleH - 1));
            minBtn.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            minBtn.Click += delegate { WindowState = FormWindowState.Minimized; };
            root.Controls.Add(minBtn);

            CaptionButton closeBtn = new CaptionButton();
            closeBtn.Kind = CapKind.Close;
            closeBtn.AccessibleName = "Close";
            closeBtn.Location = new Point(S(724), 0);
            closeBtn.Size = new Size(S(46), S(Ui.TitleH - 1));
            closeBtn.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            closeBtn.Click += delegate { Close(); };
            root.Controls.Add(closeBtn);

            // ---- rail ----
            Logo logo = new Logo();
            logo.Location = new Point(S(24), S(64));
            logo.Size = new Size(S(54), S(54));
            root.Controls.Add(logo);

            root.Controls.Add(MakeLabel("VencordMe", Ui.Big, Ui.Fg, Color.Transparent, 22, 128, 204, 38));
            root.Controls.Add(MakeLabel(
                "Installs the VencordMe client mod into your Discord. All plugins start disabled.",
                Ui.Body, Ui.Mute, Color.Transparent, 24, 174, 190, 100));

            statusLabel = MakeLabel("", Ui.Small, Ui.Mute, Color.Transparent, 24, 534, 190, 56);
            statusLabel.Anchor = AnchorStyles.Bottom | AnchorStyles.Left;
            statusLabel.TextAlign = ContentAlignment.BottomLeft;
            root.Controls.Add(statusLabel);

            // ---- pane: installations (content x = 256 .. 746) ----
            root.Controls.Add(MakeLabel("Detected Discord installations", Ui.BodyB, Ui.Fg, Ui.Bg, 256, 58, 300, 22));

            browseButton = MakeButton("Browse...", BtnKind.Ghost, 578, 53, 84, 30);
            browseButton.Font = Ui.Body;
            browseButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            browseButton.Click += delegate { Browse(); };
            root.Controls.Add(browseButton);

            refreshButton = MakeButton("Refresh", BtnKind.Ghost, 670, 53, 76, 30);
            refreshButton.Font = Ui.Body;
            refreshButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            refreshButton.Click += delegate { RefreshList(); };
            root.Controls.Add(refreshButton);

            list = new InstallList();
            list.Location = new Point(S(256), S(92));
            list.Size = new Size(S(490), S(150));
            list.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            root.Controls.Add(list);

            // ---- pane: options ----
            closeBox = MakeToggle("Close Discord automatically while installing", true, 258);
            resetBox = MakeToggle("Overwrite settings with the defaults (all plugins disabled)", false, 290);
            wipeBox = MakeToggle("Also delete the VencordMe data folder when uninstalling", false, 322);
            root.Controls.Add(closeBox);
            root.Controls.Add(resetBox);
            root.Controls.Add(wipeBox);

            // ---- pane: actions ----
            installButton = MakeButton("Install", BtnKind.Primary, 256, 370, 120, 44);
            installButton.Click += delegate { Run(ActionKind.Install); };
            root.Controls.Add(installButton);

            installSettingsButton = MakeButton("Install + Settings", BtnKind.Secondary, 386, 370, 170, 44);
            installSettingsButton.Enabled = Payload.HasProfile;
            installSettingsButton.Click += delegate { Run(ActionKind.InstallWithSettings); };
            root.Controls.Add(installSettingsButton);

            uninstallButton = MakeButton("Uninstall", BtnKind.Danger, 626, 370, 120, 44);
            uninstallButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            uninstallButton.Click += delegate { Run(ActionKind.Uninstall); };
            root.Controls.Add(uninstallButton);

            Label profileHint = MakeLabel(
                Payload.HasProfile
                    ? "\"Install\" = everything disabled.  \"Install + Settings\" = the bundled profile with pnygo off."
                    : "\"Install\" = every plugin starts disabled.",
                Ui.Small, Ui.Mute, Ui.Bg, 256, 422, 490, 34);
            profileHint.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            root.Controls.Add(profileHint);

            Label targetHint = MakeLabel(
                "No card highlighted = ALL listed installs will be patched. Click a card to target ONLY that one.",
                Ui.Small, Ui.Warn, Ui.Bg, 256, 448, 490, 20);
            targetHint.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            root.Controls.Add(targetHint);

            // ---- pane: log ----
            busyBar = new BusyBar();
            busyBar.Location = new Point(S(256), S(462));
            busyBar.Size = new Size(S(490), Math.Max(3, S(3)));
            busyBar.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            root.Controls.Add(busyBar);

            logView = new LogView();
            logView.Location = new Point(S(256), S(474));
            logView.Size = new Size(S(490), S(118));
            logView.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
            ContextMenuStrip menu = new ContextMenuStrip();
            ToolStripMenuItem copy = new ToolStripMenuItem("Copy log");
            copy.Click += delegate
            {
                string all = logView.AllText();
                if (all.Length == 0)
                    return;
                try { Clipboard.SetText(all); }
                catch (Exception) { }
            };
            menu.Items.Add(copy);
            logView.ContextMenuStrip = menu;
            root.Controls.Add(logView);

            fadeTimer.Interval = 15;
            fadeTimer.Tick += delegate
            {
                double next = Opacity + 0.09;
                if (next >= 1.0)
                {
                    Opacity = 1.0;
                    fadeTimer.Stop();
                }
                else
                {
                    Opacity = next;
                }
            };

            Shown += delegate
            {
                RefreshList();
                fadeTimer.Start();
            };
        }

        // ---------- small factory helpers (design px in, device px out) ----------

        private Label MakeLabel(string text, Font font, Color color, Color back,
            int x, int y, int w, int h)
        {
            Label l = new Label();
            l.Text = text;
            l.Font = font;
            l.ForeColor = color;
            l.BackColor = back;
            l.AutoSize = false;
            l.UseMnemonic = false;
            l.Location = new Point(S(x), S(y));
            l.Size = new Size(S(w), S(h));
            return l;
        }

        private FlatButton MakeButton(string text, BtnKind kind, int x, int y, int w, int h)
        {
            FlatButton b = new FlatButton();
            b.Text = text;
            b.Kind = kind;
            b.Location = new Point(S(x), S(y));
            b.Size = new Size(S(w), S(h));
            return b;
        }

        private ToggleSwitch MakeToggle(string text, bool on, int y)
        {
            ToggleSwitch t = new ToggleSwitch();
            t.Text = text;
            t.Checked = on;
            t.Location = new Point(S(256), S(y));
            t.Size = new Size(S(490), S(28));
            t.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            return t;
        }

        // ---------- window chrome ----------

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.Style |= 0x00020000;      // WS_MINIMIZEBOX: taskbar minimize / restore
                cp.ClassStyle |= 0x00020000; // CS_DROPSHADOW
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try
            {
                int round = 2;          // DWMWCP_ROUND (Windows 11)
                Native.DwmSetWindowAttribute(Handle, 33, ref round, 4);
                int border = 0x322623;  // COLORREF of Ui.Line
                Native.DwmSetWindowAttribute(Handle, 34, ref border, 4);
            }
            catch (Exception)
            {
                // Older Windows: no DWM attributes, plain square window.
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            if (drawOwnBorder)
            {
                using (Pen pen = new Pen(Ui.Line, 1f))
                {
                    e.Graphics.DrawRectangle(pen, 0, 0, Width - 1, Height - 1);
                }
            }
        }

        // Resize grips: the padding strip around the content belongs to the form itself.
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == 0x84 && WindowState == FormWindowState.Normal) // WM_NCHITTEST
            {
                int lp = unchecked((int)m.LParam.ToInt64());
                int x = (short)(lp & 0xFFFF);
                int y = (short)((lp >> 16) & 0xFFFF);
                Point p = PointToClient(new Point(x, y));
                int grip = Math.Max(6, S(6));

                bool left = p.X < grip;
                bool right = p.X >= ClientSize.Width - grip;
                bool top = p.Y < grip;
                bool bottom = p.Y >= ClientSize.Height - grip;

                int hit = 0;
                if (top && left) hit = 13;
                else if (top && right) hit = 14;
                else if (bottom && left) hit = 16;
                else if (bottom && right) hit = 17;
                else if (left) hit = 10;
                else if (right) hit = 11;
                else if (top) hit = 12;
                else if (bottom) hit = 15;

                if (hit != 0)
                {
                    m.Result = (IntPtr)hit;
                    return;
                }
            }
            base.WndProc(ref m);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
                fadeTimer.Dispose();
            base.Dispose(disposing);
        }

        // The wheel goes to the focused control by default; send it to whatever the pointer is over.
        protected override void OnMouseWheel(MouseEventArgs e)
        {
            base.OnMouseWheel(e);
            Point p = Cursor.Position;
            if (logView.RectangleToScreen(logView.ClientRectangle).Contains(p))
                logView.ScrollBy(e.Delta);
            else if (list.RectangleToScreen(list.ClientRectangle).Contains(p))
                list.ScrollBy(e.Delta);
        }

        // ---------- thread-safe UI helpers ----------

        private void SetStatus(string text)
        {
            if (IsDisposed)
                return;
            if (InvokeRequired)
            {
                if (!IsHandleCreated)
                    return;
                try { BeginInvoke(new Action<string>(SetStatus), text); }
                catch (ObjectDisposedException) { }
                catch (InvalidOperationException) { }
                return;
            }
            statusLabel.Text = text;
        }

        private void Log(string message)
        {
            if (IsDisposed)
                return;
            if (InvokeRequired)
            {
                if (!IsHandleCreated)
                    return;
                try { BeginInvoke(new Action<string>(Log), message); }
                catch (ObjectDisposedException) { }
                catch (InvalidOperationException) { }
                return;
            }
            logView.Append(message);
        }

        // ---------- behavior (same rules as before) ----------

        // Everything Detect() found plus any folder the user picked with Browse...
        private List<DiscordInstall> MergeDetect()
        {
            List<DiscordInstall> all = Discord.Detect();
            foreach (DiscordInstall c in customInstalls)
            {
                bool dup = false;
                foreach (DiscordInstall d in all)
                {
                    if (string.Equals(d.ResourcesDir, c.ResourcesDir, StringComparison.OrdinalIgnoreCase))
                    {
                        dup = true;
                        break;
                    }
                }
                if (!dup)
                {
                    all.Add(c);
                }
            }
            return all;
        }

        // The selected card; everything on the list when nothing is selected.
        private List<DiscordInstall> TargetList()
        {
            DiscordInstall sel = list.Selected;
            if (sel != null)
            {
                List<DiscordInstall> one = new List<DiscordInstall>();
                one.Add(sel);
                return one;
            }
            return MergeDetect();
        }

        private void Browse()
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = "Select your Discord installation: the app-x.y.z folder, its resources folder, or the folder that contains them.";
                dialog.ShowNewFolderButton = false;
                if (dialog.ShowDialog(this) != DialogResult.OK)
                    return;

                DiscordInstall d = Discord.FromPath(dialog.SelectedPath);
                if (d == null)
                {
                    MessageBox.Show(
                        "No Discord installation was found in:\r\n\r\n" + dialog.SelectedPath +
                        "\r\n\r\nPick the folder that contains app.asar (…\\app-1.0.x\\resources).",
                        "VencordMe Setup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }

                bool known = false;
                foreach (DiscordInstall existing in customInstalls)
                {
                    if (string.Equals(existing.ResourcesDir, d.ResourcesDir, StringComparison.OrdinalIgnoreCase))
                    {
                        known = true;
                        break;
                    }
                }
                if (!known)
                    customInstalls.Add(d);

                Log("Added " + d.Branch + " " + d.Version + ": " + d.ResourcesDir);
                RefreshList(d.ResourcesDir);
            }
        }

        private void RefreshList()
        {
            RefreshList(null);
        }

        private void RefreshList(string selectResourcesDir)
        {
            List<DiscordInstall> found = MergeDetect();
            list.SetItems(found, selectResourcesDir);

            if (found.Count == 0)
            {
                SetStatus("No Discord installation found - use Browse... to pick one.");
            }
            else
            {
                SetStatus(found.Count + " installation(s) listed. Select one to install only there.");
            }
        }

        private void Run(ActionKind kind)
        {
            if (busy)
                return;

            List<DiscordInstall> installs = TargetList();
            if (installs.Count == 0)
            {
                MessageBox.Show(
                    "No Discord installation was found.\r\n\r\nInstall Discord first, then run this setup again - or use Browse... to point at your copy.",
                    "VencordMe Setup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            string verb = kind == ActionKind.Uninstall ? "uninstall" : "install";
            if (!list.HasSelection && installs.Count > 1)
            {
                DialogResult r = MessageBox.Show(
                    "No installation is selected.\r\n\r\nThe action will be applied to ALL " + installs.Count +
                    " listed installations.\r\n\r\nContinue?",
                    "VencordMe Setup", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (r != DialogResult.Yes)
                    return;
            }
            if (closeBox.Checked && Discord.IsRunning(installs))
            {
                DialogResult r = MessageBox.Show(
                    "Discord is currently running.\r\n\r\nVencordMe needs it closed before it can " + verb + ".\r\n\r\nClose Discord now?",
                    "VencordMe Setup", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (r != DialogResult.Yes)
                {
                    Log("Aborted: Discord must be closed.");
                    return;
                }
            }

            RunOptions opts = new RunOptions();
            opts.CloseDiscord = closeBox.Checked;
            opts.Reset = resetBox.Checked;
            opts.Wipe = wipeBox.Checked;

            busy = true;
            installButton.Enabled = false;
            installSettingsButton.Enabled = false;
            uninstallButton.Enabled = false;
            refreshButton.Enabled = false;
            busyBar.Active = true;
            SetStatus("Working...");

            Thread worker = new Thread(delegate()
            {
                try
                {
                    Do(kind, installs, opts);
                }
                catch (Exception ex)
                {
                    Log("FAILED: " + ex.Message);
                }
                finally
                {
                    if (!IsDisposed && IsHandleCreated)
                    {
                        try
                        {
                            BeginInvoke((MethodInvoker)delegate
                            {
                                busy = false;
                                installButton.Enabled = true;
                                installSettingsButton.Enabled = Payload.HasProfile;
                                uninstallButton.Enabled = true;
                                refreshButton.Enabled = true;
                                busyBar.Active = false;
                                RefreshList();
                            });
                        }
                        catch (ObjectDisposedException) { }
                        catch (InvalidOperationException) { }
                    }
                }
            });
            worker.IsBackground = true;
            worker.Start();
        }

        private void Do(ActionKind kind, List<DiscordInstall> installs, RunOptions opts)
        {
            if (opts.CloseDiscord)
                Discord.Close(installs, Log);

            if (kind == ActionKind.Install || kind == ActionKind.InstallWithSettings)
            {
                bool withProfile = kind == ActionKind.InstallWithSettings;

                Log(withProfile ? "== Installing VencordMe + settings profile ==" : "== Installing VencordMe ==");
                Log("Data folder: " + Payload.DataDir);
                Payload.Extract(opts.Reset, withProfile, Log);

                int ok = 0;
                foreach (DiscordInstall d in installs)
                {
                    Log(d.Branch + " " + d.Version + ":");
                    try
                    {
                        Discord.InstallOne(d, Log);
                        ok++;
                    }
                    catch (Exception ex)
                    {
                        Log("  FAILED: " + ex.Message);
                    }
                }

                Log("");
                Log("Done: " + ok + " of " + installs.Count + " installation(s) patched.");
                if (withProfile)
                    Log("Your settings profile was applied - pnygo stays disabled, everything else as configured.");
                else
                    Log("Start Discord, open Settings > Vencord and enable the plugins you want.");

                SetStatus("Installed on " + ok + " of " + installs.Count + " installation(s).");

                // Launch the branch we actually patched, not whatever came first.
                if (ok > 0 && !IsDisposed && IsHandleCreated)
                {
                    DiscordInstall firstPatched = null;
                    for (int i = 0; i < installs.Count; i++)
                    {
                        if (installs[i].IsOurs || installs[i].Status == "Patched")
                        {
                            firstPatched = installs[i];
                            break;
                        }
                    }
                    DiscordInstall launchTarget = firstPatched ?? installs[0];
                    BeginInvoke((MethodInvoker)delegate
                    {
                        DialogResult r = MessageBox.Show(
                            "VencordMe was installed successfully.\r\n\r\nStart " + launchTarget.Branch + " now?",
                            "VencordMe Setup", MessageBoxButtons.YesNo, MessageBoxIcon.Information);
                        if (r == DialogResult.Yes)
                            Discord.Launch(launchTarget);
                    });
                }
            }
            else
            {
                Log("== Uninstalling VencordMe ==");
                int ok = 0;
                foreach (DiscordInstall d in installs)
                {
                    Log(d.Branch + " " + d.Version + ":");
                    try
                    {
                        Discord.UninstallOne(d, Log);
                        ok++;
                    }
                    catch (Exception ex)
                    {
                        Log("  FAILED: " + ex.Message);
                    }
                }

                if (opts.Wipe)
                {
                    try
                    {
                        if (Directory.Exists(Payload.DataDir))
                        {
                            Directory.Delete(Payload.DataDir, true);
                            Log("Deleted " + Payload.DataDir);
                        }
                    }
                    catch (Exception ex)
                    {
                        Log("Could not delete data folder: " + ex.Message);
                    }
                }
                else
                {
                    Log("Your VencordMe data is still in " + Payload.DataDir);
                }

                Log("");
                Log("Done: " + ok + " of " + installs.Count + " installation(s) restored.");
                SetStatus("Uninstalled from " + ok + " of " + installs.Count + " installation(s).");

                if (!IsDisposed && IsHandleCreated)
                {
                    BeginInvoke((MethodInvoker)delegate
                    {
                        MessageBox.Show(
                            "VencordMe was uninstalled. Discord is back to its original state.",
                            "VencordMe Setup", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    });
                }
            }
        }
    }
}
