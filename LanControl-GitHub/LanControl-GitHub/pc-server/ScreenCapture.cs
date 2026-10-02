using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace LanControl;

internal sealed record MonitorInfo(int Index, string Device, Rectangle Bounds, bool Primary, string Label);

/// <summary>屏幕采集：多显示器枚举 + 抓屏 + JPEG 压缩。</summary>
[SupportedOSPlatform("windows")]
internal sealed class ScreenCapture : IDisposable
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MONITORINFOEX
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    private delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data);

    [DllImport("user32.dll")]
    private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    private const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;

    public List<MonitorInfo> Monitors { get; private set; } = new();
    public Rectangle VirtualBounds { get; private set; }
    public int MonitorCount => Monitors.Count;

    private readonly ImageCodecInfo _jpegCodec;
    private readonly EncoderParameters _encoderParams;
    private long _currentQuality = -1;

    public ScreenCapture()
    {
        _jpegCodec = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
        _encoderParams = new EncoderParameters(1);
        _encoderParams.Param[0] = new EncoderParameter(Encoder.Quality, 70L);
        Refresh();
    }

    public void Refresh()
    {
        var list = new List<MonitorInfo>();
        try
        {
            EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr h, IntPtr hdc, ref RECT r, IntPtr d) =>
            {
                var info = new MONITORINFOEX { cbSize = Marshal.SizeOf<MONITORINFOEX>() };
                if (GetMonitorInfo(h, ref info))
                {
                    var bounds = Rectangle.FromLTRB(info.rcMonitor.Left, info.rcMonitor.Top, info.rcMonitor.Right, info.rcMonitor.Bottom);
                    bool primary = (info.dwFlags & 1) != 0;
                    int idx = list.Count;
                    list.Add(new MonitorInfo(idx, info.szDevice ?? $"DISPLAY{idx + 1}", bounds, primary,
                        $"{(primary ? "主显示器" : "显示器 " + (idx + 1))} {bounds.Width}×{bounds.Height}"));
                }
                return true;
            }, IntPtr.Zero);
        }
        catch { /* 无显示器环境（会话 0）时忽略 */ }

        if (list.Count == 0)
        {
            int w = Math.Max(GetSystemMetrics(SM_CXVIRTUALSCREEN), 1024);
            int h = Math.Max(GetSystemMetrics(SM_CYVIRTUALSCREEN), 768);
            list.Add(new MonitorInfo(0, "DISPLAY1", new Rectangle(0, 0, w, h), true, $"主显示器 {w}×{h}"));
        }
        Monitors = list;
        VirtualBounds = new Rectangle(
            GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN),
            Math.Max(GetSystemMetrics(SM_CXVIRTUALSCREEN), 1), Math.Max(GetSystemMetrics(SM_CYVIRTUALSCREEN), 1));
    }

    public MonitorInfo? GetMonitor(int index)
    {
        if (Monitors.Count == 0) Refresh();
        if (index < 0 || index >= Monitors.Count) index = 0;
        return Monitors.Count > 0 ? Monitors[index] : null;
    }

    /// <summary>抓取指定显示器画面，按 scale(0.1~1.0) 缩放，输出 JPEG 字节。</summary>
    public byte[]? CaptureJpeg(int monitorIndex, double scale, long quality, int maxWidth)
    {
        var mon = GetMonitor(monitorIndex);
        if (mon == null) return null;
        var src = mon.Bounds;
        if (src.Width <= 0 || src.Height <= 0) return null;

        int dstW = src.Width, dstH = src.Height;
        double s = Math.Clamp(scale, 0.1, 1.0);
        if (s < 0.999)
        {
            dstW = Math.Max(64, (int)Math.Round(src.Width * s));
            dstH = Math.Max(64, (int)Math.Round(src.Height * s));
        }
        if (maxWidth > 0 && dstW > maxWidth)
        {
            double k = (double)maxWidth / dstW;
            dstW = maxWidth;
            dstH = Math.Max(64, (int)Math.Round(dstH * k));
        }

        using var bmp = new Bitmap(dstW, dstH, PixelFormat.Format24bppRgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.InterpolationMode = InterpolationMode.Bilinear;
            g.PixelOffsetMode = PixelOffsetMode.HighSpeed;
            g.CompositingQuality = CompositingQuality.HighSpeed;
            g.CopyFromScreen(src.Left, src.Top, 0, 0, new Size(dstW, dstH), CopyPixelOperation.SourceCopy);
        }

        var q = (long)Math.Clamp(quality, 30, 92);
        if (q != _currentQuality)
        {
            _encoderParams.Param[0] = new EncoderParameter(Encoder.Quality, q);
            _currentQuality = q;
        }

        using var ms = new MemoryStream(256 * 1024);
        bmp.Save(ms, _jpegCodec, _encoderParams);
        return ms.ToArray();
    }

    /// <summary>取当前鼠标位置（绝对桌面坐标）。</summary>
    public Point CursorPosition() => InputInjector.CursorPosition();

    public void Dispose()
    {
        _encoderParams.Dispose();
        GC.SuppressFinalize(this);
    }
}
