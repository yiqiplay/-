// 验证 UDP 自动发现：模拟手机发送 "LanControl?" 探测包并解析应答
import dgram from 'node:dgram';

const PORT = 8849;
const timeoutMs = 6000;

const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
let got = false;

sock.on('message', (msg, rinfo) => {
  const text = msg.toString('utf8');
  console.log(`收到来自 ${rinfo.address}:${rinfo.port} 的信标/应答: ${text}`);
  try {
    const j = JSON.parse(text);
    const ok = j.app === 'LanControl' && j.role === 'server' && typeof j.port === 'number' && j.host;
    console.log(`${ok ? 'PASS' : 'FAIL'}  发现协议字段完整: host=${j.host} port=${j.port} version=${j.version}`);
    if (!ok) process.exitCode = 1;
    got = true;
  } catch (e) {
    console.log('FAIL  应答不是合法 JSON: ' + e.message);
    process.exitCode = 1;
  }
});

sock.bind(() => {
  sock.setBroadcast(true);
  console.log(`已绑定 UDP 端口 ${sock.address().port}，开始发送探测包到 255.255.255.255:${PORT}`);
  const probe = Buffer.from('LanControl?', 'utf8');
  const send = () => sock.send(probe, 0, probe.length, PORT, '255.255.255.255', (err) => {
    if (err) console.log('发送失败: ' + err.message);
  });
  send();
  setTimeout(send, 700);
  setTimeout(send, 1500);
});

setTimeout(() => {
  if (!got) {
    console.log('FAIL  未在超时前收到任何发现应答');
    process.exitCode = 1;
  } else {
    console.log('发现协议验证通过 ✅');
  }
  sock.close();
  process.exit(process.exitCode || 0);
}, timeoutMs);
