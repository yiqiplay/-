using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace LanControl;

/// <summary>
/// 采集"电脑正在播放的声音"（系统音频）。
///
/// 为什么用 WASAPI loopback：本机实测**没有**"立体声混音 / Stereo Mix"这类回环录音
/// 设备，用 waveIn 只能录到麦克风。要拿到系统声音只有两条路：
///   1) 装虚拟声卡（如 VB-CABLE）再用 waveIn —— 要求用户额外装驱动；
///   2) WASAPI 回环采集（IAudioClient 在 Render 设备上以 Loopback 标志初始化）—— 免驱动。
/// 这里选方案 2，用纯 P/Invoke + 手写 COM 接口实现，不引入 NAudio 等第三方依赖
/// （构建环境无法访问 NuGet）。
///
/// 线程模型注意：本类所有实例都在**专用后台线程**里创建并使用（带 CoInitializeEx），
/// 因为 COM 接口指针有线程亲和性，跨线程调用会导致未定义行为。
/// 所有对外入口都做了异常兜底：采集失败只会让音频功能不可用，绝不影响画面控制。
/// </summary>
[SupportedOSPlatform("windows")]
internal static class SystemAudio
{
    // ---------------- 对外状态 ----------------
    public static bool Available { get; private set; }
    public static string Message { get; private set; } = "尚未检测";
    private static bool _probed;

    /// <summary>采集格式（16 位单声道 PCM）。手机端按这个格式播放。</summary>
    public static int OutSampleRate { get; set; } = 48000;   // 24 位/48 kHz = 1152 kbps（按需求设定）
    public const int OutChannels = 1;
    public const int OutBitsPerSample = 24;   // 24 位 PCM（每样本 3 字节，小端）

    /// <summary>
    /// 音频码率（kbps）。做成"码率"而不是只暴露采样率，是因为需求是按码率提的。
    /// 本实现发的是**未压缩 PCM**（16 位单声道），所以：
    ///     码率(kbps) = 采样率 × 1 × 2 × 8 / 1000
    ///   128 kbps => 8000 Hz（默认）
    ///   256 kbps => 16000 Hz
    ///   768 kbps => 48000 Hz（最高音质）
    /// </summary>
    public static int BitrateKbps { get; private set; } = 1152;   // 48000 × 3 字节 × 8 / 1000

    /// <summary>把目标码率换算成采样率（16 位单声道 PCM），并夹到常用档位。</summary>
    public static int SampleRateForBitrate(int kbps)
    {
        if (kbps <= 0) return 8000;
        int raw = kbps * 1000 / (OutChannels * (OutBitsPerSample / 8) * 8);
        int[] allowed = { 8000, 11025, 16000, 22050, 32000, 44100, 48000 };
        int best = allowed[0];
        foreach (var r in allowed)
            if (Math.Abs(r - raw) < Math.Abs(best - raw)) best = r;
        return best;
    }

    /// <summary>按码率设置输出格式（记录码率并换算采样率）。</summary>
    public static void SetBitrate(int kbps)
    {
        BitrateKbps = kbps > 0 ? kbps : 128;
        OutSampleRate = SampleRateForBitrate(BitrateKbps);
    }

    /// <summary>探测一次系统音频是否可采集（结果缓存）。</summary>
    public static void Probe()
    {
        if (_probed) return;
        _probed = true;
        try
        {
            string? err = null;
            using var cap = new LoopbackCapture();
            if (cap.Initialize(out err))
            {
                Available = true;
                Message = $"可采集系统声音（{cap.MixFormatDescription}）";
            }
            else
            {
                Available = false;
                Message = err ?? "无法初始化系统音频采集";
            }
        }
        catch (Exception ex)
        {
            Available = false;
            Message = "系统音频采集不可用：" + ex.Message;
        }
        Log.Info($"系统音频自检：{(Available ? "可用" : "不可用")} —— {Message}");
    }

    /// <summary>
    /// 采集一段时间，并把**本来要推送给手机的那份 PCM** 写成 WAV 文件。
    /// 用途：把"服务端采集/重采样是否正确"与"手机端播放是否正确"彻底分开判定 ——
    /// 如果这个 WAV 用播放器听起来正常，那杂音就出在手机端播放环节。
    /// </summary>
    public static string RecordToWav(string path, int seconds)
    {
        var sb = new System.Text.StringBuilder();
        try
        {
            using var cap = new LoopbackCapture();
            if (!cap.Initialize(out var err)) return "初始化失败: " + err + Environment.NewLine;
            sb.AppendLine("混音格式: " + cap.MixFormatDescription);

            int bytesPerSec = OutSampleRate * OutChannels * (OutBitsPerSample / 8);   // 24 位/48k = 144000 B/s
            var pcm = new List<byte>(bytesPerSec * Math.Max(1, seconds));
            cap.Start();
            var buf = new byte[Math.Max(320, bytesPerSec / 25)];   // 40ms
            var sw = System.Diagnostics.Stopwatch.StartNew();
            int blocks = 0, nonzeroBlocks = 0;
            while (sw.Elapsed.TotalSeconds < seconds)
            {
                int n = cap.Read(buf, 0, buf.Length);
                if (n <= 0) { Thread.Sleep(5); continue; }
                blocks++;
                bool nz = false;
                for (int i = 0; i < n; i++) if (buf[i] != 0) { nz = true; break; }
                if (nz) nonzeroBlocks++;
                pcm.AddRange(buf.AsSpan(0, n).ToArray());
            }
            cap.Stop();

            byte[] data = pcm.ToArray();
            using (var fs = new FileStream(path, FileMode.Create, FileAccess.Write))
            using (var bw = new BinaryWriter(fs))
            {
                short blockAlign = (short)(OutChannels * (OutBitsPerSample / 8));
                bw.Write(new[] { 'R', 'I', 'F', 'F' });
                bw.Write(36 + data.Length);
                bw.Write(new[] { 'W', 'A', 'V', 'E' });
                bw.Write(new[] { 'f', 'm', 't', ' ' });
                bw.Write(16);
                bw.Write((short)1);
                bw.Write((short)OutChannels);
                bw.Write(OutSampleRate);
                bw.Write(bytesPerSec);
                bw.Write(blockAlign);
                bw.Write((short)OutBitsPerSample);
                bw.Write(new[] { 'd', 'a', 't', 'a' });
                bw.Write(data.Length);
                bw.Write(data);
            }
            float peak = GetPeakValue();
            sb.AppendLine($"已写出: {path}");
            sb.AppendLine($"时长 {data.Length / (double)bytesPerSec:0.00}s / {data.Length} 字节 / {OutSampleRate} Hz 单声道 16 位");
            sb.AppendLine($"数据块: {blocks} 个（每个 40ms），其中非静音 {nonzeroBlocks} 个");
            sb.AppendLine($"设备音量峰值: {(peak < 0 ? "读不到" : peak.ToString("0.000"))}");
            sb.AppendLine(nonzeroBlocks == 0
                ? "=> 全是静音。电脑没有播放声音时回环采集不推数据包，这是 Windows 的正常行为。"
                : "=> 用播放器打开这个 wav 听听：若声音正常，说明服务端没问题，杂音出在手机端播放环节。");
        }
        catch (Exception ex) { sb.AppendLine("异常: " + ex.GetType().Name + ": " + ex.Message); }
        return sb.ToString();
    }

    /// <summary>快速自检（--audio-test 用）：报告设备与采集情况。</summary>
    public static string SelfTest(int seconds)
    {
        var sb = new System.Text.StringBuilder();
        try
        {
            sb.AppendLine("默认播放设备: " + (DefaultRenderName() ?? "(未找到)"));
            using var cap = new LoopbackCapture();
            if (!cap.Initialize(out var err))
            {
                sb.AppendLine("初始化失败: " + err);
                return sb.ToString();
            }
            sb.AppendLine("混音格式: " + cap.MixFormatDescription);
            sb.AppendLine("输出格式: " + OutSampleRate + " Hz / " + OutChannels + " 声道 / " + OutBitsPerSample + " 位");
            cap.Start();
            var buf = new byte[OutSampleRate * (OutBitsPerSample / 8)];
            int total = 0, nonzero = 0, reads = 0;
            var sw = System.Diagnostics.Stopwatch.StartNew();
            while (sw.Elapsed.TotalSeconds < seconds)
            {
                int n = cap.Read(buf, 0, buf.Length);
                if (n <= 0) { Thread.Sleep(10); continue; }
                reads++;
                total += n;
                for (int i = 0; i < n; i++) if (buf[i] != 0) { nonzero++; break; }
            }
            cap.Stop();
            float peak = GetPeakValue();
            sb.AppendLine($"采集 {seconds}s：读取 {reads} 次，共 {total} 字节");
            sb.AppendLine($"诊断：GetNextPacketSize 调用 {cap.DiagPacketQueries} 次，" +
                          $"有数据包 {cap.DiagPacketsSeen} 次，GetBuffer 失败 {cap.DiagGetBufferFails} 次，" +
                          $"累计帧 {cap.DiagFramesTotal}，最后 HRESULT 0x{cap.DiagLastHr:X8}");
            sb.AppendLine($"默认播放设备当前音量峰值：{(peak < 0 ? "读不到" : peak.ToString("0.000"))}");
            if (cap.DiagPacketsSeen == 0)
            {
                sb.AppendLine("说明：回环采集在**没有任何程序播放声音**时不会推送数据包（Windows 的正常行为），");
                sb.AppendLine("      所以 0 个数据包本身不代表功能异常。请在电脑上放一段音乐/视频再测一次。");
            }
            sb.AppendLine(nonzero > 0
                ? "=> 采集到音频数据（有非零样本）"
                : "=> 采集数据全为 0：电脑当前没有播放声音（正常的静音状态）");
        }
        catch (Exception ex)
        {
            sb.AppendLine("自检异常: " + ex.GetType().Name + ": " + ex.Message);
        }
        return sb.ToString();
    }

    // ================= WASAPI 回环采集实现 =================

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumerator { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        int GetDevice(string id, out IMMDevice device);
        int RegisterEndpointNotificationCallback(IntPtr client);
        int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        int Activate([In] ref Guid iid, int clsCtx, IntPtr activationParams,
                     [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        int OpenPropertyStore(int access, out IntPtr properties);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    [Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity,
                       IntPtr format, IntPtr sessionGuid);
        int GetBufferSize(out int frames);
        int GetStreamLatency(out long latency);
        int GetCurrentPadding(out int padding);
        int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        int GetMixFormat(out IntPtr format);
        int GetDevicePeriod(out long def, out long min);
        int Start();
        int Stop();
        int Reset();
        int SetEventHandle(IntPtr handle);
        int GetService([In] ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient
    {
        int GetBuffer(out IntPtr data, out int frames, out int flags, out long devPos, out long qpcPos);
        int ReleaseBuffer(int frames);
        int GetNextPacketSize(out int frames);
        int IsFormatSupported(IntPtr format);
    }

    [Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioMeterInformation
    {
        int GetPeakValue(out float peak);
        int GetMeteringChannelCount(out int count);
        int GetChannelsPeakValues(int count, [Out] float[] peaks);
        int QueryHardwareSupport(out int mask);
    }

    private const int AUDCLNT_SHAREMODE_SHARED = 0;
    private const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    private const int AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
    private const int AUDCLNT_BUFFERFLAGS_SILENT = 0x00000002;
    private const int eRender = 0;
    private const int eConsole = 0;
    private const int CLSCTX_ALL = 23;

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    private struct WAVEFORMATEX
    {
        public short wFormatTag;
        public short nChannels;
        public int nSamplesPerSec;
        public int nAvgBytesPerSec;
        public short nBlockAlign;
        public short wBitsPerSample;
        public short cbSize;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    private struct WAVEFORMATEXTENSIBLE
    {
        public WAVEFORMATEX Format;
        public short wValidBitsPerSample;
        public int dwChannelMask;
        public Guid SubFormat;
    }

    private const short WAVE_FORMAT_PCM = 1;
    private const short WAVE_FORMAT_IEEE_FLOAT = 3;
    private const short WAVE_FORMAT_EXTENSIBLE = unchecked((short)0xFFFE);

    /// <summary>采样数据的真实类型（决定如何解读缓冲区）。</summary>
    private enum SampleKind { Float32, Pcm16, Pcm32, Unknown }

    /// <summary>
    /// 判断混音格式里的样本到底是 32 位浮点还是 32 位整数。
    /// 这一步极易出错：共享模式下常见的 WAVE_FORMAT_EXTENSIBLE 必须看 SubFormat GUID，
    /// 只凭 wBitsPerSample==32 就当成 float 会把整数样本当成浮点解读 —— 结果就是满耳杂音。
    /// </summary>
    private static SampleKind ClassifyFormat(IntPtr fmt)
    {
        try
        {
            var wf = Marshal.PtrToStructure<WAVEFORMATEX>(fmt);
            short tag = wf.wFormatTag;
            if (tag == WAVE_FORMAT_EXTENSIBLE && wf.cbSize >= 22)
            {
                var ext = Marshal.PtrToStructure<WAVEFORMATEXTENSIBLE>(fmt);
                var g = ext.SubFormat;
                // KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = 00000003-0000-0010-8000-00aa00389b71
                // KSDATAFORMAT_SUBTYPE_PCM        = 00000001-0000-0010-8000-00aa00389b71
                var gb = g.ToByteArray();                       // Data1 小端在前 4 字节
                int data1 = gb[0] | (gb[1] << 8) | (gb[2] << 16) | (gb[3] << 24);
                if (data1 == 3) tag = WAVE_FORMAT_IEEE_FLOAT;
                else if (data1 == 1) tag = WAVE_FORMAT_PCM;
            }

            if (tag == WAVE_FORMAT_IEEE_FLOAT && wf.wBitsPerSample == 32) return SampleKind.Float32;
            if (tag == WAVE_FORMAT_PCM && wf.wBitsPerSample == 16) return SampleKind.Pcm16;
            if (tag == WAVE_FORMAT_PCM && wf.wBitsPerSample == 32) return SampleKind.Pcm32;
            // 兜底：按位宽猜（32 位绝大多数是 float）
            if (wf.wBitsPerSample == 32) return SampleKind.Float32;
            if (wf.wBitsPerSample == 16) return SampleKind.Pcm16;
            return SampleKind.Unknown;
        }
        catch { return SampleKind.Unknown; }
    }

    /// <summary>把混音格式描述成人话（自检与日志用）。</summary>
    private static string DescribeFormat(IntPtr fmt)
    {
        try
        {
            var wf = Marshal.PtrToStructure<WAVEFORMATEX>(fmt);
            short tag = wf.wFormatTag;
            string tagName = tag switch
            {
                WAVE_FORMAT_PCM => "PCM",
                WAVE_FORMAT_IEEE_FLOAT => "IEEE float",
                WAVE_FORMAT_EXTENSIBLE => "EXTENSIBLE",
                _ => "0x" + tag.ToString("X4"),
            };
            string sub = "";
            if (tag == WAVE_FORMAT_EXTENSIBLE && wf.cbSize >= 22)
            {
                var ext = Marshal.PtrToStructure<WAVEFORMATEXTENSIBLE>(fmt);
                var gb2 = ext.SubFormat.ToByteArray();
                int d1 = gb2[0] | (gb2[1] << 8) | (gb2[2] << 16) | (gb2[3] << 24);
                sub = $"，SubFormat.Data1={d1}";
            }
            var kind = ClassifyFormat(fmt);
            return $"{wf.nSamplesPerSec} Hz / {wf.nChannels} 声道 / {wf.wBitsPerSample} 位 / tag={tagName}{sub} => 按 {kind} 解读";
        }
        catch (Exception ex) { return "(格式解析失败: " + ex.Message + ")"; }
    }

    [DllImport("ole32.dll")]
    private static extern int CoInitializeEx(IntPtr reserved, int coInit);

    [DllImport("ole32.dll")]
    private static extern void CoUninitialize();

    private static string? DefaultRenderName()
    {
        try
        {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            if (enumerator.GetDefaultAudioEndpoint(eRender, eConsole, out var dev) != 0) return null;
            if (dev.GetId(out string id) != 0) return null;
            return id;
        }
        catch { return null; }
    }

    /// <summary>
    /// 读取默认播放设备当前的音量峰值（0~1）。
    /// 用途：WASAPI 回环在"没有任何程序在播放"时不会推送数据包（实测 315 次查询 0 个包），
    /// 因此不能用"收不到数据"来判断音频是否可用；音量表才是可靠判据。
    /// 返回 -1 表示读不到。
    /// </summary>
    public static float GetPeakValue()
    {
        IMMDeviceEnumerator? en = null;
        IMMDevice? dev = null;
        object? clientObj = null;
        object? meterObj = null;
        bool comInit = false;
        try
        {
            comInit = CoInitializeEx(IntPtr.Zero, 0) >= 0;
            en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            if (en.GetDefaultAudioEndpoint(eRender, eConsole, out var d) != 0 || d == null) return -1;
            dev = d;
            var acIid = typeof(IAudioClient).GUID;
            if (d.Activate(ref acIid, CLSCTX_ALL, IntPtr.Zero, out clientObj) != 0) return -1;
            if (clientObj is not IAudioClient client) return -1;
            var mIid = typeof(IAudioMeterInformation).GUID;
            if (client.GetService(ref mIid, out meterObj) != 0) return -1;
            if (meterObj is not IAudioMeterInformation meter) return -1;
            return meter.GetPeakValue(out float peak) == 0 ? peak : -1;
        }
        catch { return -1; }
        finally
        {
            try { if (meterObj != null) Marshal.ReleaseComObject(meterObj); } catch { }
            try { if (clientObj != null) Marshal.ReleaseComObject(clientObj); } catch { }
            try { if (dev != null) Marshal.ReleaseComObject(dev); } catch { }
            try { if (en != null) Marshal.ReleaseComObject(en); } catch { }
            if (comInit) { try { CoUninitialize(); } catch { } }
        }
    }

    /// <summary>一次回环采集会话。必须在使用它的同一个线程里创建与释放。</summary>
    private sealed class LoopbackCapture : IDisposable
    {
        private IMMDeviceEnumerator? _enumerator;
        private IMMDevice? _device;
        private IAudioClient? _client;
        private IAudioCaptureClient? _capture;
        private IntPtr _mixFormat = IntPtr.Zero;
        private bool _comInitialized;
        private int _srcChannels, _srcRate, _srcBits;
        private short _srcBlockAlign;
        private SampleKind _kind = SampleKind.Unknown;
        private bool _silentOnly;
        private int _diagLogged;
        private int _resampleLogged;
        private long _statBytes, _statCalls, _statFrames, _statStart;
        private float[] _reuse = Array.Empty<float>();

        // 本次采集会话的格式快照 —— 不能每次读静态字段：
        // 静态字段会在会话中途被改（例如手机端调整码率），而"帧头声明 / 缓冲区大小 /
        // 重采样比率"若各自读到不同时刻的值，就会产出"每秒样本数是声明值 2 倍"这类错乱
        // （实测 ratio 正好 2.005，表现为变调）。快照后整段会话只用同一组值。
        public int SnapRate { get; } = OutSampleRate;
        public int SnapBits { get; } = OutBitsPerSample;
        public int SnapChannels { get; } = OutChannels;

        public string MixFormatDescription { get; private set; } = "";
        public string OutputFormatDescription => $"{SnapRate} Hz 单声道 {SnapBits} 位";

        // 诊断计数（自检时报告，便于定位"收不到数据"的原因）
        public int DiagPacketQueries, DiagPacketsSeen, DiagGetBufferFails, DiagReleaseFails, DiagFramesTotal, DiagLastHr;

        public bool Initialize(out string? error)
        {
            error = null;
            try
            {
                // 每个采集会话独立初始化 COM
                int hr = CoInitializeEx(IntPtr.Zero, 0);   // COINIT_MULTITHREADED
                _comInitialized = hr >= 0;

                _enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
                hr = _enumerator.GetDefaultAudioEndpoint(eRender, eConsole, out var dev);
                if (hr != 0 || dev == null) { error = "没有默认播放设备（电脑当前没有可用的扬声器/耳机）"; return false; }
                _device = dev;

                var iid = typeof(IAudioClient).GUID;
                hr = dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out object clientObj);
                if (hr != 0 || clientObj is not IAudioClient client) { error = $"激活音频客户端失败 (0x{hr:X8})"; return false; }
                _client = client;

                hr = client.GetMixFormat(out _mixFormat);
                if (hr != 0 || _mixFormat == IntPtr.Zero) { error = $"读取混音格式失败 (0x{hr:X8})"; return false; }
                var wf = Marshal.PtrToStructure<WAVEFORMATEX>(_mixFormat);
                _srcChannels = Math.Max(1, (int)wf.nChannels);
                _srcRate = Math.Max(8000, wf.nSamplesPerSec);
                _srcBits = wf.wBitsPerSample;
                _kind = ClassifyFormat(_mixFormat);
                _srcBlockAlign = wf.nBlockAlign > 0 ? wf.nBlockAlign : (short)(_srcChannels * (_srcBits / 8));
                MixFormatDescription = DescribeFormat(_mixFormat);
                Log.Info("回环采集格式: " + MixFormatDescription);

                // 回环采集：SHARED 模式 + LOOPBACK 标志，周期必须为 0
                hr = client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
                                       10_000_000, 0, _mixFormat, IntPtr.Zero);
                if (hr != 0)
                {
                    error = $"初始化回环采集失败 (0x{hr:X8}) —— 可能是音频驱动不支持，或被安全软件拦截";
                    return false;
                }

                var capIid = typeof(IAudioCaptureClient).GUID;
                hr = client.GetService(ref capIid, out object capObj);
                if (hr != 0 || capObj is not IAudioCaptureClient cap) { error = $"获取采集接口失败 (0x{hr:X8})"; return false; }
                _capture = cap;
                return true;
            }
            catch (Exception ex)
            {
                error = ex.GetType().Name + ": " + ex.Message;
                return false;
            }
        }

        public void Start()
        {
            try { _client?.Start(); } catch { }
        }

        public void Stop()
        {
            try { _client?.Stop(); } catch { }
        }

        /// <summary>
        /// 读一帧并重采样为 16kHz 单声道 16 位 PCM，返回写入的字节数（0 表示本次没有数据）。
        /// </summary>
        public int Read(byte[] output, int offset, int count)
        {
            if (_capture == null) return 0;
            int written = 0;
            try
            {
                while (written + 2 <= count)
                {
                    DiagPacketQueries++;
                    int hr = _capture.GetNextPacketSize(out int packet);
                    if (hr != 0) { DiagLastHr = hr; break; }
                    if (packet == 0) break;
                    DiagPacketsSeen++;
                    hr = _capture.GetBuffer(out IntPtr data, out int frames, out int flags, out _, out _);
                    if (hr != 0) { DiagGetBufferFails++; DiagLastHr = hr; break; }
                    try
                    {
                        if (frames <= 0) continue;
                        DiagFramesTotal += frames;
                        _statFrames += frames;
                        var samples = ConvertToMono(data, frames, (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0);
                        // 必须显式传有效样本数 frames！
                        // ConvertToMono 返回的是**复用数组**（长度固定 4096），只有前 frames 个是本次数据。
                        // 早期代码让重采样器用 src.Length(=4096) 当输入长度，于是把上一次的旧数据
                        // 反复重采样 —— 实测每秒输出字节正好是应有值的 2 倍，听感就是变调。
                        written += ResampleTo16k(samples, frames, output, offset + written, count - written);
                    }
                    finally
                    {
                        if (_capture.ReleaseBuffer(frames) != 0) DiagReleaseFails++;
                    }
                }
            }
            catch { }
            // 每秒统计：直接看清"每秒返回多少字节/多少帧"，用于定位时长错乱
            _statBytes += written;
            _statCalls++;
            var now = Environment.TickCount64;
            if (_statStart == 0) _statStart = now;
            if (now - _statStart >= 1000)
            {
                double secs = (now - _statStart) / 1000.0;
                int bytesPerSec = (int)(_statBytes / secs);
                int expect = SnapRate * (SnapBits / 8) * SnapChannels;
                Log.Info($"[音频速率] 每秒 {bytesPerSec} 字节（应为 {expect}，比值 {(double)bytesPerSec / expect:0.###}），" +
                         $"{_statCalls} 次 Read，{_statFrames} 输入帧；" +
                         $"源 {_srcRate}Hz/{_srcChannels}ch，快照 {SnapRate}Hz/{SnapBits}位，比率 {(_srcRate / (double)SnapRate):0.###}，" +
                         $"每包 {(_statFrames / Math.Max(1, _statCalls)):0.#} 帧");
                _statBytes = 0; _statCalls = 0; _statFrames = 0; _statStart = now;
            }
            return written;
        }

        /// <summary>把设备格式的帧转成 float 单声道（就地复用缓冲，避免频繁分配）。</summary>
        private float[] ConvertToMono(IntPtr data, int frames, bool silent)
        {
            int need = frames;
            if (_reuse.Length < need) _reuse = new float[Math.Max(need, 4096)];
            var dst = _reuse;
            if (silent || data == IntPtr.Zero)
            {
                Array.Clear(dst, 0, need);
                return dst;
            }

            if (_kind == SampleKind.Float32)
            {
                // 共享模式下混音格式通常是 32 位 IEEE 浮点
                unsafe
                {
                    float* src = (float*)data;
                    for (int i = 0; i < frames; i++)
                    {
                        float sum = 0;
                        for (int c = 0; c < _srcChannels; c++) sum += src[i * _srcChannels + c];
                        dst[i] = sum / _srcChannels;
                    }
                }
            }
            else if (_kind == SampleKind.Pcm16)
            {
                unsafe
                {
                    short* src = (short*)data;
                    for (int i = 0; i < frames; i++)
                    {
                        int sum = 0;
                        for (int c = 0; c < _srcChannels; c++) sum += src[i * _srcChannels + c];
                        dst[i] = sum / (float)_srcChannels / 32768f;
                    }
                }
            }
            else if (_kind == SampleKind.Pcm32)
            {
                unsafe
                {
                    int* src = (int*)data;
                    for (int i = 0; i < frames; i++)
                    {
                        long sum = 0;
                        for (int c = 0; c < _srcChannels; c++) sum += src[i * _srcChannels + c];
                        dst[i] = (float)(sum / (double)_srcChannels / 2147483648.0);
                    }
                }
            }
            else
            {
                // 未知格式：宁可静音，也不要输出杂音
                Array.Clear(dst, 0, need);
            }
            return dst;
        }

        /// <summary>
        /// 生成窗化 sinc 低通核（截止 = 0.45 × 输出奈奎斯特），用于降采样前抗混叠。
        /// 长度取 6×ratio 的奇数，兼顾效果与开销。
        /// </summary>
        private static float[] BuildLowPass(double ratio)
        {
            int taps = (int)Math.Ceiling(6 * ratio);
            if (taps < 9) taps = 9;
            if (taps > 129) taps = 129;
            if (taps % 2 == 0) taps++;
            int half = taps / 2;
            double fc = 0.45 / ratio;          // 归一化截止（相对输入采样率）
            var k = new float[taps];
            double sum = 0;
            for (int n = -half; n <= half; n++)
            {
                double sinc = n == 0 ? 2 * fc : Math.Sin(2 * Math.PI * fc * n) / (Math.PI * n);
                double w = 0.54 - 0.46 * Math.Cos(2 * Math.PI * (n + half) / (taps - 1));  // Hamming 窗
                double val = sinc * w;
                k[n + half] = (float)val;
                sum += val;
            }
            if (Math.Abs(sum) > 1e-9)
                for (int i = 0; i < taps; i++) k[i] = (float)(k[i] / sum);   // 归一化，保持增益 1
            return k;
        }

        /// <summary>
        /// 重采样为 16 位小端 PCM。
        ///
        /// 关键：**降采样前必须先低通滤波**，否则高于输出奈奎斯特频率的成分会
        /// 折叠回可听频段（混叠），听起来是金属般的刺耳失真。
        /// 早期版本直接线性插值 48k→8k，等于把 4k~24kHz 全部混叠进来 ——
        /// 这就是"声音采录有问题"的真正原因，不是码率不够。
        /// 这里用窗化 sinc 低通（截止 = 0.45 × 输出采样率）+ 线性插值。
        /// </summary>
        private int ResampleTo16k(float[] src, int valid, byte[] output, int offset, int count)
        {
            double ratio = (double)_srcRate / SnapRate;   // 用快照，避免会话中途被改
            if (_silentOnly)
            {
                // 静音时也保持时间轴推进，避免手机端播放缓冲饥饿
                int zeros = (int)(src.Length / ratio) * 2;
                zeros = Math.Min(zeros, count);
                Array.Clear(output, offset, zeros);
                return zeros;
            }

            // 不需要降采样（ratio <= 1）时，线性插值就够，不必滤波
            bool needFilter = ratio > 1.05;
            float[]? kernel = needFilter ? BuildLowPass(ratio) : null;
            int half = kernel == null ? 0 : kernel.Length / 2;

            int outSamples = (int)(valid / ratio);
            int produced = 0;
            int bytesPerSample = SnapBits / 8;            // 用快照位深
            for (int i = 0; i < outSamples && produced + bytesPerSample <= count; i++)
            {
                double pos = i * ratio;
                int i0 = (int)pos;
                int i1 = Math.Min(i0 + 1, valid - 1);
                float frac = (float)(pos - i0);
                float v;
                if (kernel != null)
                {
                    // 在 pos 附近做窗化 sinc 卷积（等价于先低通再抽样）
                    float acc = 0f;
                    for (int k = -half; k <= half; k++)
                    {
                        int idx = i0 + k;
                        if (idx < 0 || idx >= valid) continue;
                        acc += src[idx] * kernel[k + half];
                    }
                    v = acc;
                }
                else
                {
                    v = src[i0] + (src[i1] - src[i0]) * frac;
                }
                if (v > 1f) v = 1f; else if (v < -1f) v = -1f;
                // 24 位小端：用 int 中间量避免溢出（1<<23 = 8388608）
                int s = (int)(v * 8388607f);
                output[offset + produced] = (byte)(s & 0xFF);
                output[offset + produced + 1] = (byte)((s >> 8) & 0xFF);
                output[offset + produced + 2] = (byte)((s >> 16) & 0xFF);
                produced += 3;
            }
            return produced;
        }

        public void Dispose()
        {
            try { _client?.Stop(); } catch { }
            try { if (_capture != null) Marshal.ReleaseComObject(_capture); } catch { }
            try { if (_client != null) Marshal.ReleaseComObject(_client); } catch { }
            try { if (_device != null) Marshal.ReleaseComObject(_device); } catch { }
            try { if (_enumerator != null) Marshal.ReleaseComObject(_enumerator); } catch { }
            _capture = null; _client = null; _device = null; _enumerator = null;
            if (_comInitialized) { try { CoUninitialize(); } catch { } }
        }
    }

    /// <summary>
    /// 音频推送会话：在独立线程里采集并通过回调把 PCM 数据交出去。
    /// 回调返回 false 即停止（例如手机断开或用户关闭声音）。
    /// </summary>
    public sealed class Session : IDisposable
    {
        private Thread? _thread;
        private volatile bool _running;
        private readonly Action<byte[], int> _onData;

        public Session(Action<byte[], int> onData) { _onData = onData; }

        /// <summary>启动采集线程；返回是否成功启动（失败原因在 Message 里）。</summary>
        public bool Start(out string? error)
        {
            error = null;
            if (!Available) { error = Message; return false; }
            _running = true;
            _thread = new Thread(Run) { IsBackground = true, Name = "LanControl-Audio" };
            _thread.Start();
            return true;
        }

        private void Run()
        {
            try
            {
                using var cap = new LoopbackCapture();
                if (!cap.Initialize(out var err))
                {
                    Log.Warn("音频采集初始化失败: " + err);
                    _running = false;
                    return;
                }
                // 每 20ms 一帧：帧更小 ⇒ 更容易插在画面帧之间发出，端到端延迟也更低
                var buf = new byte[cap.SnapRate * (cap.SnapBits / 8) * 20 / 1000];   // 20ms（按会话快照）
                cap.Start();
                Log.Info($"音频推送已开始：{cap.MixFormatDescription} -> {cap.SnapRate} Hz / {cap.SnapBits} 位（会话快照，缓冲区 {cap.SnapRate * (cap.SnapBits / 8) * 20 / 1000} 字节/20ms）");
                while (_running)
                {
                    int n = cap.Read(buf, 0, buf.Length);
                    if (n <= 0) { Thread.Sleep(5); continue; }
                    _onData(buf, n);
                }
                cap.Stop();
                Log.Info("音频推送已停止");
            }
            catch (Exception ex)
            {
                Log.Warn("音频采集线程异常: " + ex.Message);
            }
            finally { _running = false; }
        }

        public void Dispose()
        {
            _running = false;
            try { _thread?.Join(800); } catch { }
            _thread = null;
        }
    }
}
