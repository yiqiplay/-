using System.Net.Sockets;
using System.Text;

namespace LanControl;

/// <summary>最小可用的 RFC6455 WebSocket 实现（文本 + 二进制帧，支持分片与 ping/pong）。</summary>
internal sealed class WebSocketConnection : IDisposable
{
    private readonly Stream _stream;
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private volatile bool _closed;

    public bool Closed => _closed;

    public WebSocketConnection(Stream stream) => _stream = stream;

    public async Task<string?> ReceiveTextAsync(CancellationToken ct = default)
    {
        while (true)
        {
            var frame = await ReadFrameAsync(ct);
            if (frame == null) return null;
            var (opcode, payload, fin) = frame.Value;
            switch (opcode)
            {
                case 0x1: // text
                case 0x2: // binary (当作文本处理)
                    if (!fin)
                    {
                        var ms = new MemoryStream();
                        ms.Write(payload);
                        while (true)
                        {
                            var next = await ReadFrameAsync(ct);
                            if (next == null) return null;
                            ms.Write(next.Value.payload);
                            if (next.Value.fin) break;
                        }
                        payload = ms.ToArray();
                    }
                    if (opcode == 0x1) return Encoding.UTF8.GetString(payload);
                    return Encoding.UTF8.GetString(payload);
                case 0x8: // close
                    await SendAsync(0x8, Array.Empty<byte>());
                    _closed = true;
                    return null;
                case 0x9: // ping -> pong
                    await SendAsync(0xA, payload);
                    break;
                case 0xA: // pong
                    break;
            }
        }
    }

    private async Task<(int opcode, byte[] payload, bool fin)?> ReadFrameAsync(CancellationToken ct)
    {
        var header = new byte[2];
        if (!await ReadExact(header, 0, 2, ct)) return null;
        bool fin = (header[0] & 0x80) != 0;
        int opcode = header[0] & 0x0F;
        bool masked = (header[1] & 0x80) != 0;
        long len = header[1] & 0x7F;
        if (len == 126)
        {
            var ext = new byte[2];
            if (!await ReadExact(ext, 0, 2, ct)) return null;
            len = (ext[0] << 8) | ext[1];
        }
        else if (len == 127)
        {
            var ext = new byte[8];
            if (!await ReadExact(ext, 0, 8, ct)) return null;
            len = 0;
            for (int i = 0; i < 8; i++) len = (len << 8) | ext[i];
        }
        if (len > 64L * 1024 * 1024) throw new InvalidOperationException("WebSocket 帧过大");

        var mask = new byte[4];
        if (masked && !await ReadExact(mask, 0, 4, ct)) return null;
        var payload = new byte[len];
        if (len > 0 && !await ReadExact(payload, 0, (int)len, ct)) return null;
        if (masked)
            for (int i = 0; i < payload.Length; i++) payload[i] ^= mask[i % 4];
        return (opcode, payload, fin);
    }

    private async Task<bool> ReadExact(byte[] buffer, int offset, int count, CancellationToken ct)
    {
        int read = 0;
        while (read < count)
        {
            int n;
            try { n = await _stream.ReadAsync(buffer.AsMemory(offset + read, count - read), ct); }
            catch { return false; }
            if (n <= 0) return false;
            read += n;
        }
        return true;
    }

    public async Task SendTextAsync(string text)
        => await SendAsync(0x1, Encoding.UTF8.GetBytes(text));

    public async Task SendBinaryAsync(byte[] data)
        => await SendAsync(0x2, data);

    public async Task SendAsync(int opcode, byte[] payload)
    {
        if (_closed) return;
        await _sendLock.WaitAsync();
        try
        {
            var head = BuildHeader(opcode, payload.Length);
            await _stream.WriteAsync(head);
            if (payload.Length > 0) await _stream.WriteAsync(payload);
            await _stream.FlushAsync();
        }
        catch
        {
            _closed = true;
        }
        finally
        {
            _sendLock.Release();
        }
    }

    private static byte[] BuildHeader(int opcode, int length)
    {
        var head = new List<byte>(10) { (byte)(0x80 | opcode) };
        if (length < 126) head.Add((byte)length);
        else if (length <= ushort.MaxValue)
        {
            head.Add(126);
            head.Add((byte)(length >> 8));
            head.Add((byte)(length & 0xFF));
        }
        else
        {
            head.Add(127);
            for (int i = 7; i >= 0; i--) head.Add((byte)((long)length >> (8 * i) & 0xFF));
        }
        return head.ToArray();
    }

    public void Dispose()
    {
        _closed = true;
        try { _stream.Dispose(); } catch { }
        try { _sendLock.Dispose(); } catch { }
    }
}
