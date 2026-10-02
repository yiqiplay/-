using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.Versioning;
using System.Text;
using System.Text.Json.Nodes;

namespace LanControl;

/// <summary>一个手机客户端的会话：鉴权、控制指令、屏幕推流。</summary>
internal sealed class Agent
{
    private readonly WebSocketConnection _ws;
    private readonly ServerContext _ctx;
    private readonly CancellationTokenSource _cts = new();
    private volatile bool _authed;
    private volatile bool _streaming;
    private int _monitor;
    private double _scale = 1.0;
    private int _quality = 72;
    private int _fps = 20;
    private int _maxWidth = 1600;

    public string Id { get; } = Guid.NewGuid().ToString("N")[..8];
    public string RemoteIp { get; }
    public DateTime ConnectedAt { get; } = DateTime.Now;
    public string DeviceName { get; private set; } = "手机";
    public bool Authed => _authed;

    public Agent(WebSocketConnection ws, ServerContext ctx, string remoteIp)
    {
        _ws = ws;
        _ctx = ctx;
        RemoteIp = remoteIp;
    }

    public async Task RunAsync()
    {
        Log.Info($"[{Id}] 新的连接来自 {RemoteIp}");
        _ctx.Sessions.TryAdd(Id, this);
        try
        {
            await SendWelcomeAsync();
            while (!_cts.IsCancellationRequested)
            {
                var text = await _ws.ReceiveTextAsync(_cts.Token);
                if (text == null) break;
                await HandleMessageAsync(text);
            }
        }
        catch (Exception ex)
        {
            Log.Debug($"[{Id}] 会话结束: {ex.Message}");
        }
        finally
        {
            _streaming = false;
            _ctx.Sessions.TryRemove(Id, out _);
            _ws.Dispose();
            Log.Info($"[{Id}] 连接已断开 ({DeviceName})");
        }
    }

    private Task Send(object payload) => _ws.SendTextAsync(Json.Str(payload));

    private async Task SendWelcomeAsync()
    {
        _ctx.Screen.Refresh();
        var monitors = _ctx.Screen.Monitors.Select(m => new
        {
            index = m.Index,
            label = m.Label,
            primary = m.Primary,
            width = m.Bounds.Width,
            height = m.Bounds.Height,
        });
        await Send(new
        {
            type = "welcome",
            version = Program.Version,
            host = Environment.MachineName,
            user = Environment.UserName,
            os = Environment.OSVersion.VersionString,
            needAuth = !_authed,
            monitors,
            monitor = _monitor,
            drives = Drives(),
            clipboardSupported = true,
            fileRoot = _ctx.FileRoot,
            serverTime = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"),
            // 本机所有可用地址 + 端口：手机端据此在"同网段"里直连扫描找电脑。
            // （UDP 广播常被路由器/防火墙拦截，直连扫描才是可靠路径）
            serverAddresses = Program.LocalAddresses(),
            port = Program.Server.Port,
            audioOk = Program.AudioAvailable,
            audioMessage = Program.AudioMessage,
            // 能力自检：输入注入不可用时，手机端会明确提示"点了没反应"的原因
            inputInjectionOk = Program.InputInjectionOk,
            inputInjectionMessage = Program.InputInjectionMessage,
        });
    }

    public static IEnumerable<object> Drives()
    {
        var list = new List<object>();
        try
        {
            foreach (var d in DriveInfo.GetDrives())
            {
                try
                {
                    if (!d.IsReady) continue;
                    list.Add(new
                    {
                        name = d.Name.TrimEnd('\\'),
                        label = string.IsNullOrWhiteSpace(d.VolumeLabel) ? d.DriveType.ToString() : d.VolumeLabel,
                        totalGb = Math.Round(d.TotalSize / 1073741824.0, 1),
                        freeGb = Math.Round(d.AvailableFreeSpace / 1073741824.0, 1),
                        type = d.DriveType.ToString(),
                    });
                }
                catch { }
            }
        }
        catch { }
        return list;
    }

    private async Task HandleMessageAsync(string text)
    {
        var msg = Json.Parse(text);
        if (msg == null)
        {
            await Send(new { type = "error", message = "消息格式错误" });
            return;
        }
        string type = Json.GetString(msg, "type");
        if (!_authed && type != "auth")
        {
            await Send(new { type = "error", message = "尚未配对，请先输入配对码" });
            return;
        }

        switch (type)
        {
            case "auth":
                {
                    string code = Json.GetString(msg, "code").Trim();
                    string name = Json.GetString(msg, "device", "手机").Trim();
                    DeviceName = string.IsNullOrWhiteSpace(name) ? "手机" : name[..Math.Min(name.Length, 40)];
                    // 比较时忽略空格/连字符：控制面板显示的是 "123 456"，
                    // 用户很可能照着带空格输入，不能因此判错。
                    static string Norm(string s) => s.Replace(" ", "").Replace("-", "").Trim();
                    if (Norm(code) == Norm(_ctx.PairCode))
                    {
                        _authed = true;
                        Log.Info($"[{Id}] 配对成功: {DeviceName} ({RemoteIp})");
                        _ctx.OnPaired(this);
                        await Send(new { type = "authResult", ok = true, host = Environment.MachineName, monitors = _ctx.Screen.Monitors.Count });
                    }
                    else
                    {
                        Log.Warn($"[{Id}] 配对码错误: {code}");
                        await Send(new { type = "authResult", ok = false, message = "配对码不正确" });
                    }
                    break;
                }

            case "ping":
                await Send(new { type = "pong", t = Json.GetDouble(msg, "t"), serverTime = DateTime.Now.ToString("HH:mm:ss") });
                break;

            case "startStream":
                {
                    _monitor = Json.GetInt(msg, "monitor", 0);
                    _scale = Json.GetDouble(msg, "scale", 1.0);
                    _quality = Json.GetInt(msg, "quality", 72);
                    _fps = Math.Clamp(Json.GetInt(msg, "fps", 20), 1, 30);
                    _maxWidth = Math.Clamp(Json.GetInt(msg, "maxWidth", 1600), 320, 4096);
                    await Send(new { type = "streamState", streaming = true, monitor = _monitor, scale = _scale, quality = _quality, fps = _fps });
                    if (!_streaming)
                    {
                        _streaming = true;
                        _ = Task.Run(StreamLoopAsync);
                    }
                    break;
                }

            case "stopStream":
                _streaming = false;
                await Send(new { type = "streamState", streaming = false });
                break;

            case "setMonitor":
                _monitor = Json.GetInt(msg, "monitor", 0);
                _ctx.Screen.Refresh();
                await Send(new
                {
                    type = "monitors",
                    monitors = _ctx.Screen.Monitors.Select(m => new { index = m.Index, label = m.Label, primary = m.Primary, width = m.Bounds.Width, height = m.Bounds.Height }),
                    monitor = _monitor,
                });
                break;

            case "mouse":
                {
                    string action = Json.GetString(msg, "action", "move");
                    switch (action)
                    {
                        case "move":
                        case "moveabs":
                            InputInjector.MoveNormalized(Json.GetDouble(msg, "x"), Json.GetDouble(msg, "y"));
                            break;
                        case "down":
                            InputInjector.MouseButton(Json.GetString(msg, "button", "left"), true);
                            break;
                        case "up":
                            InputInjector.MouseButton(Json.GetString(msg, "button", "left"), false);
                            break;
                        case "click":
                            InputInjector.Click(Json.GetString(msg, "button", "left"), Json.GetInt(msg, "count", 1));
                            break;
                        case "scroll":
                            InputInjector.Scroll((int)Math.Clamp(Json.GetDouble(msg, "delta"), -6000, 6000));
                            break;
                        case "hscroll":
                            InputInjector.Scroll((int)Math.Clamp(Json.GetDouble(msg, "delta"), -6000, 6000), true);
                            break;
                    }
                    break;
                }

            case "key":
                {
                    string action = Json.GetString(msg, "action", "tap");
                    var keys = new List<string>();
                    if (msg.TryGetPropertyValue("keys", out var kn) && kn is JsonArray arr)
                        foreach (var k in arr) keys.Add(k?.ToString() ?? "");
                    else
                    {
                        string single = Json.GetString(msg, "key");
                        if (!string.IsNullOrEmpty(single)) keys.Add(single);
                    }
                    if (keys.Count == 0) break;
                    if (action == "down") InputInjector.KeyCombo(keys, true);
                    else if (action == "up") InputInjector.KeyCombo(keys, false);
                    else InputInjector.Tap(keys);
                    break;
                }

            case "text":
                {
                    string content = Json.GetString(msg, "text");
                    if (string.IsNullOrEmpty(content)) break;
                    if (Json.GetBool(msg, "replaceAll"))
                    {
                        InputInjector.Tap(new[] { "ctrl", "a" });
                        Thread.Sleep(40);
                    }
                    if (content.Length > 8 && Json.GetBool(msg, "viaClipboard", true)) InputInjector.PasteText(content);
                    else InputInjector.TypeText(content);
                    break;
                }

            case "shortcut":
                {
                    string name = Json.GetString(msg, "name");
                    switch (name)
                    {
                        case "alttab": InputInjector.Tap(new[] { "alt", "tab" }); break;
                        case "altf4": InputInjector.Tap(new[] { "alt", "f4" }); break;
                        case "win": InputInjector.Tap(new[] { "win" }); break;
                        case "wind": InputInjector.Tap(new[] { "win", "d" }); break;
                        case "wine": InputInjector.Tap(new[] { "win", "e" }); break;
                        case "winr": InputInjector.Tap(new[] { "win", "r" }); break;
                        case "winl": InputInjector.Tap(new[] { "win", "l" }); break;
                        case "copy": InputInjector.Tap(new[] { "ctrl", "c" }); break;
                        case "paste": InputInjector.Tap(new[] { "ctrl", "v" }); break;
                        case "cut": InputInjector.Tap(new[] { "ctrl", "x" }); break;
                        case "undo": InputInjector.Tap(new[] { "ctrl", "z" }); break;
                        case "redo": InputInjector.Tap(new[] { "ctrl", "y" }); break;
                        case "selectall": InputInjector.Tap(new[] { "ctrl", "a" }); break;
                        case "save": InputInjector.Tap(new[] { "ctrl", "s" }); break;
                        case "find": InputInjector.Tap(new[] { "ctrl", "f" }); break;
                        case "newtab": InputInjector.Tap(new[] { "ctrl", "t" }); break;
                        case "closetab": InputInjector.Tap(new[] { "ctrl", "w" }); break;
                        case "taskview": InputInjector.Tap(new[] { "win", "tab" }); break;
                        case "showdesktop": InputInjector.Tap(new[] { "win", "d" }); break;
                        case "escape": InputInjector.Tap(new[] { "escape" }); break;
                        case "enter": InputInjector.Tap(new[] { "enter" }); break;
                        case "browser_back": InputInjector.Tap(new[] { "alt", "left" }); break;
                        case "browser_forward": InputInjector.Tap(new[] { "alt", "right" }); break;
                        case "closewindow": InputInjector.Tap(new[] { "alt", "f4" }); break;
                        default:
                            Log.Debug($"未知快捷键 {name}");
                            break;
                    }
                    break;
                }

            case "power":
                {
                    string action = Json.GetString(msg, "action");
                    int delay = Json.GetInt(msg, "delay", 0);
                    string result = Power.Execute(action, delay);
                    Log.Info($"[{Id}] 电源操作 {action}: {result}");
                    await Send(new { type = "powerResult", action, ok = true, message = result });
                    break;
                }

            case "volume":
                {
                    string action = Json.GetString(msg, "action");
                    switch (action)
                    {
                        case "up": InputInjector.TapVk(0xAF); break;
                        case "down": InputInjector.TapVk(0xAE); break;
                        case "mute": InputInjector.TapVk(0xAD); break;
                    }
                    break;
                }

            case "media":
                {
                    string action = Json.GetString(msg, "action");
                    switch (action)
                    {
                        case "playpause": InputInjector.TapVk(0xB3); break;
                        case "next": InputInjector.TapVk(0xB0); break;
                        case "prev": InputInjector.TapVk(0xB1); break;
                        case "stop": InputInjector.TapVk(0xB2); break;
                    }
                    break;
                }

            case "cursor":
                {
                    var real = InputInjector.CursorPosition();
                    double rx = (real.X - InputInjector.VirtualLeft) / Math.Max(InputInjector.VirtualWidth - 1.0, 1);
                    double ry = (real.Y - InputInjector.VirtualTop) / Math.Max(InputInjector.VirtualHeight - 1.0, 1);

                    // 注入成功时回传“我们要求注入的位置”（= 手机请求的坐标）。
                    // 这样手机上的指针与电脑指针严格对齐；直接读回的位置可能因为
                    // 取整、多屏坐标或光标吸附而差几像素，看起来就是“箭头和指针不在一处”。
                    // 注入失败（受限会话）时回传真实位置，但标记 trusted=false，
                    // 手机端不会采用，避免把虚拟指针拽回去。
                    bool trusted = InputInjector.CursorReportTrustworthy();
                    double ox = rx, oy = ry;
                    if (trusted)
                    {
                        var want = InputInjector.DesiredNormalized;
                        if (want != null) { ox = want.Value.x; oy = want.Value.y; }
                    }

                    await Send(new
                    {
                        type = "cursor",
                        x = Math.Round(Math.Clamp(ox, 0, 1), 6),
                        y = Math.Round(Math.Clamp(oy, 0, 1), 6),
                        rx = Math.Round(Math.Clamp(rx, 0, 1), 6),
                        ry = Math.Round(Math.Clamp(ry, 0, 1), 6),
                        mon = _monitor,
                        trusted,
                        t = DateTimeOffset.Now.ToUnixTimeMilliseconds(),
                    });
                    break;
                }

            case "clipboardGet":
                {
                    var (clip, error) = _ctx.GetClipboard();
                    await Send(new { type = "clipboard", text = clip, error });
                    break;
                }

            case "clipboardSet":
                {
                    string clip = Json.GetString(msg, "text");
                    string? error = _ctx.SetClipboard(clip);
                    await Send(new { type = "clipboardSet", ok = error == null, message = error, length = clip.Length });
                    break;
                }

            case "launch":
                {
                    string path = Json.GetString(msg, "path");
                    InputInjector.OpenPath(path);
                    break;
                }

            case "listDir":
                {
                    string path = Json.GetString(msg, "path", _ctx.FileRoot);
                    await Send(FileService.ListDirectory(path, _ctx.FileRoot));
                    break;
                }

            case "mkdir":
                {
                    var res = FileService.CreateDirectory(Json.GetString(msg, "path"), Json.GetString(msg, "name"));
                    await Send(new { type = "simpleResult", ok = res.ok, message = res.message, path = res.path });
                    break;
                }

            case "delete":
                {
                    var res = FileService.Delete(Json.GetString(msg, "path"));
                    await Send(new { type = "simpleResult", ok = res.ok, message = res.message });
                    break;
                }

            case "sysinfo":
                await Send(BuildSysInfo());
                break;

            case "audioStart":
                // 手机端会带上它 AudioContext 的真实采样率，按这个率重采样可避免变调/爆音
                await StartAudioAsync(ReadInt(msg, "sampleRate", 0), ReadInt(msg, "bitrateKbps", 0));
                break;

            case "audioStop":
                StopAudio();
                await Send(new { type = "audioState", on = false });
                break;

            case "disconnect":
                await Send(new { type = "bye" });
                _cts.Cancel();
                break;

            default:
                Log.Debug($"[{Id}] 未处理的消息类型: {type}");
                break;
        }
    }

    // ================= 系统声音推送 =================

    private SystemAudio.Session? _audio;
    private int _audioFrames;
    private long _audioSentFrames, _audioSentBytes;   // 音频实际送出统计

    /// <summary>
    /// 开始把电脑正在播放的声音推给手机。
    /// 数据格式：16 kHz / 单声道 / 16 位小端 PCM，每帧带 8 字节头
    /// [0]=0x41('A') [1]=版本 [2..3]=采样率 u16 [4]=声道 [5]=位深 [6..7]=序号 u16
    /// </summary>
    /// <summary>从已解析的 JSON 里安全取一个整数参数。</summary>
    private static int ReadInt(System.Text.Json.Nodes.JsonObject msg, string name, int fallback)
    {
        try
        {
            var v = msg[name];
            if (v == null) return fallback;
            if (v is System.Text.Json.Nodes.JsonValue jv)
            {
                if (jv.TryGetValue<int>(out int n)) return n;
                if (jv.TryGetValue<string>(out string? s) && int.TryParse(s, out int si)) return si;
            }
        }
        catch { }
        return fallback;
    }

    private async Task StartAudioAsync(int requestedRate, int requestedKbps)
    {
        // 手机端优先按"码率"协商（128 / 256 / 768 kbps）；没给码率时才用采样率。
        // 只接受合理范围，避免异常值把重采样算崩。
        if (requestedKbps > 0)
        {
            SystemAudio.SetBitrate(requestedKbps);
        }
        else
        {
            if (requestedRate < 8000 || requestedRate > 192000) requestedRate = 8000;
            SystemAudio.OutSampleRate = requestedRate;
            SystemAudio.SetBitrate(SystemAudio.OutSampleRate * (SystemAudio.OutBitsPerSample / 8) * 8 / 1000);   // 反推码率用于显示
        }
        if (_audio != null)
        {
            await Send(new { type = "audioState", on = true, note = "已在推送" });
            return;
        }
        if (!SystemAudio.Available)
        {
            await Send(new { type = "audioState", on = false, error = SystemAudio.Message });
            return;
        }

        var session = new SystemAudio.Session((buf, len) =>
        {
            try
            {
                var frame = new byte[8 + len];
                frame[0] = 0x41;                                     // 'A'
                frame[1] = 1;                                        // 版本
                frame[2] = (byte)(SystemAudio.OutSampleRate & 0xFF);
                frame[3] = (byte)((SystemAudio.OutSampleRate >> 8) & 0xFF);
                frame[4] = (byte)SystemAudio.OutChannels;
                frame[5] = (byte)SystemAudio.OutBitsPerSample;
                frame[6] = (byte)(_audioFrames & 0xFF);
                frame[7] = (byte)((_audioFrames++ >> 8) & 0xFF);
                Buffer.BlockCopy(buf, 0, frame, 8, len);
                // 音频优先：这里**必须等待发送完成**。
                // 根因：画面与音频共用一条 WebSocket，SendAsync 内部用信号量串行化；
                // 画面每帧 170KB+，若音频"发完就不管"，小帧会被画面反复挤到后面，
                // 手机端听到的就是断续/失真 —— 这才是"声音依旧有问题"的真正原因。
                // 等待会让采集线程自然背压：网络跟不上时宁可丢音频帧，也不越堆越多。
                try { _ws.SendBinaryAsync(frame).GetAwaiter().GetResult(); } catch { }
                _audioSentFrames++;
                _audioSentBytes += frame.Length;
            }
            catch { }
        });

        if (!session.Start(out var err))
        {
            session.Dispose();
            await Send(new { type = "audioState", on = false, error = err ?? "无法开始采集" });
            return;
        }

        _audio = session;
        Log.Info($"[{Id}] 开始推送系统声音");
        await Send(new
        {
            type = "audioState",
            on = true,
            sampleRate = SystemAudio.OutSampleRate,
            bitrateKbps = SystemAudio.BitrateKbps,
            channels = SystemAudio.OutChannels,
            bits = SystemAudio.OutBitsPerSample,
            codec = "pcm",
        });
    }

    private void StopAudio()
    {
        if (_audio == null) return;
        Log.Info($"[{Id}] 停止推送系统声音");
        try { _audio.Dispose(); } catch { }
        _audio = null;
    }

    private object BuildSysInfo()    {
        var (cpu, memUsed, memTotal) = SystemStats.Snapshot();
        return new
        {
            type = "sysinfo",
            host = Environment.MachineName,
            user = Environment.UserName,
            os = Environment.OSVersion.VersionString,
            cpuPercent = cpu,
            memUsedGb = memUsed,
            memTotalGb = memTotal,
            uptime = TimeSpan.FromMilliseconds(Environment.TickCount64).ToString(@"d\d\ hh\:mm"),
            serverTime = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"),
        };
    }

    private async Task StreamLoopAsync()
    {
        Log.Info($"[{Id}] 开始推流 mon={_monitor} scale={_scale} q={_quality} fps={_fps}");
        var sw = new Stopwatch();
        int frames = 0;
        long bytes = 0;
        var statTimer = Stopwatch.StartNew();
        try
        {
            while (_streaming && !_cts.IsCancellationRequested && !_ws.Closed)
            {
                sw.Restart();
                byte[]? jpeg = null;
                try
                {
                    jpeg = _ctx.Screen.CaptureJpeg(_monitor, _scale, _quality, _maxWidth);
                }
                catch (Exception ex)
                {
                    Log.Warn($"[{Id}] 抓屏失败: {ex.Message}");
                    await Task.Delay(500, _cts.Token);
                    continue;
                }
                if (jpeg == null) { await Task.Delay(200, _cts.Token); continue; }

                var mon = _ctx.Screen.GetMonitor(_monitor);
                var head = new byte[14];
                head[0] = 1; // 版本
                head[1] = (byte)(mon?.Index ?? 0);
                BitConverter.TryWriteBytes(head.AsSpan(2, 4), (float)(mon?.Bounds.Width ?? 0));
                BitConverter.TryWriteBytes(head.AsSpan(6, 4), (float)(mon?.Bounds.Height ?? 0));
                BitConverter.TryWriteBytes(head.AsSpan(10, 4), (float)(Environment.TickCount64 % int.MaxValue));
                var packet = new byte[head.Length + jpeg.Length];
                Buffer.BlockCopy(head, 0, packet, 0, head.Length);
                Buffer.BlockCopy(jpeg, 0, packet, head.Length, jpeg.Length);

                // 音频在推时给画面让路：两者共用同一条 WS，画面每帧 170KB+，
                // 会把音频小帧挤到后面（手机端表现为断续/失真）。这里主动降速，
                // 保证音频连续 —— 会话期间音质优先于帧率。
                if (_audio != null && frames % 3 != 0) await Task.Delay(1);
                await _ws.SendBinaryAsync(packet);
                frames++;
                bytes += packet.Length;

                if (statTimer.ElapsedMilliseconds >= 2000)
                {
                    double fps = frames * 1000.0 / statTimer.ElapsedMilliseconds;
                    double mbps = bytes * 8.0 / 1000.0 / statTimer.ElapsedMilliseconds;
                    await Send(new
                    {
                        type = "stats",
                        fps = Math.Round(fps, 1),
                        kbps = Math.Round(mbps * 1000 / 1000.0, 0),
                        width = (int)((mon?.Bounds.Width ?? 0) * _scale),
                    });
                    frames = 0; bytes = 0; statTimer.Restart();
                }

                int target = 1000 / Math.Max(_fps, 1);
                int wait = target - (int)sw.ElapsedMilliseconds;
                if (wait > 0) await Task.Delay(wait, _cts.Token);
            }
        }
        catch (Exception ex)
        {
            Log.Debug($"[{Id}] 推流结束: {ex.Message}");
        }
        finally
        {
            _streaming = false;
            Log.Info($"[{Id}] 停止推流");
        }
    }

    public void Stop() { try { StopAudio(); } catch { } _cts.Cancel(); }
}

/// <summary>全局服务上下文。</summary>
[SupportedOSPlatform("windows")]
internal sealed class ServerContext
{
    public required ScreenCapture Screen { get; init; }
    public required string PairCode { get; init; }
    public required string FileRoot { get; init; }
    public System.Collections.Concurrent.ConcurrentDictionary<string, Agent> Sessions { get; } = new();
    public event Action<Agent>? Paired;

    public void OnPaired(Agent a) => Paired?.Invoke(a);

    /// <summary>读取剪贴板文本，第二个返回值是错误信息（null 表示成功；空字符串表示剪贴板为空）。</summary>
    public (string text, string? error) GetClipboard()
    {
        string result = "";
        string? error = null;
        var ready = new ManualResetEventSlim(false);
        var t = new Thread(() =>
        {
            try
            {
                for (int i = 0; i < 3; i++)
                {
                    try
                    {
                        result = System.Windows.Forms.Clipboard.ContainsText() ? System.Windows.Forms.Clipboard.GetText() : "";
                        return;
                    }
                    catch (Exception ex)
                    {
                        error = ex.Message;
                        Thread.Sleep(80);
                    }
                }
            }
            catch (Exception ex) { error = ex.Message; }
            finally { ready.Set(); }
        });
        t.SetApartmentState(ApartmentState.STA);
        t.IsBackground = true;
        t.Start();
        ready.Wait(1500);
        return (result, error);
    }

    /// <summary>写入剪贴板，返回 null 表示成功，否则返回错误信息。</summary>
    public string? SetClipboard(string text)
    {
        string? error = null;
        var done = new ManualResetEventSlim(false);
        var t = new Thread(() =>
        {
            for (int i = 0; i < 5; i++)
            {
                try
                {
                    System.Windows.Forms.Clipboard.SetText(text ?? "");
                    error = null;
                    break;
                }
                catch (Exception ex)
                {
                    error = ex.Message;
                    Thread.Sleep(80);
                }
            }
            done.Set();
        });
        t.SetApartmentState(ApartmentState.STA);
        t.IsBackground = true;
        t.Start();
        done.Wait(2000);
        return error;
    }
}
