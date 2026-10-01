using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;

namespace LanControl;

/// <summary>
/// 创建 Windows 快捷方式（.lnk）。
/// 之前用 VBScript + cscript 创建，在部分环境下会被安全策略拦截而静默失败，
/// 这里改为直接调用 COM 的 IShellLink，可靠得多，且能显式设置工作目录。
/// </summary>
[SupportedOSPlatform("windows")]
internal static class Shortcut
{
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLinkCoClass { }

    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, int fFlags);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
        void GetHotkey(out short pwHotkey);
        void SetHotkey(short wHotkey);
        void GetShowCmd(out int piShowCmd);
        void SetShowCmd(int iShowCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, int dwReserved);
        void Resolve(IntPtr hwnd, int fFlags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }

    [ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPersistFile
    {
        void GetClassID(out Guid pClassID);
        void IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, int dwMode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, bool fRemember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
    }

    /// <summary>创建一个 .lnk。返回 null 表示成功，否则返回错误信息。</summary>
    public static string? Create(string lnkPath, string targetExe, string arguments, string workingDir, string description)
    {
        object? link = null;
        try
        {
            var dir = Path.GetDirectoryName(lnkPath);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

            link = new ShellLinkCoClass();
            var shellLink = (IShellLinkW)link;
            shellLink.SetPath(targetExe);
            if (!string.IsNullOrEmpty(arguments)) shellLink.SetArguments(arguments);
            shellLink.SetWorkingDirectory(workingDir);
            if (!string.IsNullOrEmpty(description)) shellLink.SetDescription(description);
            shellLink.SetIconLocation(targetExe, 0);
            ((IPersistFile)link).Save(lnkPath, true);
            return File.Exists(lnkPath) ? null : "保存后文件不存在";
        }
        catch (Exception ex)
        {
            return ex.Message;
        }
        finally
        {
            if (link != null)
            {
                try { Marshal.ReleaseComObject(link); } catch { }
            }
        }
    }

    /// <summary>读取 .lnk 的目标路径与参数（用于自检/诊断）。</summary>
    public static (string target, string args, string workdir) Read(string lnkPath)
    {
        object? link = null;
        try
        {
            link = new ShellLinkCoClass();
            ((IPersistFile)link).Load(lnkPath, 0);
            var shellLink = (IShellLinkW)link;
            var sbTarget = new StringBuilder(1024);
            shellLink.GetPath(sbTarget, sbTarget.Capacity, IntPtr.Zero, 0);
            var sbArgs = new StringBuilder(1024);
            shellLink.GetArguments(sbArgs, sbArgs.Capacity);
            var sbDir = new StringBuilder(1024);
            shellLink.GetWorkingDirectory(sbDir, sbDir.Capacity);
            return (sbTarget.ToString(), sbArgs.ToString(), sbDir.ToString());
        }
        catch
        {
            return ("", "", "");
        }
        finally
        {
            if (link != null)
            {
                try { Marshal.ReleaseComObject(link); } catch { }
            }
        }
    }

    /// <summary>所有可能放快捷方式的位置（当前用户 + 公共）。</summary>
    public static IEnumerable<string> ShortcutFolders()
    {
        var list = new List<string>();
        void Add(string? p)
        {
            if (!string.IsNullOrWhiteSpace(p) && Directory.Exists(p)) list.Add(p!);
        }
        Add(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory));
        Add(Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory));
        Add(Environment.GetFolderPath(Environment.SpecialFolder.Programs));
        Add(Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms));
        try
        {
            Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                @"Microsoft\Internet Explorer\Quick Launch"));
        }
        catch { }
        return list;
    }

    /// <summary>
    /// 删除所有"指向我们的程序"的快捷方式 —— 按目标解析判断，而不是猜文件名。
    /// 返回被删除的完整路径列表。
    /// </summary>
    /// <summary>
    /// 只查找、不删除：返回所有指向本程序的快捷方式及其目标。
    /// 匹配依据是解析出的目标（可执行文件名或工作目录），不靠快捷方式的名字。
    /// </summary>
    public static List<(string lnk, string target)> FindShortcutsPointingTo(string exeName, string installDir)
    {
        var found = new List<(string, string)>();
        if (!exeName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) exeName += ".exe";
        foreach (var folder in ShortcutFolders())
        {
            IEnumerable<string> files;
            try { files = Directory.EnumerateFiles(folder, "*.lnk", SearchOption.AllDirectories); }
            catch { continue; }
            foreach (var lnk in files)
            {
                try
                {
                    var (target, _, workdir) = Read(lnk);
                    bool match = false;
                    if (!string.IsNullOrEmpty(target) &&
                        Path.GetFileName(target).Equals(exeName, StringComparison.OrdinalIgnoreCase))
                        match = true;
                    if (!match && !string.IsNullOrEmpty(workdir) && !string.IsNullOrEmpty(installDir) &&
                        workdir.TrimEnd('\\').Equals(installDir.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                        match = true;
                    if (match) found.Add((lnk, target));
                }
                catch { }
            }
        }
        return found;
    }

    public static List<string> RemoveShortcutsPointingTo(string exePath, string installDir)
    {
        var removed = new List<string>();
        string exeName = Path.GetFileName(exePath);
        foreach (var folder in ShortcutFolders())
        {
            IEnumerable<string> files;
            try { files = Directory.EnumerateFiles(folder, "*.lnk", SearchOption.AllDirectories); }
            catch { continue; }
            foreach (var lnk in files)
            {
                try
                {
                    var (target, args, workdir) = Read(lnk);
                    bool match = false;
                    if (!string.IsNullOrEmpty(target))
                    {
                        if (target.Equals(exePath, StringComparison.OrdinalIgnoreCase)) match = true;
                        else if (Path.GetFileName(target).Equals(exeName, StringComparison.OrdinalIgnoreCase)) match = true;
                    }
                    if (!match && !string.IsNullOrEmpty(workdir) && !string.IsNullOrEmpty(installDir))
                    {
                        if (workdir.TrimEnd('\\').Equals(installDir.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                            match = true;
                    }
                    if (match)
                    {
                        File.Delete(lnk);
                        removed.Add(lnk);
                    }
                }
                catch { }
            }
        }
        return removed;
    }
}
