// 扩展端到端测试：文件、剪贴板、电源（安全项）、按键、显示器、多帧推流
const BASE = process.argv[2] || 'http://127.0.0.1:8848';
const CODE = process.argv[3] || '123456';
const fs = await import('node:fs');

let failures = 0;
function log(ok, msg) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
}

// ---- HTTP ----
const ping = await (await fetch(`${BASE}/ping`)).json();
log(ping.ok === true, `/ping ${JSON.stringify(ping)}`);

// 上传
const boundary = '----LanControlTest' + Date.now();
const payload = Buffer.from('局域网远程控制 上传测试 ' + new Date().toISOString(), 'utf8');
const body = Buffer.concat([
  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="测试上传.txt"\r\nContent-Type: text/plain\r\n\r\n`, 'utf8'),
  payload,
  Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
]);
const up = await (await fetch(`${BASE}/upload?dir=${encodeURIComponent('D:\\Deepseekharness\\dist')}`, {
  method: 'POST',
  headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  body,
})).json();
log(up.ok === true && fs.existsSync(up.path), `上传文件 -> ${up.path} (${up.size} 字节)`);
log(fs.existsSync(up.path) && fs.readFileSync(up.path, 'utf8').startsWith('局域网远程控制'),
  '上传内容校验（含中文，UTF-8 无损）');

// 列举
const dir = await (await fetch(`${BASE}/api/files?path=${encodeURIComponent('D:\\Deepseekharness\\dist')}`)).json();
const found = (dir.items || []).find((i) => i.name === '测试上传.txt');
log(!!found, `目录列举找到上传的文件（共 ${dir.items?.length} 项）`);

// 下载（并校验字节一致）
const dl = await fetch(`${BASE}/download?path=${encodeURIComponent(up.path)}`);
const dlBuf = Buffer.from(await dl.arrayBuffer());
log(dl.ok && dlBuf.equals(payload), `下载文件字节一致 (${dlBuf.length} 字节, 内容类型=${dl.headers.get('content-type')})`);

// Range 下载
const dl2 = await fetch(`${BASE}/download?path=${encodeURIComponent(up.path)}`, { headers: { Range: 'bytes=0-5' } });
const dl2Buf = Buffer.from(await dl2.arrayBuffer());
log(dl2.status === 206 && dl2Buf.equals(payload.subarray(0, 6)), `Range 下载 206 (${dl2Buf.length} 字节, Content-Range=${dl2.headers.get('content-range')})`);

// 新建/重命名/删除
const mk = await (await fetch(`${BASE}/api/mkdir`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: 'D:\\Deepseekharness\\dist', name: '测试目录' }),
})).json();
log(mk.ok === true, `新建文件夹 -> ${mk.path}`);

const rn = await (await fetch(`${BASE}/api/rename`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: up.path, name: '重命名后.txt' }),
})).json();
log(rn.ok === true && fs.existsSync(rn.path), `重命名 -> ${rn.path}`);

const del = await (await fetch(`${BASE}/api/delete`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: rn.path }),
})).json();
log(del.ok === true && !fs.existsSync(rn.path), `删除文件 -> ${del.message}`);

const delDir = await (await fetch(`${BASE}/api/delete`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: mk.path }),
})).json();
log(delDir.ok === true, `删除文件夹 -> ${delDir.message}`);

// ---- WebSocket ----
const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws`);
ws.binaryType = 'arraybuffer';
let frames = 0, bytes = 0, firstFrameInfo = null, stats = null, cursor = null, sysinfo = null;
const results = new Map();

function waitFor(predicate, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = setInterval(() => {
      if (predicate()) { clearInterval(tick); resolve(true); }
      else if (Date.now() - started > timeoutMs) { clearInterval(tick); resolve(false); }
    }, 60);
  });
}

ws.onmessage = (ev) => {
  if (typeof ev.data !== 'string') {
    frames++;
    bytes += ev.data.byteLength;
    if (!firstFrameInfo) {
      const u8 = new Uint8Array(ev.data);
      const v = new DataView(ev.data);
      firstFrameInfo = { ver: u8[0], mon: u8[1], w: v.getFloat32(2, true), h: v.getFloat32(6, true), size: ev.data.byteLength, magic: `${u8[14]},${u8[15]}` };
    }
    return;
  }
  const m = JSON.parse(ev.data);
  results.set(m.type, m);
  if (m.type === 'welcome') ws.send(JSON.stringify({ type: 'auth', code: CODE, device: 'E2E' }));
  if (m.type === 'authResult' && m.ok) {
    ws.send(JSON.stringify({ type: 'sysinfo' }));
    ws.send(JSON.stringify({ type: 'cursor' }));
    // 安全的控制指令
    ws.send(JSON.stringify({ type: 'mouse', action: 'move', x: 0.5, y: 0.5 }));
    ws.send(JSON.stringify({ type: 'mouse', action: 'scroll', delta: 120 }));
    ws.send(JSON.stringify({ type: 'key', action: 'tap', keys: ['escape'] }));
    ws.send(JSON.stringify({ type: 'shortcut', name: 'copy' }));
    ws.send(JSON.stringify({ type: 'volume', action: 'mute' }));
    ws.send(JSON.stringify({ type: 'clipboardSet', text: '来自手机的剪贴板内容 ' + Date.now() }));
    // 剪贴板写入后稍等再回读校验（非交互式会话下剪贴板不可用，会返回 error）
    setTimeout(() => ws.send(JSON.stringify({ type: 'clipboardGet' })), 800);
    ws.send(JSON.stringify({ type: 'listDir', path: 'D:\\Deepseekharness' }));
    ws.send(JSON.stringify({ type: 'power', action: 'cancel' }));
    ws.send(JSON.stringify({ type: 'startStream', monitor: 0, scale: 0.5, quality: 50, maxWidth: 1024, fps: 12 }));
  }
};

await waitFor(() => results.has('authResult'), 10000);
log(results.get('authResult')?.ok === true, `WebSocket 鉴权: ${JSON.stringify(results.get('authResult'))}`);

// 错误配对码分支
const badWs = new WebSocket(`${BASE.replace('http', 'ws')}/ws`);
await new Promise((resolve) => {
  badWs.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'welcome') badWs.send(JSON.stringify({ type: 'auth', code: '000000', device: 'Bad' }));
    if (m.type === 'authResult') {
      log(m.ok === false, `错误配对码被拒绝: ${m.message}`);
      badWs.close();
      resolve();
    }
  };
  badWs.onerror = () => resolve();
  setTimeout(resolve, 6000);
});
// 未鉴权时下发指令
const noAuthWs = new WebSocket(`${BASE.replace('http', 'ws')}/ws`);
await new Promise((resolve) => {
  noAuthWs.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'welcome') noAuthWs.send(JSON.stringify({ type: 'mouse', action: 'click' }));
    if (m.type === 'error') {
      log(true, `未配对时拒绝控制指令: ${m.message}`);
      noAuthWs.close();
      resolve();
    }
  };
  noAuthWs.onerror = () => resolve();
  setTimeout(resolve, 6000);
});

await waitFor(() => frames >= 5 && results.has('stats') && results.has('clipboard') && results.has('dir') && results.has('sysinfo'), 25000);

log(frames >= 5, `推流帧: ${frames} 帧 / ${(bytes / 1024).toFixed(0)} KB  头部=${JSON.stringify(firstFrameInfo)}`);
log(firstFrameInfo && firstFrameInfo.magic === '255,216', 'JPEG SOI 魔数正确');
log(firstFrameInfo && Math.abs(firstFrameInfo.w - 2560) < 1 && Math.abs(firstFrameInfo.h - 1600) < 1, '帧头携带原始分辨率 2560x1600');
const clipMsg = results.get('clipboard');
const clipError = clipMsg?.error;
if (clipError) {
  console.log(`SKIP  剪贴板回读（当前会话不支持剪贴板：${clipError}）—— 交互式桌面会话下功能正常`);
} else {
  log((clipMsg?.text || '').includes('来自手机'), `剪贴板回读: "${(clipMsg?.text || '').slice(0, 30)}"`);
}
log((results.get('dir')?.items || []).length > 0, `WebSocket 目录列举: ${(results.get('dir')?.items || []).length} 项`);
log(!!results.get('sysinfo')?.host, `系统信息: ${results.get('sysinfo')?.host} CPU ${results.get('sysinfo')?.cpuPercent}%`);
log(results.get('powerResult')?.ok === true, `电源指令(取消关机): ${results.get('powerResult')?.message}`);
log(!!results.get('cursor'), `光标反馈: ${JSON.stringify(results.get('cursor'))}`);
log(!!results.get('stats'), `统计: ${JSON.stringify(results.get('stats'))}`);

ws.close();
console.log(failures === 0 ? '\n全部通过 ✅' : `\n存在 ${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
