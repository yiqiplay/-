// 端到端协议测试：HTTP 页面 / ping / 目录列举 / WebSocket 鉴权 / 画面帧
const BASE = process.argv[2] || 'http://127.0.0.1:8848';
const CODE = process.argv[3] || '123456';

function log(ok, msg) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) process.exitCode = 1;
}

const res = await fetch(`${BASE}/ping`);
const ping = await res.json();
log(res.ok && ping.ok === true, `/ping -> ${JSON.stringify(ping)}`);

const page = await fetch(`${BASE}/`);
const html = await page.text();
log(page.ok && html.includes('局域网远程控制'), `GET / -> ${html.length} bytes, title ok`);

const css = await fetch(`${BASE}/web/app.css`);
log(css.ok && (await css.text()).includes('#0d1117'), `GET /web/app.css -> ${css.status}`);

const js = await fetch(`${BASE}/web/app.js`);
log(js.ok, `GET /web/app.js -> ${js.status}`);

const dir = await (await fetch(`${BASE}/api/files`)).json();
log(Array.isArray(dir.items), `GET /api/files -> path=${dir.path} items=${dir.items?.length}`);

// ---- WebSocket ----
const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws`);
ws.binaryType = 'arraybuffer';
let welcome = null, authResult = null, frames = 0, bytes = 0, stats = null, cursor = null;

const done = (ok) => {
  log(ok, `画面帧: ${frames} 帧 / ${(bytes / 1024).toFixed(0)} KB`);
  log(!!stats, `统计信息: ${JSON.stringify(stats)}`);
  log(!!cursor, `光标位置: ${JSON.stringify(cursor)}`);
  try { ws.close(); } catch { }
  process.exit(process.exitCode || 0);
};

const timer = setTimeout(() => { console.log('TIMEOUT'); done(false); }, 25000);

ws.onmessage = (ev) => {
  if (typeof ev.data !== 'string') {
    frames++;
    bytes += ev.data.byteLength;
    if (frames === 1) {
      const v = new DataView(ev.data);
      console.log(`      帧头 version=${new Uint8Array(ev.data)[0]} mon=${new Uint8Array(ev.data)[1]} ` +
        `自然尺寸=${v.getFloat32(2, true)}x${v.getFloat32(6, true)} 压缩后=${ev.data.byteLength} 字节 ` +
        `JPEG魔数=${new Uint8Array(ev.data).slice(14, 16).join(',')}`);
    }
    return;
  }
  const msg = JSON.parse(ev.data);
  if (msg.type === 'welcome') {
    welcome = msg;
    log(true, `welcome: host=${msg.host} monitors=${JSON.stringify(msg.monitors)} drives=${msg.drives?.length} needAuth=${msg.needAuth}`);
    ws.send(JSON.stringify({ type: 'auth', code: CODE, device: 'NodeTest' }));
  } else if (msg.type === 'authResult') {
    authResult = msg;
    log(msg.ok === true, `authResult: ${JSON.stringify(msg)}`);
    if (!msg.ok) { clearTimeout(timer); return done(false); }
    ws.send(JSON.stringify({ type: 'sysinfo' }));
    ws.send(JSON.stringify({ type: 'cursor' }));
    ws.send(JSON.stringify({ type: 'startStream', monitor: 0, scale: 1, quality: 60, maxWidth: 1600, fps: 10 }));
  } else if (msg.type === 'stats') {
    stats = msg;
    if (frames > 5) { ws.send(JSON.stringify({ type: 'stopStream' })); clearTimeout(timer); setTimeout(() => done(frames > 5), 300); }
  } else if (msg.type === 'cursor') {
    cursor = msg;
  } else if (msg.type === 'sysinfo') {
    log(!!msg.cpuPercent || msg.cpuPercent === 0, `sysinfo: CPU ${msg.cpuPercent}% 内存 ${msg.memUsedGb}/${msg.memTotalGb}GB uptime=${msg.uptime}`);
  } else if (msg.type === 'error') {
    console.log('      error: ' + msg.message);
  }
};

ws.onerror = (e) => { log(false, 'WebSocket 错误 ' + (e.message || '')); };
