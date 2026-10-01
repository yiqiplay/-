using System.Diagnostics;
using System.Drawing;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using System.Windows.Forms;

namespace LanControl;

[SupportedOSPlatform("windows")]
internal static class Program
{
    public const string Version = "2.5.0";
    public const int DefaultPort = 8848;
    public const int DiscoveryPort = 8849;
    private const string MutexNameBase = @"Global\LanControlServer.SingleInstance";
    private const string ShowEventNameBase = @"Global\LanControlServer.ShowWindow";
    private const string ExitEventNameBase = @"Global\LanControlServer.ExitRequest";

    public static ServerContext Context = null!;
    public static HttpServer Server = null!;
    public static bool Started;
    /// <summary>进程退出码约定（供脚本判断）：
    /// 0=正常退出 / 已有实例在运行；2=无法监听端口；3=启动异常。</summary>
    public static int ExitCode;
    public const int ExitAlreadyRunning = 0;
    public const int ExitPortFailed = 2;
    public const int ExitStartupError = 3;
    /// <summary>输入注入是否可用（启动时自检得出）。</summary>
    public static bool InputInjectionOk { get; private set; } = true;
    public static string InputInjectionMessage { get; private set; } = "";

    [STAThread]
    private static void Main(string[] args)
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        Log.Init(ArgStr(args, "--log", ""));
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            Log.Error("未处理异常: " + (e.ExceptionObject as Exception)?.ToString());
        Application.ThreadException += (_, e) => Log.Error("UI 线程异常: " + e.Exception);

        try
        {
            Run(args);
        }
        catch (Exception ex)
        {
            ExitCode = ExitStartupError;
            Log.Error("启动失败: " + ex);
            ShowFatal("被控端启动失败：\n\n" + ex.Message + "\n\n详情见日志：\n" + Log.LogFilePath);
        }
        finally
        {
            Shutdown("进程退出");
        }
    }

    private static void Run(string[] args)
    {
        bool silent = HasFlag(args, "--silent");
        bool noTray = HasFlag(args, "--no-tray");
        StatusFilePath = ArgStr(args, "--status-file", "");
        int port = ArgInt(args, "--port", RegistryPort() ?? DefaultPort);
        string code = ArgStr(args, "--code", "");
        if (string.IsNullOrEmpty(code))
        {
            // 优先用"固定配对码"（用户要求：重启后不变，手机端才能记住）
            code = ReadFixedCode();
            if (string.IsNullOrEmpty(code))
                code = Random.Shared.Next(100000, 999999).ToString();
        }
        string fileRoot = ArgStr(args, "--files", "");

        // ---------- 安装/部署模式 ----------
        if (HasFlag(args, "--install"))
        {
            RunInstall(port, silent);
            ExitCode = 0;
            return;
        }

        // ---------- 固定/取消固定配对码（命令行，便于脚本设定）----------
        if (HasFlag(args, "--pin-code"))
        {
            string want = ArgStr(args, "--pin-code", "");
            if (string.IsNullOrEmpty(want))
            {
                Console.WriteLine("当前固定配对码: " + (ReadFixedCode() is var c && c.Length > 0 ? DisplayCode(c) : "（未固定）"));
            }
            else if (want == "off" || want == "clear")
            {
                Console.WriteLine(SaveFixedCode("") ? "已取消固定配对码" : "取消失败（注册表不可写）");
            }
            else if (!IsValidCode(want))
            {
                Console.WriteLine("配对码必须是 6 位数字，例如 --pin-code=123456");
                ExitCode = 1;
                return;
            }
            else
            {
                Console.WriteLine(SaveFixedCode(want) ? ("已固定配对码: " + DisplayCode(want)) : "保存失败（注册表不可写）");
            }
            ExitCode = 0;
            return;
        }

        // ---------- 系统音频自检 ----------
        if (HasFlag(args, "--audio-test"))
        {
            Report.Init(HasFlag(args, "--show-report"));
            Report.Head("系统音频采集自检");
            Report.Line(SystemAudio.SelfTest(4));
            Report.Flush();
            ExitCode = 0;
            return;
        }

        // ---------- 系统音频录音留证（把推给手机的那份 PCM 存成 wav）----------
        if (HasFlag(args, "--audio-record"))
        {
            int secs = ArgInt(args, "--seconds", 0); if (secs <= 0) secs = FirstNumberArg(args, 8);
            // 输出路径写法要宽容：既支持 --audio-record=路径，也支持路径直接跟在后面。
            // （用户很自然会写成 "exe --audio-record D:\test.wav"；早期版本解析不到就静默
            //   回退到桌面，用户按提示的路径当然找不到文件 —— 已修。）
            string outPath = ArgStr(args, "--audio-record", "");
            if (string.IsNullOrWhiteSpace(outPath)) outPath = FindWavPathArg(args);
            if (string.IsNullOrWhiteSpace(outPath))
                outPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                                       "LanControl-录制测试.wav");
            try
            {
                var dir = Path.GetDirectoryName(outPath);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
            }
            catch
            {
                outPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                                       "LanControl-录制测试.wav");
            }

            Report.Init(HasFlag(args, "--show-report"));
            Report.Head("把推送给手机的声音录成 wav（用于判断杂音出在哪一端）");
            Report.Line("重要：录制期间 **电脑必须正在播放声音**（放一首歌或视频）。");
            Report.Line("      Windows 回环采集在没有音频流时不会推数据，录出来就是空文件。");
            Report.Line();
            Report.Line(SystemAudio.RecordToWav(outPath, secs));
            Report.Line();
            Report.Line("文件位置: " + outPath);
            Report.Flush();
            ExitCode = 0;
            return;
        }

        // ---------- 旧版本排查 / 清理 ----------
        if (HasFlag(args, "--scan-old"))
        {
            RunScanOld(HasFlag(args, "--show-report"));
            ExitCode = 0;
            return;
        }
        if (HasFlag(args, "--clean-old"))
        {
            RunCleanOld(HasFlag(args, "--show-report"), HasFlag(args, "--firewall"));
            ExitCode = 0;
            return;
        }

        // ---------- 卸载/清理模式 ----------
        if (HasFlag(args, "--uninstall"))
        {
            RunUninstall(silent);
            ExitCode = 0;
            return;
        }

        // ---------- 卸载前静默清理（由安装程序的 UninstallRun 调用）----------
        // 只做"必须做且不能失败"的三件事，不打印交互内容，退出码始终 0：
        //   1) 结束仍在运行的被控端（否则文件删不掉，会留下半卸载状态）
        //   2) 清理托盘图标提升注册表（真实残留项）
        //   3) 删除 Software\LanControl 记忆项
        if (HasFlag(args, "--uninstall-clean"))
        {
            var cleanLog = new System.Text.StringBuilder();
            try
            {
                HandleRunningInstances(true, out string msg);
                cleanLog.AppendLine("running: " + msg);
            }
            catch (Exception ex) { cleanLog.AppendLine("running: FAIL " + ex.Message); }
            try
            {
                int n = CleanTrayPromotion();
                cleanLog.AppendLine("trayPromotionRemoved: " + n);
            }
            catch (Exception ex) { cleanLog.AppendLine("trayPromotion: FAIL " + ex.Message); }
            try
            {
                Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(@"Software\LanControl", false);
                cleanLog.AppendLine("savedSettings: removed");
            }
            catch (Exception ex) { cleanLog.AppendLine("savedSettings: FAIL " + ex.Message); }

            try
            {
                File.AppendAllText(Path.Combine(Path.GetTempPath(), "LanControl-uninstall-clean.txt"),
                                   DateTime.Now.ToString("s") + "\n" + cleanLog);
            }
            catch { }
            ExitCode = 0;   // 卸载流程里绝不返回非 0，避免打断卸载
            return;
        }

        // ---------- 运行状态检查（供安装/卸载前判断，exit 1 = 正在运行）----------
        if (HasFlag(args, "--check-running"))
        {
            HandleRunningInstances(false, out string msg);
            Console.WriteLine(msg);
            ExitCode = (msg.StartsWith("没有") ? 0 : 1);
            return;
        }

        // ---------- 隐藏自测：生成二维码 PNG（供自动化验证可被解码） ----------
        // 用法: LanControlServer.exe --qrtest <输出目录> [端口]
        if (HasFlag(args, "--qrtest"))
        {
            string dir = ArgStr(args, "--qrtest", "");
            if (string.IsNullOrWhiteSpace(dir)) dir = Path.Combine(Path.GetTempPath(), "lc-qr");
            Directory.CreateDirectory(dir);
            for (int v = 1; v <= 4; v++) Console.WriteLine("SELFCHECK " + QrCode.SelfCheck(v));
            int fmt = QrCode.DebugFormatValue();
            Console.WriteLine($"FORMAT mask0 = 0x{fmt:X4} = {Convert.ToString(fmt, 2).PadLeft(15, '0')}");
            var payloads = new[]
            {
                $"http://192.168.3.51:{port}/?code=246810",
                $"http://10.0.0.5:{port}/?code=111111",
                $"http://192.168.100.200:{port}/?code=987654",
                $"http://172.16.31.7:{port}/?code=000123",
            };
            foreach (var p in payloads)
            {
                using var bmp = QrCode.Render(p, 300);
                string file = Path.Combine(dir, $"qr_{p.Length}.png");
                bmp.Save(file, System.Drawing.Imaging.ImageFormat.Png);
                Console.WriteLine($"QR {p.Length,3} chars -> {file}  ({bmp.Width}x{bmp.Height})");
            }
            // 同时导出矩阵/码字文本，便于与参考实现逐模块核对（自动化验证用）
            foreach (var p in payloads)
            {
                var m = QrCode.Encode(p);
                int n = m.GetLength(0);
                var sb = new StringBuilder();
                sb.AppendLine($"MATRIX {p.Length} {n}");
                for (int y = 0; y < n; y++)
                {
                    for (int x = 0; x < n; x++) sb.Append(m[y, x] ? '1' : '0');
                    sb.AppendLine();
                }
                File.WriteAllText(Path.Combine(dir, $"matrix_{p.Length}.txt"), sb.ToString());
                File.WriteAllText(Path.Combine(dir, $"reserved_{p.Length}.txt"), QrCode.DebugReserved(p));
                File.WriteAllText(Path.Combine(dir, $"codewords_{p.Length}.txt"),
                    string.Join(" ", QrCode.DebugCodewords(p).Select(b => b.ToString("X2"))) + Environment.NewLine);
            }
            ExitCode = 0;
            return;
        }

        // ---------- 单实例保护（按端口区分）----------
        // 之前的行为：重复双击会弹出“端口被占用”的错误框然后静默退出，
        // 让用户以为“快捷方式点了没反应/托盘图标不出来”。现在改成：
        // 同一端口已有实例 -> 让已有实例把控制面板弹出来 -> 本次进程安静退出。
        // 注意互斥体带端口号：换端口启动第二个实例是允许的（便于同时管多台/多端口）。
        string mutexName = $"{MutexNameBase}.Port{port}";
        using var mutex = new Mutex(true, mutexName, out bool isFirstInstance);
        if (!isFirstInstance)
        {
            Log.Info($"端口 {port} 上已有实例在运行，通知它显示控制面板后退出");
            try
            {
                using var show = EventWaitHandle.OpenExisting($"{ShowEventNameBase}.Port{port}");
                show.Set();
            }
            catch (Exception ex)
            {
                Log.Warn("无法通知已有实例（可能是权限不同的会话）: " + ex.Message);
            }
            if (!silent)
            {
                ShowInfo($"被控端已经在运行了（端口 {port}）。\n\n" +
                         "已经帮你把正在运行的控制面板窗口调到前面；如果没看到，请检查任务栏右下角托盘区的蓝色显示器图标" +
                         "（可能被折叠进小箭头里）。\n\n" +
                         "想彻底重启：运行程序目录里的「结束被控端.cmd」，再重新启动。\n\n" +
                         "想同时再开一个（例如换个端口做测试）：用 --port 9000 指定别的端口即可。");
            }
            ExitCode = ExitAlreadyRunning;
            return;
        }

        Log.Info($"===== 局域网远程控制 被控端 v{Version} 启动（PID {Environment.ProcessId}）=====");
        Log.Info($"程序路径: {Environment.ProcessPath}");

        // 消息循环的“锚点”窗口：以后所有窗口都在 UI 线程上创建，
        // 避免从后台线程创建 Form（那会得到一个能显示但点不动的死窗口）。
        try
        {
            Winsta = new Winsta();
        }
        catch (Exception ex)
        {
            Log.Error("无法创建 UI 上下文: " + ex.Message);
            ExitCode = ExitStartupError;
            return;
        }

        var screen = new ScreenCapture();
        Context = new ServerContext
        {
            Screen = screen,
            PairCode = code,
            FileRoot = string.IsNullOrEmpty(fileRoot) ? DefaultFileRoot() : fileRoot,
        };

        // ---------- 端口：被占用时自动向后顺延，而不是直接失败 ----------
        int boundPort = StartServer(port, silent);
        if (boundPort < 0)
        {
            ExitCode = ExitPortFailed;
            WriteStatus("error", $"无法监听端口 {port}（以及后续 9 个端口）", null);
            return;
        }
        Started = true;
        WriteStatus("running", null, Server.Port);

        SetupExitHandles();

        Discovery.Start(Server.Port, Environment.MachineName);

        foreach (var ip in LocalAddresses())
            Log.Info($"监听地址: http://{ip}:{Server.Port}/  （配对码 {code}）");
        Log.Info($"文件传输根目录: {Context.FileRoot}");

        bool trayOk = false;
        if (noTray)
        {
            Log.Info("按 --no-tray 要求：不创建托盘图标，改用任务栏窗口");
        }
        else
        {
            trayOk = StartTray(silent);
            if (trayOk)
            {
                Log.Info("托盘图标已创建");
            }
            else
            {
                // 注意：重试必须放到后台线程！
                // 这里还是消息循环启动之前的 UI 线程，如果在这里 Sleep 重试，
                // 主窗口会显示成“假死”，看起来就像程序没启动成功。
                Log.Warn("托盘图标首次创建失败，改到后台线程重试（不阻塞界面）");
                Task.Run(() =>
                {
                    for (int i = 0; i < 15; i++)
                    {
                        Thread.Sleep(2000);
                        bool ok = false;
                        RunOnUi(() => ok = StartTray(true));
                        Thread.Sleep(150);
                        if (ok)
                        {
                            Log.Info($"托盘图标在第 {i + 1} 次重试后创建成功");
                            return;
                        }
                    }
                    Log.Error("托盘图标始终创建失败：已改用控制面板窗口作为入口（窗口在任务栏可见）");
                });
            }
        }

        // 系统音频自检：提前探测一次，控制面板/手机端才能立刻显示"能不能听电脑声音"
        Task.Run(() => SystemAudio.Probe());

        // 输入注入自检：如果当前会话不允许注入输入，鼠标键盘会“点了没反应”，
        // 这里直接检测并记录下来（控制面板与 /diag 都能看到）。
        var (injectOk, injectMsg) = InputInjector.SelfTest();
        InputInjectionOk = injectOk;        InputInjectionMessage = injectMsg;
        if (injectOk) Log.Info(injectMsg); else Log.Warn(injectMsg);

        // 启动后总是把控制面板显示出来：这样即使托盘图标被系统折叠/隐藏，
        // 用户也一定能看到“程序已启动 + 访问地址 + 配对码”，不会以为是没启动成功。
        if (!silent || noTray || !trayOk)
        {
            Log.Info("显示控制面板窗口（在任务栏可见）");
            OpenInfoWindow();
        }

        Log.Info("进入消息循环，程序已就绪");
        // 周期刷新状态文件（会话数/托盘状态会变）
        var statusTimer = new System.Windows.Forms.Timer { Interval = 5000 };
        statusTimer.Tick += (_, _) => WriteStatus("running", null, Server?.Port);
        statusTimer.Start();
        Application.Run(Winsta);
        statusTimer.Stop();
        Log.Info("消息循环结束");    }

    /// <summary>启动 HTTP 服务；端口被占用时自动尝试后续端口。返回实际端口，失败返回 -1。</summary>
    private static int StartServer(int preferredPort, bool silent)
    {
        for (int i = 0; i < 10; i++)
        {
            int candidate = preferredPort + i;
            if (candidate > 65535) break;
            var server = new HttpServer(candidate, RequestHandler.HandleAsync);
            try
            {
                server.Start();
                Server = server;
                if (i > 0) Log.Warn($"端口 {preferredPort} 被占用，已改用 {candidate}");
                return candidate;
            }
            catch (Exception ex)
            {
                Log.Warn($"端口 {candidate} 无法监听: {ex.Message}");
                try { server.Dispose(); } catch { }
            }
        }

        string msg = $"无法监听端口 {preferredPort}（以及后续 9 个端口）。\n\n" +
                     "可能是端口被其他程序占用，或安全软件拦截了监听。\n\n" +
                     "可以换一个端口试试：\nLanControlServer.exe --port 9000";
        Log.Error(msg.Replace("\n", " "));
        if (!silent) ShowFatal(msg);
        return -1;
    }

    /// <summary>
    /// --install：一键部署。创建桌面/开始菜单快捷方式、设置开机自启、放行防火墙。
    /// 报告会同时写到控制台（附加到调用者的控制台）和日志文件，便于从 .cmd 里直接看到结果。
    /// </summary>
    /// <summary>启动状态文件路径（--status-file 指定）。启动器据此判断到底起没起来、为什么没起来。</summary>
    public static string StatusFilePath { get; private set; } = "";

    /// <summary>
    /// 写状态文件：把"是否在监听 / 端口 / 托盘 / 注入能力 / 错误原因"落盘，
    /// 让启动器和诊断脚本能给出确切结论，而不是只显示一句"启动失败"。
    /// </summary>
    public static void WriteStatus(string state, string? error, int? port)
    {
        if (string.IsNullOrEmpty(StatusFilePath)) return;
        try
        {
            var sb = new StringBuilder();
            sb.AppendLine("state=" + state);
            sb.AppendLine("pid=" + Environment.ProcessId);
            sb.AppendLine("port=" + (port?.ToString() ?? ""));
            sb.AppendLine("exe=" + (Environment.ProcessPath ?? ""));
            sb.AppendLine("started=" + (Started ? "1" : "0"));
            sb.AppendLine("tray=" + (_tray != null && _tray.Visible ? "1" : "0"));
            sb.AppendLine("injection=" + (InputInjectionOk ? "1" : "0"));
            sb.AppendLine("sessions=" + (Context?.Sessions.Count ?? 0));
            sb.AppendLine("error=" + (error ?? ""));
            sb.AppendLine("time=" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
            File.WriteAllText(StatusFilePath, sb.ToString(), Encoding.UTF8);
        }
        catch { }
    }

    /// <summary>--scan-old：列出本机所有旧版本残留（不删除任何东西）。</summary>
    /// <summary>
    /// 取某个标志后面**紧跟**的那个参数（支持 "exe --flag 值" 这种位置写法）。
    /// 只认紧邻的一个，避免把别的标志当成值。
    /// </summary>
    /// <summary>
    /// 在参数里找"看起来像 wav 输出路径"的那一个。
    /// 比"取标志后面紧跟的参数"稳妥得多 —— 后者会把 --seconds 当成路径
    /// （真实踩过：录音被写进了一个名为 "--seconds" 的文件）。
    /// </summary>
    private static string FindWavPathArg(string[] args)
    {
        foreach (var a in args)
        {
            if (a.StartsWith("-", StringComparison.Ordinal)) continue;
            if (int.TryParse(a, out _)) continue;
            if (a.EndsWith(".wav", StringComparison.OrdinalIgnoreCase) ||
                a.Contains('\\') || a.Contains('/') || a.Contains(':'))
                return a;
        }
        return "";
    }

    /// <summary>取参数里第一个纯数字（用于 --seconds 10 这种位置写法）。</summary>
    private static int FirstNumberArg(string[] args, int fallback)
    {
        foreach (var a in args)
            if (int.TryParse(a, out int n) && n > 0) return n;
        return fallback;
    }

    private static void RunScanOld(bool showReport)
    {
        Log.Info("===== 旧版本排查 =====");
        Report.Init(showReport);
        Report.Head("旧版本残留排查（本机）");
        var items = OldVersionCleaner.Scan();
        Report.Line($"共发现 {items.Count} 项：");
        Report.Line();
        if (items.Count == 0)
        {
            Report.Line("  （很干净，没有发现旧版本残留）");
        }
        else
        {
            foreach (var g in items.GroupBy(i => i.Kind))
            {
                Report.Line($"## {g.Key}（{g.Count()} 项）");
                foreach (var f in g)
                {
                    Report.Line("   - " + f.Detail);
                    if (f.Path.Length > 0 && f.Path != f.Detail) Report.Line("     路径: " + f.Path);
                    if (f.IsCurrentInstall) Report.Line("     （这是当前正在使用的新版，清理时会保留）");
                }
                Report.Line();
            }
        }
        Report.Line(new string('-', 62));
        Report.Line("要删除上面这些旧版本残留（保留当前目录）：双击「清理旧版本.cmd」");
        Report.Line("本报告同时保存于: " + Report.FilePath);
        Report.Flush();
    }

    /// <summary>--clean-old：删除旧版本残留。keepSelf 语义固定为"保留当前程序目录"。</summary>
    private static void RunCleanOld(bool showReport, bool includeFirewall)
    {
        OldVersionCleaner.AttachToParentConsole();
        Log.Info("===== 旧版本清理 =====");
        Report.Init(showReport);
        Report.Head("清理旧版本残留");
        Report.Line("当前程序目录（会被保留）：" + AppContext.BaseDirectory.TrimEnd('\\'));
        Report.Line();

        var items = OldVersionCleaner.Scan();
        Report.Line($"本机共发现 {items.Count} 项相关残留，开始清理……");
        Report.Line();

        var results = OldVersionCleaner.Clean(keepSelf: true, includeFirewall: includeFirewall);
        foreach (var r in results) Report.Line("  " + r);

        Report.Line();
        Report.Line(new string('-', 62));
        Report.Line("清理后仍在的项目：");
        var left = OldVersionCleaner.Scan();
        if (left.Count == 0) Report.Line("  （没有剩余项）");
        foreach (var f in left)
        {
            Report.Line($"  - [{f.Kind}] {f.Detail}");
            if (f.IsCurrentInstall) Report.Line("     （当前使用的新版，属正常保留）");
        }
        Report.Line(new string('-', 62));
        Report.Flush();
        Log.Info("===== 旧版本清理结束 =====");
    }

    private static void RunInstall(int port, bool silent)
    {
        string exe = Environment.ProcessPath ?? Application.ExecutablePath;
        string dir = AppContext.BaseDirectory.TrimEnd('\\');
        AttachConsole(-1);
        // 控制台可能是 GBK 代码页，中文会显示成乱码 —— 报告统一用英文，
        // 详细的中文报告在日志文件里（server.log）。
        Console.OutputEncoding = Encoding.UTF8;
        var report = new StringBuilder();
        void Say(string en)
        {
            Log.Info("[安装] " + en);
            report.AppendLine(en);
            Console.WriteLine(en);
        }

        Log.Info($"===== 一键部署开始（程序目录 {dir}）=====");
        Console.WriteLine("-----------------------------------------------------------");
        Say("Program folder : " + dir);
        Say("Executable     : " + exe);

        // 1) 桌面快捷方式（带 --show，双击即可看到控制面板，不必去托盘里找）
        string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        string lnkDesktop = Path.Combine(desktop, "局域网远程控制.lnk");
        string? err = Shortcut.Create(lnkDesktop, exe, $"--show --port {port}", dir, "局域网远程控制 被控端");
        if (err == null)
        {
            var check = Shortcut.Read(lnkDesktop);
            Say("[OK]   desktop shortcut created: " + lnkDesktop);
            Say("       target      : " + check.target + " " + check.args);
            Say("       working dir : " + check.workdir);
            if (!check.target.Equals(exe, StringComparison.OrdinalIgnoreCase))
                Say("[WARN] shortcut target differs from this executable - did you move the folder?");
        }
        else
        {
            Say("[FAIL] desktop shortcut: " + err);
        }

        // 2) 开始菜单快捷方式
        try
        {
            string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            string lnkMenu = Path.Combine(programs, "局域网远程控制.lnk");
            string? e2 = Shortcut.Create(lnkMenu, exe, $"--show --port {port}", dir, "局域网远程控制 被控端");
            Say(e2 == null ? "[OK]   start menu shortcut created: " + lnkMenu : "[FAIL] start menu shortcut: " + e2);
        }
        catch (Exception ex) { Say("[FAIL] start menu shortcut: " + ex.Message); }

        // 3) 开机自启（当前用户，不需要管理员）
        try
        {
            using var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Run", true);
            // 开机自启：静默启动（只驻留托盘，不弹控制面板），避免每次开机都被窗口打扰
            k?.SetValue("LanControlServer", $"\"{exe}\" --port {port} --silent");
            Say("[OK]   auto-start registered for the current user (silent, tray only)");
        }
        catch (Exception ex) { Say("[FAIL] auto-start: " + ex.Message); }

        // 4) 记住端口
        try
        {
            using var k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(@"Software\LanControl");
            k?.SetValue("Port", port.ToString());
        }
        catch { }

        // 5) 防火墙（需要管理员）
        if (IsAdmin())
        {
            Say("Administrator detected - configuring Windows Firewall...");
            Say("  " + RunNetsh($"advfirewall firewall delete rule name=\"LanControl Server TCP\""));
            Say("  " + RunNetsh($"advfirewall firewall add rule name=\"LanControl Server TCP\" dir=in action=allow protocol=TCP localport={port} profile=private,domain"));
            Say("  " + RunNetsh($"advfirewall firewall delete rule name=\"LanControl Server UDP\""));
            Say("  " + RunNetsh($"advfirewall firewall add rule name=\"LanControl Server UDP\" dir=in action=allow protocol=UDP localport={DiscoveryPort} profile=private,domain"));
        }
        else
        {
            Say("[SKIP] firewall rules (not running as administrator)");
            Say("       Approve the Windows Firewall prompt on first run (tick 'Private networks'),");
            Say("       or right-click the deploy .cmd and choose 'Run as administrator'.");
        }

        Log.Info("===== 一键部署结束 =====");
        Console.WriteLine("-----------------------------------------------------------");
        Console.WriteLine("Full (Chinese) report: " + Log.LogFilePath);
        Console.WriteLine();

        // 如果已经运行着被控端，请它顺手把托盘图标提升为常显
        try
        {
            using var show = EventWaitHandle.OpenExisting($"{ShowEventNameBase}.Port{port}");
            show.Set();
            Say("[OK]   asked the running instance to show its control panel");
        }
        catch { }

        if (!silent)
        {
            ShowInfo("部署完成，结果如下：\n\n" + report +
                     "\n接下来：双击桌面上的「局域网远程控制」图标即可启动，" +
                     "启动后会直接弹出控制面板显示访问地址和配对码。\n\n" +
                     "托盘图标找不到？Windows 默认会把新图标放进“隐藏的图标”里：" +
                     "程序已尝试自动把它设为常显；若仍看不到，点任务栏右下角的小上箭头，" +
                     "把里面的蓝色显示器图标拖到任务栏上即可。\n\n" +
                     "完整的中文报告在日志文件里：\n" + Log.LogFilePath);
        }
    }

    [DllImport("kernel32.dll")]
    private static extern bool AttachConsole(int dwProcessId);

    /// <summary>
    /// --uninstall：清理部署痕迹。删除所有指向本程序的快捷方式（按目标解析，不靠猜名字）、
    /// 开机自启项、以及(如果有管理员权限)防火墙规则。
    /// </summary>
    private static void RunUninstall(bool silent)
    {
        string exe = Environment.ProcessPath ?? Application.ExecutablePath;
        string dir = AppContext.BaseDirectory.TrimEnd('\\');
        AttachConsole(-1);
        Console.OutputEncoding = Encoding.UTF8;
        var report = new StringBuilder();
        void Say(string en)
        {
            Log.Info("[卸载] " + en);
            report.AppendLine(en);
            Console.WriteLine(en);
        }

        Log.Info($"===== 清理部署开始（程序目录 {dir}）=====");
        Console.WriteLine("-----------------------------------------------------------");

        // 1) 快捷方式：遍历桌面/开始菜单/快速启动，解析目标后删除
        try
        {
            var removed = Shortcut.RemoveShortcutsPointingTo(exe, dir);
            if (removed.Count == 0)
            {
                Say("[OK]   no shortcut pointing to this program was found");
            }
            else
            {
                Say($"[OK]   removed {removed.Count} shortcut(s):");
                foreach (var p in removed) Say("         " + p);
            }
        }
        catch (Exception ex) { Say("[FAIL] shortcut cleanup: " + ex.Message); }

        // 1.5) 结束仍在运行的被控端（不结束就删不掉 exe/dll，会留下"半卸载"状态）
        try
        {
            Program.HandleRunningInstances(true, out string runMsg);
            Say("[OK]   " + runMsg.Replace("\n", "\n       "));
            report.AppendLine("运行状态: " + runMsg);
        }
        catch (Exception ex) { Say("[FAIL] running-instance cleanup: " + ex.Message); }

        // 2) 开机自启
        try
        {
            using var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Run", true);
            if (k?.GetValue("LanControlServer") != null)
            {
                k.DeleteValue("LanControlServer", false);
                Say("[OK]   auto-start entry removed");
            }
            else Say("[OK]   no auto-start entry");
        }
        catch (Exception ex) { Say("[FAIL] auto-start cleanup: " + ex.Message); }

        // 3) 端口记忆
        try
        {
            Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(@"Software\LanControl", false);
            Say("[OK]   saved port setting removed");
        }
        catch { }

        // 3.5) 托盘图标提升设置（真实残留项：以 exe 路径为键，程序退出时从不清理）
        try
        {
            int n = Program.CleanTrayPromotion();
            Say("[OK]   tray promotion entries cleaned: " + n);
            report.AppendLine("托盘注册表: 清理 " + n + " 项");
        }
        catch (Exception ex) { Say("[FAIL] tray registry cleanup: " + ex.Message); }

        // 4) 防火墙规则（需要管理员）
        if (IsAdmin())
        {
            Say("Administrator detected - removing firewall rules...");
            Say("  " + RunNetsh("advfirewall firewall delete rule name=\"LanControl Server TCP\""));
            Say("  " + RunNetsh("advfirewall firewall delete rule name=\"LanControl Server UDP\""));
        }
        else
        {
            Say("[SKIP] firewall rules need administrator rights");
            Say("       right-click the undeploy .cmd and choose 'Run as administrator' to remove them");
        }

        Log.Info("===== 清理部署结束 =====");
        Console.WriteLine("-----------------------------------------------------------");
        Console.WriteLine("Program files were NOT deleted; remove the folder manually if you want.");
        Console.WriteLine();

        if (!silent)
        {
            ShowInfo("清理完成：\n\n" + report + "\n程序文件本身没有删除，需要的话请手动删除该文件夹。");
        }
    }

    /// <summary>
    /// 删除托盘图标提升设置（HKCU\Control Panel\NotifyIconSettings）。
    ///
    /// 这是真实存在的"卸载后残留注册表"来源：程序为了让托盘图标常显，
    /// 会把对应条目的 IsPromoted 设为 1，而这些条目以 **exe 完整路径** 为键。
    /// 程序退出时没有任何地方清理它 —— 卸载后残留的就是这个。
    /// </summary>
    public static int CleanTrayPromotion()
    {
        int removed = 0;
        try
        {
            using var root = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                @"Control Panel\NotifyIconSettings", writable: true);
            if (root == null) return 0;

            string exe = "";
            try { exe = Environment.ProcessPath ?? ""; } catch { }
            string exeName = "LanControlServer.exe";
            string exeDir = "";
            try { exeDir = Path.GetDirectoryName(exe) ?? ""; } catch { }

            foreach (var name in root.GetSubKeyNames())
            {
                try
                {
                    using var k = root.OpenSubKey(name, writable: true);
                    if (k == null) continue;
                    string? path = k.GetValue("ExecutablePath") as string;
                    bool mine = false;
                    if (!string.IsNullOrEmpty(path))
                    {
                        // 同一个程序可能从不同目录装过多次，凡是本程序名的条目都算自己的
                        if (path.EndsWith(exeName, StringComparison.OrdinalIgnoreCase)) mine = true;
                        else if (!string.IsNullOrEmpty(exeDir) &&
                                 path.StartsWith(exeDir, StringComparison.OrdinalIgnoreCase)) mine = true;
                    }
                    if (!mine) continue;
                    k.DeleteValue("IsPromoted", false);
                    removed++;
                }
                catch { }
            }
        }
        catch { }
        return removed;
    }

    /// <summary>
    /// 检查被控端是否还在运行；kill 为真时结束它。
    ///
    /// 用**两条独立手段**检测，单独任何一条都可能漏报：
    ///   1) 命名互斥体 Global\LanControlServer.SingleInstance.PortN
    ///      —— 最可靠（启动即持有、退出即释放），不受会话/权限差异影响；
    ///      结束它走 ExitRequest 事件，让程序优雅退出而不是强杀。
    ///   2) 进程枚举（能看到就再补一刀）。
    ///
    /// 卸载前必须做：程序运行时会占用 exe/dll，卸载程序删不掉文件
    /// 就会中途报"文件被占用"，留下半卸载状态。
    /// </summary>
    public static int HandleRunningInstances(bool kill, out string summary)
    {
        var sb = new System.Text.StringBuilder();
        int found = 0;

        // --- 手段 1：命名互斥体（默认端口 + 可自动递增的前若干端口）---
        var busyPorts = new List<int>();
        for (int p = 8848; p <= 8858; p++)
        {
            try
            {
                if (Mutex.TryOpenExisting($"{MutexNameBase}.Port{p}", out var m))
                {
                    // 关键：必须区分"被真正持有"和"对象存在但没人在用"。
                    // 检查程序自己会创建这个互斥体（只要执行到初始化就会），
                    // 若不判断持有状态，--check-running 就会把自己当成"被控端正在运行"，
                    // 每次卸载都误报占用 —— 实测踩过。
                    bool held = false;
                    try { held = !m.WaitOne(0); }        // 拿不到 = 别人持有
                    catch (AbandonedMutexException) { held = false; }   // 属主已崩溃，不算占用
                    try { if (!held) m.ReleaseMutex(); } catch { }
                    m.Dispose();
                    if (held) busyPorts.Add(p);
                }
            }
            catch { }
        }
        if (busyPorts.Count > 0)
        {
            found += busyPorts.Count;
            sb.AppendLine("  按端口检测到运行中: " + string.Join(", ", busyPorts));
            if (kill)
            {
                foreach (var p in busyPorts)
                {
                    try
                    {
                        using var ev = EventWaitHandle.OpenExisting($"{ExitEventNameBase}.Port{p}");
                        ev.Set();   // 优雅退出信号
                        sb.AppendLine($"  端口 {p}: 已发送退出信号");
                    }
                    catch (Exception ex) { sb.AppendLine($"  端口 {p} 退出信号失败: {ex.Message}"); }
                }
                Thread.Sleep(1200);   // 给对方时间收尾并释放文件句柄
            }
        }

        // --- 手段 2：进程枚举 ---
        string me = "";
        try { me = Environment.ProcessPath ?? ""; } catch { }
        try
        {
            foreach (var proc in Process.GetProcessesByName("LanControlServer"))
            {
                try
                {
                    try { if (!string.IsNullOrEmpty(me) && proc.MainModule?.FileName == me) continue; } catch { }
                    if (found == 0) found++;
                    if (!kill) continue;
                    proc.Kill(entireProcessTree: true);
                    proc.WaitForExit(3000);
                }
                catch { }
                finally { try { proc.Dispose(); } catch { } }
            }
        }
        catch { }

        if (found == 0) summary = "没有正在运行的被控端";
        else summary = kill
            ? $"检测到 {found} 个运行中的被控端，已请求退出"
            : $"检测到 {found} 个运行中的被控端";
        if (sb.Length > 0) summary += "\n" + sb.ToString().TrimEnd();
        return found;
    }
    public static bool IsAdmin()
    {
        try
        {
            using var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
            var principal = new System.Security.Principal.WindowsPrincipal(identity);
            return principal.IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
        }
        catch { return false; }
    }

    private static string RunNetsh(string arguments)
    {
        try
        {
            var psi = new ProcessStartInfo("netsh", arguments)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var p = Process.Start(psi);
            if (p == null) return "✘ netsh 无法启动";
            string outp = p.StandardOutput.ReadToEnd();
            p.WaitForExit(15000);
            bool ok = p.ExitCode == 0;
            string what = arguments.Contains("add rule") ? "添加防火墙规则" : "清理旧防火墙规则";
            return (ok ? "✔ " : "✘ ") + what + (ok ? "成功" : "失败：" + outp.Trim());
        }
        catch (Exception ex)
        {
            return "✘ netsh 执行异常：" + ex.Message;
        }
    }

    /// <summary>注册“外部请求显示窗口”和“外部请求退出”事件（按端口区分）。</summary>
    private static void SetupExitHandles()
    {
        int port = Server.Port;
        // 供第二个实例/脚本通知已有实例弹出控制面板
        var showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, $"{ShowEventNameBase}.Port{port}");
        var waitShow = new Thread(() =>
        {
            while (true)
            {
                try
                {
                    showEvent.WaitOne();
                    Log.Info("收到“显示控制面板”请求");
                    // 关键：必须回到 UI 线程创建/显示窗口，否则窗口是死的（点不动）
                    RunOnUi(() => OpenInfoWindow());
                }
                catch { break; }
            }
        })
        { IsBackground = true, Name = "show-window-listener" };
        waitShow.Start();

        // 供脚本/安装程序请求优雅退出
        var exitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, $"{ExitEventNameBase}.Port{port}");
        var waitExit = new Thread(() =>
        {
            while (true)
            {
                try
                {
                    exitEvent.WaitOne();
                    Log.Info("收到“退出”请求，正在关闭");
                    Shutdown("外部退出请求");
                    RunOnUi(() => Environment.Exit(ExitCode));
                }
                catch { break; }
            }
        })
        { IsBackground = true, Name = "exit-listener" };
        waitExit.Start();
    }

    /// <summary>把动作切回 UI 线程执行（窗口必须由 UI 线程创建与操作）。</summary>
    public static void RunOnUi(Action action)
    {
        try
        {
            var anchor = Winsta;
            if (anchor != null && anchor.IsHandleCreated)
            {
                anchor.BeginInvoke(action);
                return;
            }
            action();
        }
        catch (Exception ex)
        {
            Log.Warn("切回 UI 线程失败: " + ex.Message);
            try { action(); } catch { }
        }
    }

    /// <summary>统一收尾：停监听、停推流、释放托盘，确保端口立刻释放。</summary>
    public static void Shutdown(string reason)
    {
        if (_shuttingDown) return;
        _shuttingDown = true;
        Log.Info($"开始退出流程（{reason}）");

        try
        {
            if (_tray != null)
            {
                _tray.Visible = false;
                _tray.Dispose();
                _tray = null;
                Log.Info("托盘图标已释放");
            }
        }
        catch (Exception ex) { Log.Warn("释放托盘失败: " + ex.Message); }

        try
        {
            if (Server != null) { Server.Dispose(); Log.Info("HTTP/WebSocket 监听已关闭，端口已释放"); }
        }
        catch (Exception ex) { Log.Warn("关闭监听失败: " + ex.Message); }

        try
        {
            foreach (var s in Context?.Sessions.Values ?? Enumerable.Empty<Agent>()) s.Stop();
        }
        catch { }

        try { Context?.Screen.Dispose(); } catch { }

        Log.Info("退出流程完成");
    }

    private static bool _shuttingDown;

    private static bool HasFlag(string[] args, string name)
        => args.Any(a => a.Equals(name, StringComparison.OrdinalIgnoreCase));

    private static int ArgInt(string[] args, string name, int fallback)
    {
        string v = ArgStr(args, name, "");
        return int.TryParse(v, out var n) ? n : fallback;
    }

    private static string ArgStr(string[] args, string name, string fallback)
    {
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i].Equals(name, StringComparison.OrdinalIgnoreCase) && i + 1 < args.Length) return args[i + 1];
            if (args[i].StartsWith(name + "=", StringComparison.OrdinalIgnoreCase)) return args[i][(name.Length + 1)..];
        }
        return fallback;
    }

    private static int? RegistryPort()
    {
        try
        {
            using var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\LanControl");
            if (k?.GetValue("Port") is string s && int.TryParse(s, out var p) && p is >= 1024 and <= 65535) return p;
        }
        catch { }
        return null;
    }

    /// <summary>
    /// 读取"固定配对码"。返回空串 = 未启用（每次启动随机生成）。
    /// 与端口记忆同键存储，卸载时会被一并清理。
    /// </summary>
    public static string ReadFixedCode()
    {
        // ① 注册表（首选，与端口记忆同键存储）
        try
        {
            using var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\LanControl");
            if (k?.GetValue("FixedCode") is string s && IsValidCode(s)) return s;
        }
        catch { }
        // ② 程序目录下的「固定配对码.txt」兜底。
        //    存在的意义：部分环境注册表不可写（权限受限/组策略），
        //    这时用户仍可用记事本写一个 6 位数字来固定配对码。
        try
        {
            string p = Path.Combine(AppContext.BaseDirectory, "固定配对码.txt");
            if (File.Exists(p))
            {
                string txt = File.ReadAllText(p).Trim();
                if (IsValidCode(txt)) return txt;
            }
        }
        catch { }
        return "";
    }

    /// <summary>写入固定配对码（传空串 = 取消固定，恢复每次随机）。</summary>
    public static bool SaveFixedCode(string code)
    {
        try
        {
            using var k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(@"Software\LanControl");
            if (k == null) return false;
            if (string.IsNullOrEmpty(code)) k.DeleteValue("FixedCode", false);
            else k.SetValue("FixedCode", code);
            TryWriteCodeFile(code);
            return true;
        }
        catch { return false; }
    }

    /// <summary>把固定码同步写到程序目录（注册表不可写时的兜底）。失败不影响主流程。</summary>
    private static void TryWriteCodeFile(string code)
    {
        try
        {
            string p = Path.Combine(AppContext.BaseDirectory, "固定配对码.txt");
            if (string.IsNullOrEmpty(code)) { if (File.Exists(p)) File.Delete(p); }
            else File.WriteAllText(p, code + Environment.NewLine, new System.Text.UTF8Encoding(false));
        }
        catch { }
    }

    /// <summary>配对码格式：6 位纯数字（内部不存空格，显示时才分组）。</summary>
    public static bool IsValidCode(string code)
    {
        if (string.IsNullOrEmpty(code) || code.Length != 6) return false;
        foreach (var c in code) if (c < '0' || c > '9') return false;
        return true;
    }

    /// <summary>显示成 "123 456"，方便手机端照抄（兼容历史数据：已带空格的原样返回）。</summary>
    public static string DisplayCode(string code)
    {
        string digits = code.Replace(" ", "");
        return digits.Length == 6 ? digits.Substring(0, 3) + " " + digits.Substring(3) : code;
    }

    private static string DefaultFileRoot()
    {
        // 优先放在用户目录下的“共享”文件夹；被拒绝时退回用户目录
        string user = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        foreach (var name in new[] { "LanControl共享", "Documents\\LanControl共享" })
        {
            try
            {
                string p = Path.Combine(user, name);
                Directory.CreateDirectory(p);
                return p;
            }
            catch { }
        }
        Log.Warn("无法创建共享目录，文件传输根目录改用用户目录");
        return user;
    }

    public static List<string> LocalAddresses()
    {
        var list = new List<string>();
        try
        {
            foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (ni.OperationalStatus != OperationalStatus.Up) continue;
                if (ni.NetworkInterfaceType is NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel) continue;
                foreach (var addr in ni.GetIPProperties().UnicastAddresses)
                {
                    if (addr.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                    var s = addr.Address.ToString();
                    if (s.StartsWith("169.254.")) continue;
                    if (!list.Contains(s)) list.Add(s);
                }
            }
        }
        catch { }
        if (list.Count == 0) list.Add("127.0.0.1");
        return list;
    }

    private static NotifyIcon? _tray;

    private static bool StartTray(bool silent)
    {
        try
        {
            // 重建场景下先清掉旧的，避免留下多个僵尸图标
            if (_tray != null)
            {
                try { _tray.Visible = false; _tray.Dispose(); } catch { }
                _tray = null;
            }
            _tray = new NotifyIcon
            {
                Icon = LoadIcon(),
                Text = $"局域网远程控制 被控端 (端口 {Server.Port})",
                Visible = true,
            };
            var menu = new ContextMenuStrip();
            menu.Items.Add($"配对码：{DisplayCode(Context.PairCode)}", null, (_, _) => CopyCode());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("打开控制面板 / 查看地址", null, (_, _) => OpenInfoWindow());
            menu.Items.Add("复制访问地址", null, (_, _) => CopyUrl());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("开机自启（当前用户）", null, (_, _) => ToggleStartup());
            menu.Items.Add("在资源管理器中打开共享目录", null, (_, _) => InputInjector.OpenPath(Context.FileRoot));
            menu.Items.Add("打开日志目录", null, (_, _) => InputInjector.OpenPath(Log.LogDirectory));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出", null, (_, _) => ExitFromTray());

            _tray.ContextMenuStrip = menu;
            _tray.DoubleClick += (_, _) => OpenInfoWindow();
            if (!silent)
            {
                _tray.ShowBalloonTip(4000, "局域网远程控制已启动",
                    $"手机浏览器打开 http://{LocalAddresses()[0]}:{Server.Port}/  或使用手机 App，配对码 {Context.PairCode}",
                    ToolTipIcon.Info);
            }
            // 记录托盘状态，便于事后确认图标到底建没建起来
            Log.Info($"托盘图标已注册（Visible={_tray.Visible}，图标={(_iconFromResource ? "程序自带" : "系统默认(未取到自带图标)")}）");
            // Windows 会把新出现的通知区图标先塞进“隐藏的图标”溢出区
            // （注册表 HKCU\Control Panel\NotifyIconSettings 里 IsPromoted 为空/0）。
            // 这里等系统登记完（约 1 秒）后主动把它提升为常显，否则用户永远找不到它。
            Task.Run(async () =>
            {
                await Task.Delay(1200);
                PromoteTrayIcon();
            });
            return true;
        }
        catch (Exception ex)
        {
            Log.Warn("托盘图标创建失败: " + ex.Message);
            return false;
        }
    }

    private static void ExitFromTray()
    {
        Log.Info("用户从托盘菜单选择退出");
        Shutdown("用户从托盘退出");
        Application.Exit();
        // 兜底：确保进程真的结束、端口真的释放（WinForms 消息循环偶发不退出）
        Environment.Exit(ExitCode);
    }

    /// <summary>用户点窗口右上角关闭：默认最小化到托盘，Shift+关闭 才真正退出。</summary>
    public static void HandleWindowClose(FormClosingEventArgs e)
    {
        if (e.CloseReason != CloseReason.UserClosing) return;
        if ((Control.ModifierKeys & Keys.Shift) == Keys.Shift)
        {
            Log.Info("窗口被 Shift+关闭，执行退出");
            Shutdown("关闭窗口");
            return;
        }
        e.Cancel = true;
        Log.Info("窗口被关闭，已最小化到托盘继续运行（Shift+关闭 可真正退出）");
    }

    private static Icon? _appIcon;
    private static bool _iconFromResource;

    private static Icon LoadIcon()
    {
        if (_appIcon != null) return _appIcon;
        try
        {
            var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("LanControl.app.ico");
            if (stream != null)
            {
                _appIcon = new Icon(stream);
                _iconFromResource = true;
                return _appIcon;
            }
            Log.Warn("嵌入图标资源未找到，改用系统默认图标");
        }
        catch (Exception ex) { Log.Warn("加载嵌入图标失败: " + ex.Message); }
        try
        {
            string exe = Environment.ProcessPath ?? "";
            if (File.Exists(exe))
            {
                var icon = Icon.ExtractAssociatedIcon(exe);
                if (icon != null)
                {
                    _appIcon = icon;
                    _iconFromResource = true;
                    return _appIcon;
                }
            }
        }
        catch { }
        _iconFromResource = false;
        _appIcon = SystemIcons.Application;
        return _appIcon;
    }

    /// <summary>供控制面板按钮调用：立即把托盘图标设为常显，并返回给用户看的说明。</summary>
    public static string PromoteTrayIconNow()
    {
        try
        {
            string exe = Environment.ProcessPath ?? Application.ExecutablePath;
            using var root = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                @"Control Panel\NotifyIconSettings", writable: true);
            if (root == null)
                return "这个 Windows 版本不使用通知区图标设置（比较少见）。\n\n" +
                       "请点任务栏右下角的小上箭头，把里面的蓝色显示器图标拖到任务栏上。";

            int patched = 0, matched = 0;
            foreach (var name in root.GetSubKeyNames())
            {
                using var k = root.OpenSubKey(name, writable: true);
                if (k == null) continue;
                string path = k.GetValue("ExecutablePath")?.ToString() ?? "";
                if (!path.Equals(exe, StringComparison.OrdinalIgnoreCase)) continue;
                matched++;
                if (!(k.GetValue("IsPromoted") is int v) || v != 1)
                {
                    k.SetValue("IsPromoted", 1, Microsoft.Win32.RegistryValueKind.DWord);
                    patched++;
                }
            }

            if (matched == 0)
                return "系统里还没有本程序的通知区记录。\n\n" +
                       "请确认程序正在运行，然后点任务栏右下角的小上箭头，" +
                       "把里面的蓝色显示器图标拖到任务栏上即可常显。";
            if (patched == 0)
                return "本程序的通知区图标已经是“常显”状态了。\n\n" +
                       "如果还是看不到，请点任务栏右下角的小上箭头查看，或重启一次资源管理器（explorer.exe）。";
            return "已把托盘图标设置为“常显”，现在应该能在任务栏右下角直接看到蓝色显示器图标了。\n\n" +
                   "（如果仍然看不到，点一下小上箭头展开隐藏图标区。）";
        }
        catch (Exception ex)
        {
            return "设置失败：" + ex.Message + "\n\n" +
                   "请点任务栏右下角的小上箭头，把里面的蓝色显示器图标拖到任务栏上。";
        }
    }

    /// <summary>
    /// 把本程序的通知区图标提升为“常显”（相当于用户手动把图标从溢出区拖出来）。
    /// 依据：HKCU\Control Panel\NotifyIconSettings\&lt;hash&gt; 下的 IsPromoted 值，
    /// 按 ExecutablePath 找到我们的条目后写 1。Windows 10 1809+ 支持。
    /// </summary>
    private static void PromoteTrayIcon()
    {
        try
        {
            string exe = Environment.ProcessPath ?? Application.ExecutablePath;
            using var root = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                @"Control Panel\NotifyIconSettings", writable: true);
            if (root == null)
            {
                Log.Info("系统未使用 NotifyIconSettings（旧版 Windows），跳过托盘图标提升");
                return;
            }

            int patched = 0, scanned = 0;
            foreach (var name in root.GetSubKeyNames())
            {
                using var k = root.OpenSubKey(name, writable: true);
                if (k == null) continue;
                scanned++;
                string path = k.GetValue("ExecutablePath")?.ToString() ?? "";
                if (!path.Equals(exe, StringComparison.OrdinalIgnoreCase)) continue;
                var promoted = k.GetValue("IsPromoted");
                int value = promoted is int i ? i : 0;
                if (value == 0)
                {
                    k.SetValue("IsPromoted", 1, Microsoft.Win32.RegistryValueKind.DWord);
                    patched++;
                }
            }

            if (patched > 0) Log.Info($"已把托盘图标设置为常显（IsPromoted=1，匹配条目 {patched}/{scanned}）");
            else Log.Info($"托盘图标提升检查完成（扫描 {scanned} 条，无需修改）");
        }
        catch (Exception ex)
        {
            Log.Warn("托盘图标提升失败（不影响使用，可手动从隐藏图标区拖出）: " + ex.Message);
        }
    }

    private static void CopyCode()
    {
        try { Clipboard.SetText(Context.PairCode); } catch { }
    }

    private static void CopyUrl()
    {
        try { Clipboard.SetText(Url); } catch { }
    }

    /// <summary>系统音频（电脑声音）是否可采集。启动后探测一次并缓存。</summary>
    public static bool AudioAvailable => SystemAudio.Available;

    /// <summary>音频不可用时的原因说明（手机端会显示）。</summary>
    public static string AudioMessage => SystemAudio.Message;

    public static string Url => $"http://{LocalAddresses()[0]}:{Server.Port}/";

    /// <summary>带配对码的访问地址（二维码用），手机扫码后不用手输配对码。</summary>
    public static string PairUrl => $"http://{LocalAddresses()[0]}:{Server.Port}/?code={Context.PairCode}";

    /// <summary>托盘图标当前是否真的在显示（供控制面板显示状态）。</summary>
    public static bool TrayVisible => _tray != null && _tray.Visible;

    private static void ToggleStartup()
    {
        try
        {
            string exe = Environment.ProcessPath ?? Application.ExecutablePath;
            string key = @"Software\Microsoft\Windows\CurrentVersion\Run";
            using var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(key, true);
            if (k == null) return;
            if (k.GetValue("LanControlServer") != null)
            {
                k.DeleteValue("LanControlServer", false);
                ShowInfo("已取消开机自启。");
            }
            else
            {
                k.SetValue("LanControlServer", $"\"{exe}\" --port {Server.Port} --code {Context.PairCode} --silent");
                ShowInfo("已设置为开机自启（当前用户，静默启动：只驻留托盘，不弹窗口）。");
            }
        }
        catch (Exception ex)
        {
            ShowInfo("设置失败：" + ex.Message);
        }
    }

    private static void ShowInfo(string text)
    {
        try { MessageBox.Show(text, "局域网远程控制", MessageBoxButtons.OK, MessageBoxIcon.Information); }
        catch { Log.Info("提示: " + text.Replace("\n", " ")); }
    }

    private static void ShowFatal(string text)
    {
        Log.Error(text.Replace("\n", " "));
        try { MessageBox.Show(text, "局域网远程控制", MessageBoxButtons.OK, MessageBoxIcon.Error); }
        catch { }
    }

    private static InfoForm? _info;
    internal static Winsta? Winsta;
    /// <summary>控制面板是否处于打开状态（Explorer 重启后据此恢复窗口）。</summary>
    public static bool WindowWasOpen => _info != null && !_info.IsDisposed && _info.Visible;

    /// <summary>重新创建托盘图标（Explorer 重启后调用）。</summary>
    public static void RecreateTray()
    {
        try
        {
            if (_tray != null)
            {
                try { _tray.Visible = false; _tray.Dispose(); } catch { }
                _tray = null;
            }
            bool ok = StartTray(true);
            if (!ok)
            {
                // 任务栏可能还没准备好，稍后重试几次
                for (int i = 0; i < 5 && !ok; i++)
                {
                    Thread.Sleep(1000);
                    ok = StartTray(true);
                    Log.Info($"托盘图标重建重试 #{i + 1}：{(ok ? "成功" : "仍失败")}");
                }
            }
            Log.Info(ok ? "托盘图标已重建" : "托盘图标重建失败（可在托盘区手动运行一次启动器）");
        }
        catch (Exception ex) { Log.Warn("重建托盘失败: " + ex.Message); }
    }

    /// <summary>显示控制面板（必须在 UI 线程调用）。</summary>
    public static void OpenInfoWindow()
    {
        try
        {
            if (_info == null || _info.IsDisposed)
            {
                _info = new InfoForm();
                _info.FormClosed += (_, _) => _info = null;
            }
            if (!_info.Visible) _info.Show();
            if (_info.WindowState == FormWindowState.Minimized) _info.WindowState = FormWindowState.Normal;
            _info.ShowInTaskbar = true;
            _info.Activate();
            _info.BringToFront();
            ForceForeground(_info.Handle);
            Log.Info($"控制面板已显示（可见={_info.Visible}，位置={_info.Location}，尺寸={_info.Size}）");
        }
        catch (Exception ex)
        {
            Log.Warn("打开控制面板失败: " + ex.Message);
        }
    }

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    private static void ForceForeground(IntPtr hWnd)
    {
        try
        {
            if (hWnd == IntPtr.Zero) return;
            ShowWindow(hWnd, 9);          // SW_RESTORE
            SetForegroundWindow(hWnd);
        }
        catch { }
    }
}

/// <summary>
/// 隐藏的“锚点”窗口：承载消息循环，并接收 Explorer 重启广播（TaskbarCreated）
/// 以便自动重建托盘图标。所有窗口都由它（UI 线程）创建。
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class Winsta : Form
{
    /// <summary>
    /// Explorer 重启后会向所有顶层窗口广播这个"注册消息"。
    /// 注意：它必须用 RegisterWindowMessage("TaskbarCreated") 取得 —— 消息号是系统
    /// 随机分配的（实测本机为 0xC0BB），硬编码任何常量都收不到，
    /// 那样托盘图标在 Explorer 重启后就永远回不来了。
    /// </summary>
    private static readonly uint WM_TASKBARCREATED = RegisterWindowMessage("TaskbarCreated");

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern uint RegisterWindowMessage(string lpString);

    public Winsta()
    {
        ShowInTaskbar = false;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        Location = new Point(-32000, -32000);
        Size = new Size(1, 1);
        Text = "LanControl";
        Log.Info($"TaskbarCreated 注册消息号 = 0x{WM_TASKBARCREATED:X4}（托盘图标将在此广播后自动重建）");
    }

    protected override void SetVisibleCore(bool value) => base.SetVisibleCore(value: false);

    protected override void WndProc(ref Message m)
    {
        base.WndProc(ref m);
        if (WM_TASKBARCREATED != 0 && (uint)m.Msg == WM_TASKBARCREATED)
        {
            Log.Info($"收到 WM_TASKBARCREATED(0x{m.Msg:X4})：任务栏重建，开始重建托盘图标");
            Program.RecreateTray();
            if (Program.WindowWasOpen) Program.OpenInfoWindow();
        }
    }
}
