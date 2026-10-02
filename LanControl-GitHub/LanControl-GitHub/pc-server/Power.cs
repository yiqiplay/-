using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace LanControl;

/// <summary>电源/会话控制（普通权限可用：关机/重启/睡眠/锁屏/注销）。</summary>
[SupportedOSPlatform("windows")]
internal static class Power
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool LockWorkStation();

    [DllImport("user32.dll")]
    private static extern bool ExitWindowsEx(uint uFlags, uint dwReason);

    [DllImport("powrprof.dll", SetLastError = true)]
    private static extern bool SetSuspendState(bool hibernate, bool forceCritical, bool disableWakeEvent);

    private const uint EWX_LOGOFF = 0x00000000;
    private const uint EWX_SHUTDOWN = 0x00000001;
    private const uint EWX_REBOOT = 0x00000002;
    private const uint EWX_POWEROFF = 0x00000008;
    private const uint EWX_FORCEIFHUNG = 0x00000010;

    public static string Execute(string action, int delaySeconds = 0)
    {
        delaySeconds = Math.Clamp(delaySeconds, 0, 600);
        switch (action)
        {
            case "lock":
                return LockWorkStation() ? "已锁定电脑" : "锁屏失败";

            case "sleep":
                ThreadPool.QueueUserWorkItem(_ =>
                {
                    Thread.Sleep(Math.Max(delaySeconds, 1) * 1000);
                    try { SetSuspendState(false, false, false); } catch { }
                });
                return delaySeconds > 0 ? $"将在 {delaySeconds} 秒后进入睡眠" : "即将进入睡眠";

            case "hibernate":
                ThreadPool.QueueUserWorkItem(_ =>
                {
                    Thread.Sleep(Math.Max(delaySeconds, 1) * 1000);
                    try { SetSuspendState(true, false, false); } catch { }
                });
                return "即将休眠";

            case "logoff":
                Run("shutdown.exe", $"/l /f" + (delaySeconds > 0 ? $" /t {delaySeconds}" : ""));
                return delaySeconds > 0 ? $"将在 {delaySeconds} 秒后注销" : "即将注销";

            case "restart":
                Run("shutdown.exe", $"/r /f /t {delaySeconds}" + (delaySeconds > 0 ? " /c \"来自手机的远程重启\"" : ""));
                return delaySeconds > 0 ? $"将在 {delaySeconds} 秒后重启" : "即将重启";

            case "shutdown":
                Run("shutdown.exe", $"/s /f /t {delaySeconds}" + (delaySeconds > 0 ? " /c \"来自手机的远程关机\"" : ""));
                return delaySeconds > 0 ? $"将在 {delaySeconds} 秒后关机" : "即将关机";

            case "cancel":
                Run("shutdown.exe", "/a");
                return "已取消计划中的关机/重启";

            case "monitoroff":
                SendMessage(0xFFFF, 0x0112, 0xF170, 2);
                return "已关闭显示器";

            case "screensaver":
                SendMessage(0xFFFF, 0x0112, 0xF140, 0);
                return "已启动屏幕保护";

            case "taskmgr":
                // 注意：这里**不能**用 Run() —— 它强制 CreateNoWindow + WindowStyle.Hidden，
                // 任务管理器会被启动成一个隐藏窗口，用户看着就是"点了没反应"（真实踩过）。
                // 必须用 UseShellExecute=true + Normal 窗口，让它真的显示出来。
                return LaunchVisible("taskmgr.exe", "");

            default:
                return "未知的电源操作: " + action;
        }
    }

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    /// <summary>
    /// 启动一个**需要用户看见窗口**的程序（例如任务管理器）。
    /// 与 Run() 的区别：不禁用窗口、不隐藏，并在 shell 失败时退回直接启动。
    /// </summary>
    private static string LaunchVisible(string exe, string args)
    {
        // ① 首选 shell 启动：与用户在"运行"里敲命令等价，能正确处理 UAC / 单实例
        try
        {
            Process.Start(new ProcessStartInfo(exe, args) { UseShellExecute = true });
            return "已打开" + Path.GetFileNameWithoutExtension(exe);
        }
        catch (Exception ex1)
        {
            Log.Warn($"shell 启动 {exe} 失败，改用直接启动: {ex1.Message}");
            // ② 退回直接启动（仍然显示窗口）
            try
            {
                string full = Path.Combine(Environment.SystemDirectory, exe);
                if (!File.Exists(full)) full = exe;
                Process.Start(new ProcessStartInfo(full, args)
                {
                    UseShellExecute = false,
                    CreateNoWindow = false,
                });
                return "已打开" + Path.GetFileNameWithoutExtension(exe);
            }
            catch (Exception ex2)
            {
                Log.Warn($"启动 {exe} 最终失败: {ex2.Message}");
                return "打开失败：" + ex2.Message;
            }
        }
    }

    private static void Run(string exe, string args)
    {
        try
        {
            Process.Start(new ProcessStartInfo(exe, args)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
            });
        }
        catch (Exception ex)
        {
            Log.Warn($"执行 {exe} {args} 失败: {ex.Message}");
        }
    }
}
