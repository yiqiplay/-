using System.Net;
using System.Net.Sockets;
using System.Text;

namespace LanControl;

/// <summary>UDP 广播信标 + 探测应答，让手机 App 在同一局域网内自动发现本机。</summary>
internal static class Discovery
{
    public static void Start(int httpPort, string hostName)
    {
        _ = RespondLoop(httpPort, hostName);
        _ = BeaconLoop(httpPort, hostName);
        Log.Info($"UDP 发现服务已启动（监听/广播端口 {Program.DiscoveryPort}）");
    }

    private static byte[] InfoPayload(int httpPort, string hostName) => Encoding.UTF8.GetBytes(Json.Str(new
    {
        app = "LanControl",
        role = "server",
        version = Program.Version,
        host = hostName,
        port = httpPort,
        discoveryPort = Program.DiscoveryPort,
        os = Environment.OSVersion.VersionString,
        needAuth = true,
    }));

    /// <summary>监听手机发来的 "LanControl?" 探测包，收到即回包，实现秒级发现。</summary>
    private static async Task RespondLoop(int httpPort, string hostName)
    {
        UdpClient? udp = null;
        try
        {
            udp = new UdpClient();
            udp.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            udp.Client.Bind(new IPEndPoint(IPAddress.Any, Program.DiscoveryPort));
            while (true)
            {
                var from = new IPEndPoint(IPAddress.Any, 0);
                var data = await udp.ReceiveAsync();
                from = data.RemoteEndPoint;
                string text = Encoding.UTF8.GetString(data.Buffer);
                if (text.Contains("LanControl", StringComparison.OrdinalIgnoreCase))
                {
                    var reply = InfoPayload(httpPort, hostName);
                    await udp.SendAsync(reply, reply.Length, from);
                    Log.Debug($"已回应发现探测 {from}");
                }
            }
        }
        catch (Exception ex)
        {
            Log.Warn("发现服务监听失败（不影响手动输入地址连接）: " + ex.Message);
        }
        finally
        {
            udp?.Dispose();
        }
    }

    /// <summary>周期性向广播地址发送信标。</summary>
    private static async Task BeaconLoop(int httpPort, string hostName)
    {
        try
        {
            using var udp = new UdpClient { EnableBroadcast = true };
            var target = new IPEndPoint(IPAddress.Broadcast, Program.DiscoveryPort);
            while (true)
            {
                var payload = InfoPayload(httpPort, hostName);
                try { await udp.SendAsync(payload, payload.Length, target); }
                catch (Exception ex) { Log.Debug("广播失败: " + ex.Message); }
                await Task.Delay(2000);
            }
        }
        catch (Exception ex)
        {
            Log.Debug("信标服务结束: " + ex.Message);
        }
    }
}
