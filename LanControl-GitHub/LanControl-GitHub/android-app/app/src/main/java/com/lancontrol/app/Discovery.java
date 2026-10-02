package com.lancontrol.app;

import android.content.Context;
import android.net.DhcpInfo;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Socket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.Map;

/**
 * 局域网自动发现：向 UDP 8849 广播探测包，同时被动接收被控端的周期信标。
 * 不依赖任何第三方库。
 */
public class Discovery {

    private static final String TAG = "LanControl";
    public static final int DISCOVERY_PORT = 8849;
    private static final String PROBE = "LanControl?";

    public interface Callback {
        void onFound(List<ServerInfo> servers);

        void onFinished(List<ServerInfo> servers);
    }

    public static class ServerInfo {
        public final String host;
        public final String address;
        public final int port;

        ServerInfo(String host, String address, int port) {
            this.host = host;
            this.address = address;
            this.port = port;
        }

        public String display() {
            return host + "  (" + address + ":" + port + ")";
        }
    }

    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, ServerInfo> found = new LinkedHashMap<>();
    private volatile boolean running;
    private Callback callback;
    private WifiManager.MulticastLock lock;
    private final ExecutorService executor = Executors.newFixedThreadPool(48);
    private DatagramSocket listenSocket;
    private DatagramSocket probeSocket;

    public Discovery(Context ctx) {
        this.context = ctx.getApplicationContext();
    }

    public boolean isRunning() {
        return running;
    }

    public void stop() {
        running = false;
        closeQuietly(listenSocket);
        closeQuietly(probeSocket);
        if (lock != null && lock.isHeld()) {
            try {
                lock.release();
            } catch (Exception ignored) {
            }
        }
    }

    public void start(final int durationMs, final Callback cb) {
        stop();
        found.clear();
        running = true;
        callback = cb;

        try {
            WifiManager wm = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                lock = wm.createMulticastLock("lancontrol");
                lock.setReferenceCounted(false);
                lock.acquire();
            }
        } catch (Exception e) {
            Log.w(TAG, "无法获取组播锁: " + e.getMessage());
        }

        // UDP 广播之外，同时做 TCP 直连扫描兜底（广播常被路由器/企业网丢弃）。
        tcpSweep(8848);

        final InetAddress broadcast = resolveBroadcast();

        new Thread(() -> {
            try {
                listenSocket = new DatagramSocket(null);
                listenSocket.setReuseAddress(true);
                listenSocket.setBroadcast(true);
                listenSocket.bind(new InetSocketAddress(DISCOVERY_PORT));
                listenSocket.setSoTimeout(400);
                byte[] buf = new byte[2048];
                while (running) {
                    DatagramPacket p = new DatagramPacket(buf, buf.length);
                    try {
                        listenSocket.receive(p);
                    } catch (SocketTimeoutException te) {
                        continue;
                    } catch (Exception e) {
                        break;
                    }
                    handlePacket(p);
                }
            } catch (Exception e) {
                Log.w(TAG, "发现服务监听失败: " + e.getMessage());
            } finally {
                closeQuietly(listenSocket);
            }
        }, "discovery-listen").start();

        new Thread(() -> {
            try {
                probeSocket = new DatagramSocket();
                probeSocket.setBroadcast(true);
                byte[] data = PROBE.getBytes(StandardCharsets.UTF_8);
                long deadline = System.currentTimeMillis() + durationMs;
                while (running && System.currentTimeMillis() < deadline) {
                    try {
                        probeSocket.send(new DatagramPacket(data, data.length, broadcast, DISCOVERY_PORT));
                    } catch (Exception e) {
                        Log.d(TAG, "探测包发送失败: " + e.getMessage());
                    }
                    Thread.sleep(600);
                }
            } catch (Exception e) {
                Log.w(TAG, "探测线程结束: " + e.getMessage());
            } finally {
                stop();
                main.post(() -> cb.onFinished(new ArrayList<>(found.values())));
            }
        }, "discovery-probe").start();
    }

    private void handlePacket(DatagramPacket p) {
        try {
            String text = new String(p.getData(), p.getOffset(), p.getLength(), StandardCharsets.UTF_8);
            if (!text.contains("LanControl")) return;
            JSONObject o = new JSONObject(text);
            if (!"server".equals(o.optString("role", "server"))) return;
            final String host = o.optString("host", "电脑");
            final int port = o.optInt("port", 8848);
            final String ip = p.getAddress().getHostAddress();
            addFound(host, ip, port);
        } catch (Exception e) {
            Log.d(TAG, "解析信标失败: " + e.getMessage());
        }
    }

    /** 去重后通知界面（UDP 广播与 TCP 扫描共用）。 */
    private void addFound(String host, String ip, int port) {
        final String key = ip + ":" + port;
        synchronized (found) {
            if (found.containsKey(key)) return;
            found.put(key, new ServerInfo(host, ip, port));
        }
        Log.i(TAG, "发现被控端: " + host + " @ " + key);
        final Callback cb = callback;
        if (cb != null) main.post(() -> cb.onFound(new ArrayList<>(found.values())));
    }

    /**
     * TCP 直连扫描兜底。
     *
     * 为什么需要它：UDP 广播在不少路由器 / 企业网 / 手机上会被直接丢弃
     *（实测用户环境就是"广播发现一直失败、手动输入却能连"）。
     * 这里对手机自身所在网段的 1~254 逐个尝试 TCP 连接被控端端口，
     * 能连上就说明是被控端 —— 不依赖广播，因此不受上述拦截影响。
     */
    private void tcpSweep(final int port) {
        String myIp = localIpv4();
        if (myIp == null) {
            Log.i(TAG, "拿不到本机 IPv4，跳过 TCP 扫描");
            return;
        }
        int cut = myIp.lastIndexOf('.');
        if (cut <= 0) return;
        final String prefix = myIp.substring(0, cut);
        Log.i(TAG, "TCP 扫描网段 " + prefix + ".0/24 端口 " + port);

        for (int i = 1; i <= 254 && running; i++) {
            final String ip = prefix + "." + i;
            if (ip.equals(myIp)) continue;
            executor.execute(() -> {
                Socket s = new Socket();
                try {
                    s.connect(new InetSocketAddress(ip, port), 250);
                    addFound("电脑", ip, port);
                } catch (Exception ignored) {
                    // 连不上就是没有，正常情况
                } finally {
                    try { s.close(); } catch (Exception ignored) { }
                }
            });
        }
    }

    /** 取本机 WiFi 的 IPv4 地址（拿不到返回 null）。 */
    private String localIpv4() {
        try {
            WifiManager wm = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                DhcpInfo dhcp = wm.getDhcpInfo();
                if (dhcp != null && dhcp.ipAddress != 0) {
                    return (dhcp.ipAddress & 0xFF) + "." + ((dhcp.ipAddress >> 8) & 0xFF) + "."
                            + ((dhcp.ipAddress >> 16) & 0xFF) + "." + ((dhcp.ipAddress >> 24) & 0xFF);
                }
            }
        } catch (Exception ignored) { }
        return null;
    }

    private InetAddress resolveBroadcast() {
        try {
            WifiManager wm = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                DhcpInfo dhcp = wm.getDhcpInfo();
                if (dhcp != null && dhcp.ipAddress != 0) {
                    int broadcast = (dhcp.ipAddress & dhcp.netmask) | ~dhcp.netmask;
                    byte[] quads = new byte[4];
                    for (int k = 0; k < 4; k++) {
                        quads[k] = (byte) ((broadcast >> (k * 8)) & 0xFF);
                    }
                    return InetAddress.getByAddress(quads);
                }
            }
        } catch (Exception e) {
            Log.d(TAG, "计算广播地址失败: " + e.getMessage());
        }
        try {
            return InetAddress.getByName("255.255.255.255");
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private static void closeQuietly(DatagramSocket s) {
        try {
            if (s != null) s.close();
        } catch (Exception ignored) {
        }
    }
}
