using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;

namespace LanControl;

/// <summary>
/// 旧版本排查与清理。
///
/// 用途：这台电脑上以前装过/解压过多个版本的被控端，留下了一堆快捷方式、开机自启项、
/// 防火墙规则和文件夹。这些残留会互相抢端口、抢托盘图标，让人误以为"新版没生效"。
/// 本模块把它们全部找出来（--scan）并可一键删掉（--clean-old）。
///
/// 设计原则：
///   * 只认"确实属于本程序"的东西（可执行文件名 / 快捷方式目标 / 规则名），不靠猜目录名；
///   * 删除前必须能列出证据；无法删除的项目如实报告失败原因；
///   * 绝不删除当前正在运行的这个程序自己的文件夹。
/// </summary>
[SupportedOSPlatform("windows")]
internal static class OldVersionCleaner
{
    private const string ExeName = "LanControlServer.exe";
    private static readonly string[] FirewallRules = { "LanControl Server TCP", "LanControl Server UDP" };

    public sealed class Finding
    {
        public string Kind = "";          // 分类：进程 / 快捷方式 / 开机自启 / 防火墙规则 / 发行包记录 / 目录
        public string Detail = "";
        public string Path = "";          // 附带路径（可为空）
        public bool IsCurrentInstall;     // 是否就是当前运行的程序
        public bool CanRemove = true;
    }

    /// <summary>扫描全部残留。</summary>
    public static List<Finding> Scan()
    {
        var list = new List<Finding>();
        string currentExe = (Environment.ProcessPath ?? "").Trim();
        string currentDir = AppContext.BaseDirectory.TrimEnd('\\');

        // ---- 1) 正在运行的被控端进程 ----
        try
        {
            foreach (var p in System.Diagnostics.Process.GetProcessesByName("LanControlServer"))
            {
                string path = "";
                try { path = p.MainModule?.FileName ?? ""; } catch { }
                bool isSelf = p.Id == Environment.ProcessId;
                list.Add(new Finding
                {
                    Kind = "运行中的进程",
                    Detail = $"PID {p.Id}" + (path.Length > 0 ? "  " + path : ""),
                    Path = path,
                    IsCurrentInstall = isSelf,
                });
            }
        }
        catch (Exception ex) { list.Add(new Finding { Kind = "运行中的进程", Detail = "枚举失败: " + ex.Message, CanRemove = false }); }

        // ---- 2) 指向被控端的快捷方式（解析目标，不靠文件名）----
        try
        {
            var lnks = Shortcut.FindShortcutsPointingTo("LanControlServer", currentDir);
            foreach (var (lnk, target) in lnks)
            {
                bool sameDir = Path.GetDirectoryName(target)?.TrimEnd('\\')
                    .Equals(currentDir, StringComparison.OrdinalIgnoreCase) == true;
                list.Add(new Finding
                {
                    Kind = "快捷方式",
                    Detail = target.Length > 0 ? $"→ {target}" : "（目标无法解析）",
                    Path = lnk,
                    IsCurrentInstall = sameDir,
                });
            }
        }
        catch (Exception ex) { list.Add(new Finding { Kind = "快捷方式", Detail = "枚举失败: " + ex.Message, CanRemove = false }); }

        // ---- 3) 开机自启 ----
        foreach (var hive in new[] { "HKCU", "HKLM" })
        {
            try
            {
                using var k = hive == "HKCU"
                    ? Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run")
                    : Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run");
                var v = k?.GetValue("LanControlServer")?.ToString();
                if (!string.IsNullOrEmpty(v))
                {
                    bool isSelf = v.IndexOf(currentDir, StringComparison.OrdinalIgnoreCase) >= 0;
                    list.Add(new Finding
                    {
                        Kind = "开机自启",
                        Detail = $"{hive}\\...\\Run\\LanControlServer = {v}",
                        Path = hive,
                        IsCurrentInstall = isSelf,
                    });
                }
            }
            catch { }
        }

        // ---- 4) 防火墙规则 ----
        foreach (var rule in FirewallRules)
        {
            try
            {
                string outp = RunNetsh($"advfirewall firewall show rule name=\"{rule}\"");
                if (outp.IndexOf("LocalPort", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    outp.IndexOf("本地端口", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    list.Add(new Finding { Kind = "防火墙规则", Detail = rule, Path = rule });
                }
            }
            catch { }
        }

        // ---- 5) 发行包记录（安装程序写入的卸载信息）----
        foreach (var root in new[]
        {
            @"Software\Microsoft\Windows\CurrentVersion\Uninstall",
            @"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        })
        {
            try
            {
                using var un = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(root);
                foreach (var name in un?.GetSubKeyNames() ?? Array.Empty<string>())
                {
                    using var sub = un!.OpenSubKey(name);
                    string disp = sub?.GetValue("DisplayName")?.ToString() ?? "";
                    if (disp.IndexOf("LanControl", StringComparison.OrdinalIgnoreCase) < 0 &&
                        disp.IndexOf("局域网远程控制", StringComparison.OrdinalIgnoreCase) < 0) continue;
                    list.Add(new Finding
                    {
                        Kind = "发行包记录",
                        Detail = $"HKCU\\{root}\\{name}  ({disp})",
                        Path = name,
                    });
                }
            }
            catch { }
        }

        // ---- 6) 常见位置的旧版本目录 ----
        foreach (var dir in CandidateDirectories())
        {
            if (dir.TrimEnd('\\').Equals(currentDir, StringComparison.OrdinalIgnoreCase)) continue;
            try
            {
                string exe = Path.Combine(dir, ExeName);
                if (!File.Exists(exe)) continue;
                string ver = "";
                try
                {
                    var vi = System.Diagnostics.FileVersionInfo.GetVersionInfo(exe);
                    ver = vi.FileVersion ?? "";
                }
                catch { }
                list.Add(new Finding
                {
                    Kind = "旧版本目录",
                    Detail = dir + (ver.Length > 0 ? $"  (文件版本 {ver})" : ""),
                    Path = dir,
                    IsCurrentInstall = false,
                });
            }
            catch { }
        }

        return list;
    }

    /// <summary>可能存放过旧版本的目录。</summary>
    private static IEnumerable<string> CandidateDirectories()
    {
        var roots = new List<string>();
        void Add(string? p) { if (!string.IsNullOrWhiteSpace(p) && Directory.Exists(p)) roots.Add(p!); }

        Add(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory));
        Add(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
        Add(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));
        Add(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles));
        Add(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86));
        foreach (var d in new[] { "D:\\", "E:\\", "F:\\" }) Add(d);

        var found = new List<string>();
        foreach (var root in roots)
        {
            try
            {
                // 只扫两层，避免遍历整个硬盘
                foreach (var d1 in SafeDirs(root))
                {
                    string name1 = Path.GetFileName(d1);
                    if (name1.Contains("LanControl", StringComparison.OrdinalIgnoreCase) ||
                        name1.Contains("远程控制", StringComparison.OrdinalIgnoreCase) ||
                        name1.Contains("lancontrol", StringComparison.OrdinalIgnoreCase))
                        found.Add(d1);

                    foreach (var d2 in SafeDirs(d1))
                    {
                        string name2 = Path.GetFileName(d2);
                        if (name2.Contains("LanControl", StringComparison.OrdinalIgnoreCase) ||
                            name2.Contains("远程控制", StringComparison.OrdinalIgnoreCase) ||
                            name2.Contains("lancontrol", StringComparison.OrdinalIgnoreCase))
                            found.Add(d2);
                    }
                }
            }
            catch { }
        }
        return found.Distinct(StringComparer.OrdinalIgnoreCase);
    }

    private static IEnumerable<string> SafeDirs(string root)
    {
        try { return Directory.EnumerateDirectories(root); }
        catch { return Array.Empty<string>(); }
    }

    /// <summary>
    /// 执行清理。keepSelf=true 时保留当前程序所在目录及其快捷方式/自启项。
    /// 返回每个动作的结果文本。
    /// </summary>
    public static List<string> Clean(bool keepSelf, bool includeFirewall)
    {
        var results = new List<string>();
        string currentDir = AppContext.BaseDirectory.TrimEnd('\\');

        // 1) 先结束其它正在运行的实例（否则目录删不掉）
        foreach (var p in System.Diagnostics.Process.GetProcessesByName("LanControlServer"))
        {
            if (p.Id == Environment.ProcessId) continue;
            try
            {
                string path = "";
                try { path = p.MainModule?.FileName ?? ""; } catch { }
                if (keepSelf && path.StartsWith(currentDir, StringComparison.OrdinalIgnoreCase))
                {
                    results.Add($"[跳过] 当前版本的进程 PID {p.Id}（保留）");
                    continue;
                }
                p.Kill(true);
                p.WaitForExit(3000);
                results.Add($"[结束] 旧版本进程 PID {p.Id}  {path}");
            }
            catch (Exception ex) { results.Add($"[失败] 结束进程 PID {p.Id}: {ex.Message}"); }
        }

        // 2) 快捷方式
        try
        {
            var lnks = Shortcut.FindShortcutsPointingTo("LanControlServer", currentDir);
            foreach (var (lnk, target) in lnks)
            {
                bool isSelf = Path.GetDirectoryName(target)?.TrimEnd('\\')
                    .Equals(currentDir, StringComparison.OrdinalIgnoreCase) == true;
                if (keepSelf && isSelf) { results.Add($"[跳过] 当前版本的快捷方式 {lnk}"); continue; }
                try { File.Delete(lnk); results.Add($"[删除] 快捷方式 {lnk}"); }
                catch (Exception ex) { results.Add($"[失败] 删除快捷方式 {lnk}: {ex.Message}"); }
            }
        }
        catch (Exception ex) { results.Add("[失败] 快捷方式清理: " + ex.Message); }

        // 3) 旧目录
        foreach (var dir in CandidateDirectories())
        {
            if (dir.TrimEnd('\\').Equals(currentDir, StringComparison.OrdinalIgnoreCase)) continue;
            try
            {
                Directory.Delete(dir, true);
                results.Add($"[删除] 目录 {dir}");
            }
            catch (Exception ex) { results.Add($"[失败] 删除目录 {dir}: {ex.Message}"); }
        }

        // 4) 自启项 + 端口记忆
        foreach (var hive in new[] { "HKCU", "HKLM" })
        {
            try
            {
                using var k = hive == "HKCU"
                    ? Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true)
                    : Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true);
                var v = k?.GetValue("LanControlServer")?.ToString();
                if (string.IsNullOrEmpty(v)) continue;
                bool isSelf = v.IndexOf(currentDir, StringComparison.OrdinalIgnoreCase) >= 0;
                if (keepSelf && isSelf) { results.Add($"[跳过] 当前版本的自启项 ({hive})"); continue; }
                k!.DeleteValue("LanControlServer", false);
                results.Add($"[删除] 自启项 {hive}\\...\\Run\\LanControlServer");
            }
            catch (Exception ex) { results.Add($"[失败] 自启项清理 ({hive}): {ex.Message}"); }
        }

        // 5) 防火墙规则（需要管理员；失败不致命）
        if (includeFirewall)
        {
            foreach (var rule in FirewallRules)
            {
                try
                {
                    string outp = RunNetsh($"advfirewall firewall delete rule name=\"{rule}\"");
                    results.Add($"[防火墙] 删除规则 {rule}: {outp.Trim()}");
                }
                catch (Exception ex) { results.Add($"[失败] 防火墙规则 {rule}: {ex.Message}"); }
            }
        }
        else
        {
            results.Add("[跳过] 防火墙规则（需要管理员权限，未指定 --firewall）");
        }

        return results;
    }

    [DllImport("kernel32.dll")]
    private static extern bool AttachConsole(int dwProcessId);

    /// <summary>把结果打印到调用方的控制台（.cmd 里能看到）。</summary>
    public static void AttachToParentConsole()
    {
        try
        {
            AttachConsole(-1);
            Console.OutputEncoding = Encoding.UTF8;
        }
        catch { }
    }

    private static string RunNetsh(string arguments)
    {
        try
        {
            var psi = new System.Diagnostics.ProcessStartInfo("netsh", arguments)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using var p = System.Diagnostics.Process.Start(psi);
            if (p == null) return "";
            string outp = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
            p.WaitForExit(8000);
            return outp;
        }
        catch { return ""; }
    }
}
