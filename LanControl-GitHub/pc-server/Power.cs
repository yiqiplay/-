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
                Run("taskmgr.exe", "");
                return "已打开任务管理器";

            default:
                return "未知的电源操作: " + action;
        }
    }

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

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
