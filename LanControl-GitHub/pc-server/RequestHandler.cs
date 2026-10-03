using System.Diagnostics;
using System.Reflection;
using System.Text;
using System.Text.Json.Nodes;

namespace LanControl;

/// <summary>HTTP 路由：静态页面 / WebSocket / 文件传输 / 健康检查。</summary>
internal static class RequestHandler
{
    public static async Task HandleAsync(HttpRequestEx req, HttpResponseEx res)
    {
        string path = req.Path;

        if (path == "/" || path.Equals("/index.html", StringComparison.OrdinalIgnoreCase))
        {
            await ServeWebAsync(res, "index.html", "text/html; charset=utf-8");
            return;
        }
        if (path.StartsWith("/web/", StringComparison.OrdinalIgnoreCase))
        {
            await ServeWebAsync(res, path[5..], GuessType(path));
            return;
        }

        if (path.Equals("/ws", StringComparison.OrdinalIgnoreCase))
        {
            if (!req.IsWebSocket)
            {
                await res.SendJsonAsync(Json.Str(new { ok = false, error = "需要 WebSocket 升级" }), 400);
                return;
            }
            var ws = HttpServer.AcceptWebSocket(req, req.Stream);
            if (ws == null)
            {
                await res.SendJsonAsync(Json.Str(new { ok = false, error = "WebSocket 握手失败" }), 400);
                return;
            }
            var agent = new Agent(ws, Program.Context, req.ClientIp);
            await agent.RunAsync();
            return;
        }

        if (path.Equals("/ping", StringComparison.OrdinalIgnoreCase))
        {
            await res.SendJsonAsync(Json.Str(new
            {
                ok = true,
                app = "LanControl",
                version = Program.Version,
                host = Environment.MachineName,
                needAuth = true,
            }));
            return;
        }

        if (path.Equals("/diag", StringComparison.OrdinalIgnoreCase))
        {
            var (cpu, memUsed, memTotal) = SystemStats.Snapshot();
            await res.SendJsonAsync(Json.Str(new
            {
                ok = true,
                version = Program.Version,
                pid = Environment.ProcessId,
                exe = Environment.ProcessPath,
                port = Program.Server?.Port ?? 0,
                started = Program.Started,
                inputInjectionOk = Program.InputInjectionOk,
                inputInjectionMessage = Program.InputInjectionMessage,
                desktop = new
                {
                    virtualX = InputInjector.VirtualLeft,
                    virtualY = InputInjector.VirtualTop,
                    width = InputInjector.VirtualWidth,
                    height = InputInjector.VirtualHeight,
                },
                cursor = new { x = InputInjector.CursorPosition().X, y = InputInjector.CursorPosition().Y },
                monitors = Program.Context.Screen.Monitors.Select(m => new { m.Index, m.Label, m.Primary, m.Bounds.Width, m.Bounds.Height }),
                sessions = Program.Context.Sessions.Count,
                pairCodeLength = Program.Context.PairCode.Length,
                cpuPercent = cpu,
                memUsedGb = memUsed,
                memTotalGb = memTotal,
                logFile = Log.LogFilePath,
            }));
            return;
        }

        // 列出服务端支持的键名 —— 自检脚本用它核对手机端键盘上的每个键。
        // 存在的意义：手机端曾把 'shiftL' 当作键名发给服务端，而服务端不认，
        // 表现是"Shift 键完全无效"，但客户端毫无提示、极难排查。
        if (path.Equals("/api/keys", StringComparison.OrdinalIgnoreCase))
        {
            var list = InputInjector.SupportedKeys.OrderBy(k => k, StringComparer.Ordinal).ToArray();
            await res.SendJsonAsync(Json.Str(new
            {
                ok = true,
                count = list.Length,
                keys = list,
            }));
            return;
        }
        if (path.Equals("/api/files", StringComparison.OrdinalIgnoreCase))
        {
            string p = req.Query("path", Program.Context.FileRoot);
            await res.SendJsonAsync(Json.Str(FileService.ListDirectory(p, Program.Context.FileRoot)));
            return;
        }

        if (path.Equals("/api/delete", StringComparison.OrdinalIgnoreCase))
        {
            var body = Json.Parse(Encoding.UTF8.GetString(req.Body)) ?? new JsonObject();
            var r = FileService.Delete(Json.GetString(body, "path"));
            await res.SendJsonAsync(Json.Str(new { ok = r.ok, message = r.message }));
            return;
        }

        if (path.Equals("/api/mkdir", StringComparison.OrdinalIgnoreCase))
        {
            var body = Json.Parse(Encoding.UTF8.GetString(req.Body)) ?? new JsonObject();
            var r = FileService.CreateDirectory(Json.GetString(body, "path"), Json.GetString(body, "name"));
            await res.SendJsonAsync(Json.Str(new { ok = r.ok, message = r.message, path = r.path }));
            return;
        }

        if (path.Equals("/api/rename", StringComparison.OrdinalIgnoreCase))
        {
            var body = Json.Parse(Encoding.UTF8.GetString(req.Body)) ?? new JsonObject();
            var r = FileService.Rename(Json.GetString(body, "path"), Json.GetString(body, "name"));
            await res.SendJsonAsync(Json.Str(new { ok = r.ok, message = r.message, path = r.path }));
            return;
        }

        if (path.Equals("/upload", StringComparison.OrdinalIgnoreCase) && req.Method == "POST")
        {
            string target = req.Query("dir", Program.Context.FileRoot);
            if (target == "::drives" || string.IsNullOrWhiteSpace(target)) target = Program.Context.FileRoot;
            target = FileService.ResolveAlias(target);
            try
            {
                string boundary = "";
                var ct = req.Header("Content-Type");
                int bi = ct.IndexOf("boundary=", StringComparison.OrdinalIgnoreCase);
                if (bi >= 0)
                {
                    boundary = ct[(bi + 9)..].Trim();
                    if (boundary.StartsWith('"') && boundary.EndsWith('"') && boundary.Length > 1) boundary = boundary[1..^1];
                }
                var file = FileService.ParseSingleFileUpload(req.Body, boundary);
                if (file == null)
                {
                    await res.SendJsonAsync(Json.Str(new { ok = false, message = "未解析到上传文件" }), 400);
                    return;
                }
                Directory.CreateDirectory(target);
                string safeName = Path.GetFileName(file.Value.fileName);
                if (string.IsNullOrWhiteSpace(safeName)) safeName = $"upload-{DateTime.Now:HHmmss}.bin";
                string full = Path.Combine(target, safeName);
                string ext = Path.GetExtension(full), stem = Path.GetFileNameWithoutExtension(full);
                int i = 1;
                while (File.Exists(full)) full = Path.Combine(target, $"{stem} ({i++}){ext}");
                await File.WriteAllBytesAsync(full, file.Value.data);
                Log.Info($"收到上传文件: {full} ({file.Value.data.Length} 字节) 来自 {req.ClientIp}");
                await res.SendJsonAsync(Json.Str(new { ok = true, message = "上传完成", path = full, size = file.Value.data.Length }));
            }
            catch (Exception ex)
            {
                await res.SendJsonAsync(Json.Str(new { ok = false, message = ex.Message }), 500);
            }
            return;
        }

        if (path.Equals("/download", StringComparison.OrdinalIgnoreCase))
        {
            string filePath = req.Query("path");
            try
            {
                var fi = new FileInfo(filePath);
                if (!fi.Exists)
                {
                    await res.SendTextAsync("文件不存在", status: 404);
                    return;
                }
                long start = 0, end = fi.Length - 1;
                var range = req.Header("Range");
                bool partial = false;
                if (!string.IsNullOrEmpty(range) && range.StartsWith("bytes=", StringComparison.OrdinalIgnoreCase))
                {
                    var spec = range[6..].Split('-');
                    if (spec.Length == 2)
                    {
                        if (long.TryParse(spec[0], out var s)) start = s;
                        if (long.TryParse(spec[1], out var e)) end = e;
                        if (end >= fi.Length) end = fi.Length - 1;
                        if (start < 0) start = 0;
                        if (end < start) end = fi.Length - 1;
                        partial = true;
                    }
                }
                long length = end - start + 1;
                var extra = new Dictionary<string, string>
                {
                    ["Content-Disposition"] = $"attachment; filename*=UTF-8''{Uri.EscapeDataString(fi.Name)}",
                    ["Accept-Ranges"] = "bytes",
                };
                if (partial) extra["Content-Range"] = $"bytes {start}-{end}/{fi.Length}";
                await res.SendStreamAsync(partial ? 206 : 200, FileService.ContentType(fi.Name), length, async stream =>
                {
                    await using var fs = new FileStream(fi.FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 128 * 1024, true);
                    fs.Seek(start, SeekOrigin.Begin);
                    var buffer = new byte[128 * 1024];
                    long remaining = length;
                    while (remaining > 0)
                    {
                        int n = await fs.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, remaining)));
                        if (n <= 0) break;
                        await stream.WriteAsync(buffer.AsMemory(0, n));
                        remaining -= n;
                    }
                }, extra);
            }
            catch (Exception ex)
            {
                await res.SendTextAsync("下载失败: " + ex.Message, status: 500);
            }
            return;
        }

        await res.SendTextAsync("404 Not Found: " + path, status: 404);
    }

    private static string GuessType(string path)
    {
        string ext = Path.GetExtension(path).ToLowerInvariant();
        return ext switch
        {
            ".css" => "text/css; charset=utf-8",
            ".js" => "application/javascript; charset=utf-8",
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".svg" => "image/svg+xml",
            ".ico" => "image/x-icon",
            ".html" => "text/html; charset=utf-8",
            ".json" => "application/json; charset=utf-8",
            ".woff2" => "font/woff2",
            _ => "application/octet-stream",
        };
    }

    /// <summary>静态资源优先从 www 目录读取（便于调试），否则使用嵌入资源。</summary>
    private static async Task ServeWebAsync(HttpResponseEx res, string relative, string contentType)
    {
        relative = relative.Replace('/', Path.DirectorySeparatorChar).Replace("..", "");
        try
        {
            string local = Path.Combine(AppContext.BaseDirectory, "www", relative);
            if (File.Exists(local))
            {
                var bytes = await File.ReadAllBytesAsync(local);
                await res.SendAsync(200, contentType, bytes);
                return;
            }
        }
        catch { }

        var asm = Assembly.GetExecutingAssembly();
        string name = "LanControl.www." + relative.Replace(Path.DirectorySeparatorChar, '.');
        using var stream = asm.GetManifestResourceStream(name);
        if (stream == null)
        {
            await res.SendTextAsync("资源未找到: " + relative, status: 404);
            return;
        }
        using var ms = new MemoryStream();
        await stream.CopyToAsync(ms);
        await res.SendAsync(200, contentType, ms.ToArray());
    }
}
