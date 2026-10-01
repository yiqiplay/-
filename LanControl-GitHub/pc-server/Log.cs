using System.Text;

namespace LanControl;

/// <summary>简单日志：同时输出到控制台与 %LOCALAPPDATA%\LanControl\server.log。</summary>
internal static class Log
{
    private static readonly object Lock = new();
    private static string? _file;
    private static bool _consoleOk = true;

    public static string LogDirectory { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LanControl");

    /// <summary>当前日志文件完整路径（供错误提示里展示）。</summary>
    public static string LogFilePath => _file ?? Path.Combine(LogDirectory, "server.log");

    public static void Init(string? extraLogFile = null)
    {
        try
        {
            Directory.CreateDirectory(LogDirectory);
            _file = string.IsNullOrWhiteSpace(extraLogFile) ? Path.Combine(LogDirectory, "server.log") : extraLogFile;
            var dir = Path.GetDirectoryName(_file);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            if (File.Exists(_file) && new FileInfo(_file).Length > 2 * 1024 * 1024)
                File.Move(_file, _file + ".1", true);
        }
        catch
        {
            // 用户目录不可写时，退回到程序同目录，避免完全没有日志
            try
            {
                string local = Path.Combine(AppContext.BaseDirectory, "server.log");
                File.AppendAllText(local, "");
                _file = local;
            }
            catch { _file = null; }
        }
    }

    public static void Info(string msg) => Write("INFO ", msg);
    public static void Warn(string msg) => Write("WARN ", msg);
    public static void Debug(string msg) => Write("DEBUG", msg);
    public static void Error(string msg) => Write("ERROR", msg);

    private static void Write(string level, string msg)
    {
        var line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} [{level}] {msg}";
        lock (Lock)
        {
            if (_consoleOk)
            {
                try { Console.WriteLine(line); }
                catch { _consoleOk = false; }
            }
            if (_file != null)
            {
                try { File.AppendAllText(_file, line + Environment.NewLine, Encoding.UTF8); } catch { }
            }
        }
    }
}
