// 虚拟鼠标功能验证：
//  1) 新 UI 资源是否随服务端下发（vcursor / 虚拟鼠标按钮 / 抽屉选项）
//  2) 虚拟鼠标会用到的指令链路是否被服务端正确处理（move/click/down/up + cursor 回传）
const BASE = process.argv[2] || 'http://127.0.0.1:8848';
const CODE = process.argv[3] || '123456';

let failures = 0;
const log = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 1. 静态资源 ----------
const html = await (await fetch(`${BASE}/`)).text();
log(html.includes('id="vcursor"'), 'index.html 含虚拟鼠标指针元素 #vcursor');
log(html.includes('data-act="vmouse"'), 'index.html 工具条含「虚拟鼠标」按钮');
log(html.includes('id="vmouseOptions"'), 'index.html 抽屉含灵敏度/居中设置区');
log(html.includes('data-mode="vmouse"'), 'index.html 抽屉含操作方式切换');

const js = await (await fetch(`${BASE}/web/app.js`)).text();
for (const fn of ['setVmouseEnabled', 'vmouseStart', 'vmouseTwoFingerStart', 'vmMove', 'vmClick', 'vmSetDragging']) {
  log(js.includes(fn), `app.js 含 ${fn}()`);
}
log(js.includes("vmouse: {"), 'app.js 含虚拟鼠标状态定义');
log(/action: on \? 'down' : 'up'/.test(js) || js.includes("action: 'down', button"), 'app.js 拖动模式会发送左键按下/抬起');

const css = await (await fetch(`${BASE}/web/app.css`)).text();
log(css.includes('#vcursor') && css.includes('.dragging'), 'app.css 含虚拟指针与拖动样式');

// ---------- 2. 指令链路 ----------
const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws`);
let cursors = 0, lastCursor = null, authed = false;
const seen = new Set();

ws.onmessage = (ev) => {
  if (typeof ev.data !== 'string') return;
  const m = JSON.parse(ev.data);
  seen.add(m.type);
  if (m.type === 'welcome') ws.send(JSON.stringify({ type: 'auth', code: CODE, device: 'VmTest' }));
  if (m.type === 'authResult' && m.ok) authed = true;
  if (m.type === 'cursor') { cursors++; lastCursor = m; }
};

await sleep(1200);
log(authed, 'WebSocket 鉴权通过');

// 页面每 400ms 轮询一次光标位置，这里同样轮询（虚拟鼠标靠它显示真实指针）
const poll = setInterval(() => { try { ws.send(JSON.stringify({ type: 'cursor' })); } catch { } }, 300);

// 模拟虚拟鼠标：相对移动 -> 绝对坐标序列（就像手指一路滑动）
const path = [];
let x = 0.50, y = 0.50;
for (let i = 1; i <= 8; i++) {
  x = Math.min(1, x + 0.03);
  y = Math.min(1, y + 0.02);
  path.push({ x: +x.toFixed(4), y: +y.toFixed(4) });
  ws.send(JSON.stringify({ type: 'mouse', action: 'move', x: path[path.length - 1].x, y: path[path.length - 1].y }));
  await sleep(60);
}
await sleep(900);
log(cursors >= 1, `服务端回传光标位置 ${cursors} 次（最后 ${JSON.stringify(lastCursor)}）`);
log(!seen.has('error'), '移动过程中没有收到错误消息');

// 轻点 = 左键单击
ws.send(JSON.stringify({ type: 'mouse', action: 'click', button: 'left', count: 1 }));
await sleep(200);
ws.send(JSON.stringify({ type: 'mouse', action: 'click', button: 'left', count: 2 }));  // 连点两次 = 双击
await sleep(200);
// 双指轻点 = 右键
ws.send(JSON.stringify({ type: 'mouse', action: 'click', button: 'right', count: 1 }));
await sleep(200);
// 长按拖动：按下 -> 移动 -> 抬起
ws.send(JSON.stringify({ type: 'mouse', action: 'down', button: 'left' }));
await sleep(120);
ws.send(JSON.stringify({ type: 'mouse', action: 'move', x: 0.62, y: 0.58 }));
await sleep(120);
ws.send(JSON.stringify({ type: 'mouse', action: 'up', button: 'left' }));
await sleep(500);
clearInterval(poll);

log(!seen.has('error'), '点击/拖动全过程没有错误消息');
log(seen.has('authResult'), '服务端消息类型正常: ' + [...seen].join(','));

// 光标位置应已更新到拖动终点附近。
// 注意：如果电脑端自己报告 inputInjectionOk=false（例如跑在受限会话里），
// 光标不会真的移动，这一项就只能"跳过"而不是判失败。
let injectionOk = true;
try {
  const diag = await (await fetch(`${BASE}/diag`)).json();
  injectionOk = diag.inputInjectionOk !== false;
  console.log(`      电脑端输入注入自检: ${injectionOk ? '可用' : '不可用（本次会话限制）'}`);
} catch { }

const finalCursor = lastCursor;
const okPos = finalCursor && Math.abs(finalCursor.x - 0.62) < 0.02 && Math.abs(finalCursor.y - 0.58) < 0.02;
if (injectionOk) {
  log(okPos, `拖动终点光标位置正确: ${JSON.stringify(finalCursor)}`);
} else {
  console.log(`SKIP  拖动终点光标位置（本会话不允许注入输入，无法移动真实光标）: ${JSON.stringify(finalCursor)}`);
}

ws.close();
console.log(failures === 0 ? '\n虚拟鼠标链路验证通过 ✅' : `\n存在 ${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
