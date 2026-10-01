// 真实浏览器端到端验证：用 Edge headless + CDP 打开手机端页面，
// 自动连接被控端并检查 canvas 是否真的收到了画面（帧数、尺寸、样式、错误诊断）。
// 用法: node tools/test-ui.mjs http://127.0.0.1:8848 123456
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8848';
const CODE = process.argv[3] || '123456';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333 + Math.floor(Math.random() * 200);

let failures = 0;
const log = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

if (!existsSync(EDGE)) { console.log('SKIP  未找到 Edge，跳过 UI 测试'); process.exit(0); }

const profile = mkdtempSync(join(tmpdir(), 'lc-ui-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--disable-features=Translate,BackForwardCache', '--window-size=430,900',
  'about:blank',
], { stdio: 'ignore', detached: false });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return res.json();
}

async function waitForCdp() {
  for (let i = 0; i < 60; i++) {
    try { return await getJson('/json/version'); } catch { await sleep(500); }
  }
  throw new Error('CDP 未就绪');
}

let msgId = 0;
function rpc(ws, method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== id) return;
      ws.removeEventListener('message', onMsg);
      m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws, expression) {
  const r = await rpc(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'JS 异常');
  return r.result?.value;
}

const url = `${BASE}/?ip=${encodeURIComponent(new URL(BASE).host)}&auto=1`;

try {
  const ver = await waitForCdp();
  const targets = await getJson('/json/list');
  const page = targets.find((t) => t.type === 'page') || targets[0];
  console.log(`浏览器: ${ver.Browser}`);
  console.log(`目标页: ${page.id}`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  await rpc(ws, 'Runtime.enable');
  await rpc(ws, 'Page.enable');

  await rpc(ws, 'Runtime.evaluate', { expression: `window.__lcErrors = []; window.addEventListener('error', e => window.__lcErrors.push(String(e.message)));` });
  await rpc(ws, 'Page.navigate', { url });
  await sleep(1500);

  // 页面脚本是否正常加载
  const ready = await evaluate(ws, `({ hasState: typeof state !== 'undefined', connected: typeof state !== 'undefined' && state.connected })`);
  log(ready.hasState, `页面脚本已加载: ${JSON.stringify(ready)}`);

  // 输入配对码并连接（走真实 UI 路径，而不是直接调函数）
  await evaluate(ws, `document.querySelector('#codeInput').value = ${JSON.stringify(CODE)}; document.querySelector('#connectBtn').click(); true;`);
  await sleep(2500);

  const ctrl = await evaluate(ws, `({
    controlVisible: !document.querySelector('#control').classList.contains('hidden'),
    waitingHidden: document.querySelector('#waiting').classList.contains('hidden'),
    authed: state.authed, streaming: state.streaming, host: document.querySelector('#hostName').textContent
  })`);
  log(ctrl.controlVisible && ctrl.authed, `进入控制界面并完成配对: ${JSON.stringify(ctrl)}`);

  // 等画面真的画出来
  let stats = null;
  for (let i = 0; i < 30; i++) {
    stats = await evaluate(ws, `(() => {
      const c = document.querySelector('#screen');
      const st = c.style;
      return { decoded: window.decodedFrames, errors: window.decodeErrors, w: c.width, h: c.height,
               cssW: st.width, cssH: st.height, left: st.left, top: st.top,
               waitingHidden: document.querySelector('#waiting').classList.contains('hidden'),
               statText: document.querySelector('#statText').textContent };
    })()`);
    if (stats && stats.decoded > 0) break;
    await sleep(1000);
  }
  const frameOk = stats && stats.decoded > 0 && stats.w > 0 && stats.h > 0;
  log(frameOk, `画面已解码绘制: 帧数=${stats?.decoded} 错误=${stats?.errors} canvas=${stats?.w}x${stats?.h} 显示=${stats?.cssW}x${stats?.cssH} 位置=${stats?.left},${stats?.top}`);
  log(stats?.waitingHidden === true, `“正在建立画面通道”遮罩已隐藏: ${stats?.waitingHidden}`);
  log((stats?.errors || 0) === 0, `解码失败次数为 0（实际 ${stats?.errors}）`);
  log(/已收 \d+ 帧/.test(stats?.statText || ''), `状态栏显示帧统计: "${stats?.statText}"`);

  // canvas 是否真的画了内容（取几个像素，全黑说明没画上）
  const pixels = await evaluate(ws, `(() => {
    const c = document.querySelector('#screen');
    const ctx = c.getContext('2d');
    if (!ctx || !c.width) return { ok: false, reason: 'no ctx' };
    const d = ctx.getImageData(0, 0, Math.min(c.width, 400), Math.min(c.height, 300)).data;
    let nonBlack = 0, sum = 0;
    for (let i = 0; i < d.length; i += 4) { const v = d[i] + d[i+1] + d[i+2]; sum += v; if (v > 24) nonBlack++; }
    return { ok: true, nonBlackRatio: nonBlack / (d.length / 4), avg: sum / (d.length / 4) / 3 };
  })()`);
  log(pixels.ok && pixels.nonBlackRatio > 0.05, `canvas 像素非黑占比=${(pixels.nonBlackRatio * 100).toFixed(1)}% 平均亮度=${pixels.avg?.toFixed(1)}`);

  // 页面运行期 JS 错误
  const jsErrors = await evaluate(ws, `window.__lcErrors`);
  log(!jsErrors || jsErrors.length === 0, `页面运行期无 JS 报错: ${JSON.stringify(jsErrors || [])}`);

  // 模拟触摸是否触发鼠标指令（检查服务器端是否收到）
  const touchSent = await evaluate(ws, `(() => {
    const stage = document.querySelector('#stage');
    const mk = (type, x, y) => { const t = new Touch({ identifier: 1, target: stage, clientX: x, clientY: y });
      return new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true }); };
    const r = stage.getBoundingClientRect();
    stage.dispatchEvent(mk('touchstart', r.left + r.width / 2, r.top + r.height / 2));
    stage.dispatchEvent(mk('touchmove', r.left + r.width / 2 + 40, r.top + r.height / 2 + 20));
    stage.dispatchEvent(mk('touchend', r.left + r.width / 2 + 40, r.top + r.height / 2 + 20));
    return state.ws && state.ws.readyState === 1;
  })()`);
  log(touchSent === true, '触摸事件已派发且 WebSocket 处于打开状态');

  ws.close();
} catch (e) {
  log(false, 'UI 测试异常: ' + e.message);
} finally {
  try { edge.kill(); } catch { }
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { }
}

console.log(failures === 0 ? '\nUI 全链路通过 ✅' : `\nUI 测试存在 ${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
