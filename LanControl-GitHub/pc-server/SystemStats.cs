using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace LanControl;

[SupportedOSPlatform("windows")]
internal static class SystemStats
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private class MEMORYSTATUSEX
    {
        public uint dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
        public uint dwMemoryLoad;
        public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GlobalMemoryStatusEx([In, Out] MEMORYSTATUSEX lpBuffer);

    [DllImport("kernel32.dll")]
    private static extern bool GetSystemTimes(out FILETIME idle, out FILETIME kernel, out FILETIME user);

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME { public uint dwLowDateTime, dwHighDateTime; }

    private static ulong _prevIdle, _prevKernel, _prevUser;
    private static double _lastCpu;

    /// <summary>返回 (CPU 使用率%, 已用内存 GB, 总内存 GB)。</summary>
    public static (double cpu, double memUsedGb, double memTotalGb) Snapshot()
    {
        double cpu = _lastCpu;
        try
        {
            if (GetSystemTimes(out var idle, out var kernel, out var user))
            {
                ulong i = ToUlong(idle), k = ToUlong(kernel), u = ToUlong(user);
                if (_prevKernel != 0 || _prevUser != 0)
                {
                    ulong idleDelta = i - _prevIdle;
                    ulong totalDelta = (k - _prevKernel) + (u - _prevUser);
                    if (totalDelta > 0) cpu = Math.Round(100.0 * (totalDelta - idleDelta) / totalDelta, 1);
                }
                _prevIdle = i; _prevKernel = k; _prevUser = u;
                _lastCpu = cpu;
            }
        }
        catch { }

        double used = 0, total = 0;
        try
        {
            var m = new MEMORYSTATUSEX();
            if (GlobalMemoryStatusEx(m))
            {
                total = Math.Round(m.ullTotalPhys / 1073741824.0, 1);
                used = Math.Round((m.ullTotalPhys - m.ullAvailPhys) / 1073741824.0, 1);
            }
        }
        catch { }
        return (cpu, used, total);
    }

    private static ulong ToUlong(FILETIME f) => ((ulong)f.dwHighDateTime << 32) | f.dwLowDateTime;
}
