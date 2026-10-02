using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;

namespace LanControl;

internal sealed class HttpRequestEx
{
    public string Method = "GET";
    public string RawTarget = "/";
    public string Path = "/";
    public Dictionary<string, string> QueryParams = new(StringComparer.OrdinalIgnoreCase);
    public readonly Dictionary<string, string> Headers = new(StringComparer.OrdinalIgnoreCase);
    public byte[] Body = Array.Empty<byte>();
    public bool IsWebSocket;
    public string ClientIp = "";
    public Stream Stream = Stream.Null;

    public string Query(string key, string fallback = "") => QueryParams.TryGetValue(key, out var v) ? v : fallback;
    public string Header(string key, string fallback = "") => Headers.TryGetValue(key, out var v) ? v : fallback;
}

internal sealed class HttpResponseEx
{
    private readonly Stream _stream;
    public bool KeepAlive = true;
    public bool HeadOnly;

    public HttpResponseEx(Stream stream, bool keepAlive, bool headOnly)
    {
        _stream = stream;
        KeepAlive = keepAlive;
        HeadOnly = headOnly;
    }

    public async Task SendAsync(int status, string contentType, byte[] body, Dictionary<string, string>? extra = null)
    {
        var head = new StringBuilder();
        head.Append("HTTP/1.1 ").Append(status).Append(' ').Append(StatusText(status)).Append("\r\n");
        head.Append("Content-Type: ").Append(contentType).Append("\r\n");
        head.Append("Content-Length: ").Append(body.Length).Append("\r\n");
        head.Append("Cache-Control: no-store\r\n");
        head.Append("Connection: ").Append(KeepAlive ? "keep-alive" : "close").Append("\r\n");
        if (extra != null)
            foreach (var kv in extra) head.Append(kv.Key).Append(": ").Append(kv.Value).Append("\r\n");
        head.Append("\r\n");
        await _stream.WriteAsync(Encoding.ASCII.GetBytes(head.ToString()));
        if (!HeadOnly && body.Length > 0) await _stream.WriteAsync(body);
        await _stream.FlushAsync();
    }

    public Task SendTextAsync(string text, string contentType = "text/plain; charset=utf-8", int status = 200)
        => SendAsync(status, contentType, Encoding.UTF8.GetBytes(text));

    public Task SendJsonAsync(string json, int status = 200) => SendTextAsync(json, "application/json; charset=utf-8", status);

    public async Task SendStreamAsync(int status, string contentType, long length, Func<Stream, Task> writer, Dictionary<string, string>? extra = null)
    {
        var head = new StringBuilder();
        head.Append("HTTP/1.1 ").Append(status).Append(' ').Append(StatusText(status)).Append("\r\n");
        head.Append("Content-Type: ").Append(contentType).Append("\r\n");
        if (length >= 0) head.Append("Content-Length: ").Append(length).Append("\r\n");
        head.Append("Connection: ").Append(KeepAlive ? "keep-alive" : "close").Append("\r\n");
        if (extra != null)
            foreach (var kv in extra) head.Append(kv.Key).Append(": ").Append(kv.Value).Append("\r\n");
        head.Append("\r\n");
        await _stream.WriteAsync(Encoding.ASCII.GetBytes(head.ToString()));
        if (!HeadOnly) await writer(_stream);
        await _stream.FlushAsync();
    }

    private static string StatusText(int status) => status switch
    {
        200 => "OK", 204 => "No Content", 206 => "Partial Content", 302 => "Found", 304 => "Not Modified",
        400 => "Bad Request", 401 => "Unauthorized", 403 => "Forbidden", 404 => "Not Found",
        405 => "Method Not Allowed", 413 => "Payload Too Large", 500 => "Internal Server Error",
        _ => "OK",
    };
}

/// <summary>
/// 轻量 HTTP/1.1 服务器（支持 WebSocket 升级、multipart 上传、大文件流式下载）。
/// 自己实现的原因：HttpListener 绑定非 localhost 需要管理员配置 URL ACL，而本程序要求普通权限即可运行。
/// </summary>
internal sealed class HttpServer : IDisposable
{
    private readonly TcpListener _listener;
    private readonly Func<HttpRequestEx, HttpResponseEx, Task> _handler;
    private readonly CancellationTokenSource _cts = new();
    private readonly List<Task> _clients = new();
    private readonly object _lock = new();

    public HttpServer(int port, Func<HttpRequestEx, HttpResponseEx, Task> handler)
    {
        _handler = handler;
        _listener = new TcpListener(IPAddress.Any, port);
    }

    public int Port => ((IPEndPoint)_listener.LocalEndpoint).Port;

    public void Start()
    {
        _listener.Start();
        _ = AcceptLoop();
    }

    private async Task AcceptLoop()
    {
        while (!_cts.IsCancellationRequested)
        {
            TcpClient client;
            try { client = await _listener.AcceptTcpClientAsync(_cts.Token); }
            catch { break; }
            var task = Task.Run(() => HandleClient(client));
            lock (_lock) { _clients.RemoveAll(t => t.IsCompleted); _clients.Add(task); }
        }
    }

    private async Task HandleClient(TcpClient client)
    {
        client.NoDelay = true;
        using var _ = client;
        var remote = client.Client.RemoteEndPoint as IPEndPoint;
        string ip = remote?.Address.ToString() ?? "?";
        try
        {
            using var stream = client.GetStream();
            while (!_cts.IsCancellationRequested)
            {
                var req = await ReadRequest(stream, ip);
                if (req == null) break;
                req.Stream = stream;
                bool headOnly = req.Method.Equals("HEAD", StringComparison.OrdinalIgnoreCase);
                bool keepAlive = !req.Header("Connection", "keep-alive").Equals("close", StringComparison.OrdinalIgnoreCase);
                var res = new HttpResponseEx(stream, keepAlive, headOnly);
                try
                {
                    await _handler(req, res);
                }
                catch (Exception ex)
                {
                    Log.Warn($"处理请求 {req.Path} 出错: {ex.Message}");
                    try { await res.SendJsonAsync(Json.Str(new { ok = false, error = ex.Message }), 500); } catch { }
                }
                if (req.IsWebSocket || !keepAlive) break;
            }
        }
        catch (Exception ex)
        {
            Log.Debug($"连接结束 {ip}: {ex.Message}");
        }
    }

    private static async Task<HttpRequestEx?> ReadRequest(NetworkStream stream, string ip)
    {
        var header = new MemoryStream();
        var buffer = new byte[8192];
        int matched = 0;
        // 有效数据长度（header.Length 会把“正文部分”也算进去，所以要单独记录）
        int valid = 0;
        // 请求头结束符之后，属于请求体的字节数（同一个 TCP 包里可能已经带了 body）
        int bodyInBuffer = 0;
        bool headDone = false;

        while (!headDone)
        {
            int n = await stream.ReadAsync(buffer);
            if (n <= 0) return null;
            header.Write(buffer, 0, n);
            valid += n;
            for (int i = 0; i < n; i++)
            {
                byte b = buffer[i];
                matched = b switch
                {
                    (byte)'\r' when matched is 0 or 2 => matched + 1,
                    (byte)'\n' when matched is 1 => 2,
                    (byte)'\n' when matched is 3 => 4,
                    _ => 0,
                };
                if (matched == 4)
                {
                    headDone = true;
                    bodyInBuffer = n - 1 - i;
                    break;
                }
            }
            if (valid > 256 * 1024) return null;
        }

        var headerBytes = header.ToArray();
        int headLength = valid - bodyInBuffer;
        if (headLength <= 0) return null;
        var text = Encoding.UTF8.GetString(headerBytes, 0, headLength);
        var lines = text.Split("\r\n");
        if (lines.Length == 0) return null;
        var parts = lines[0].Split(' ');
        if (parts.Length < 3) return null;

        var req = new HttpRequestEx { Method = parts[0].ToUpperInvariant(), RawTarget = parts[1], ClientIp = ip };
        int q = req.RawTarget.IndexOf('?');
        if (q >= 0)
        {
            req.Path = Uri.UnescapeDataString(req.RawTarget[..q]);
            foreach (var kv in req.RawTarget[(q + 1)..].Split('&', StringSplitOptions.RemoveEmptyEntries))
            {
                int eq = kv.IndexOf('=');
                if (eq < 0) req.QueryParams[Uri.UnescapeDataString(kv)] = "";
                else req.QueryParams[Uri.UnescapeDataString(kv[..eq])] = Uri.UnescapeDataString(kv[(eq + 1)..].Replace('+', ' '));
            }
        }
        else req.Path = Uri.UnescapeDataString(req.RawTarget);

        for (int i = 1; i < lines.Length; i++)
        {
            var line = lines[i];
            if (string.IsNullOrEmpty(line)) break;
            int colon = line.IndexOf(':');
            if (colon <= 0) continue;
            req.Headers[line[..colon].Trim()] = line[(colon + 1)..].Trim();
        }

        req.IsWebSocket = req.Header("Upgrade").Equals("websocket", StringComparison.OrdinalIgnoreCase);

        if (!req.IsWebSocket)
        {
            long contentLength = 0;
            long.TryParse(req.Header("Content-Length", "0"), out contentLength);
            if (contentLength > 0)
            {
                if (contentLength > 4L * 1024 * 1024 * 1024) throw new InvalidOperationException("请求体过大");
                var body = new byte[contentLength];
                int read = 0;
                // 先把和请求头同一个 TCP 包里的那部分正文收进来，再从流里补齐剩余部分
                if (bodyInBuffer > 0)
                {
                    int take = (int)Math.Min(bodyInBuffer, contentLength);
                    Buffer.BlockCopy(headerBytes, headLength, body, 0, take);
                    read = take;
                }
                while (read < contentLength)
                {
                    int n = await stream.ReadAsync(body.AsMemory(read, (int)Math.Min(contentLength - read, int.MaxValue)));
                    if (n <= 0) break;
                    read += n;
                }
                if (read < contentLength)
                    Log.Warn($"请求体不完整: {read}/{contentLength} 字节（{req.Path}）");
                req.Body = body;
            }
            else if (req.Header("Transfer-Encoding").Contains("chunked", StringComparison.OrdinalIgnoreCase))
            {
                req.Body = await ReadChunked(stream, headerBytes, headLength, bodyInBuffer);
            }
        }
        return req;
    }

    private static async Task<byte[]> ReadChunked(NetworkStream stream, byte[] initial, int initialOffset, int initialCount)
    {
        // 把“已经读进缓冲区的字节”当成一个小的前置流，简化分块解析
        var pending = new Queue<byte>();
        for (int i = 0; i < initialCount; i++) pending.Enqueue(initial[initialOffset + i]);

        async Task<int> ReadByteAsync()
        {
            if (pending.Count > 0) return pending.Dequeue();
            var one = new byte[1];
            int n = await stream.ReadAsync(one);
            return n <= 0 ? -1 : one[0];
        }

        var outMs = new MemoryStream();
        var lineBuf = new List<byte>();
        while (true)
        {
            lineBuf.Clear();
            while (true)
            {
                int b = await ReadByteAsync();
                if (b < 0) return outMs.ToArray();
                if (b == '\n') break;
                if (b != '\r') lineBuf.Add((byte)b);
            }
            var line = Encoding.ASCII.GetString(lineBuf.ToArray()).Trim();
            if (line.Length == 0) continue;
            int semi = line.IndexOf(';');
            if (semi >= 0) line = line[..semi];
            if (!int.TryParse(line, System.Globalization.NumberStyles.HexNumber, null, out int size) || size < 0) break;
            if (size == 0) return outMs.ToArray();
            for (int i = 0; i < size; i++)
            {
                int b = await ReadByteAsync();
                if (b < 0) return outMs.ToArray();
                outMs.WriteByte((byte)b);
            }
            await ReadByteAsync(); // \r
            await ReadByteAsync(); // \n
        }
        return outMs.ToArray();
    }

    /// <summary>完成 WebSocket 握手，返回帧编解码器。</summary>
    public static WebSocketConnection? AcceptWebSocket(HttpRequestEx req, Stream stream)
    {
        string key = req.Header("Sec-WebSocket-Key");
        if (string.IsNullOrEmpty(key)) return null;
        string accept;
        using (var sha = SHA1.Create())
            accept = Convert.ToBase64String(sha.ComputeHash(Encoding.ASCII.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));

        var head = "HTTP/1.1 101 Switching Protocols\r\n" +
                   "Upgrade: websocket\r\n" +
                   "Connection: Upgrade\r\n" +
                   "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";
        stream.Write(Encoding.ASCII.GetBytes(head));
        stream.Flush();
        return new WebSocketConnection(stream);
    }

    public void Dispose()
    {
        try { _cts.Cancel(); } catch { }
        try { _listener.Stop(); } catch { }
    }
}
