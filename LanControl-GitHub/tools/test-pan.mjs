// 拖动画面手势实测：把 setupGestures 里"拖画面"那段真实代码抽出来，
// 用 DOM 桩模拟 touchstart/touchmove，验证 panX/panY 是否真的被写入并应用到画布。
//
// 为什么需要：左右拖动反复"改了却没效果"，必须先证明逻辑本身通不通。
//
// 用法: node tools/test-pan.mjs [app.js路径]
import { readFileSync } from 'node:fs';

const SRC = process.argv[2] || 'D:/Deepseekharness/LanControl/PcServer/www/app.js';
const src = readFileSync(SRC, 'utf8');

let failures = 0;
const log = (ok, msg) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + msg); if (!ok) failures++; };

// ---- 抽出 setupGestures 里拖画面那一段（从注释标记到 touchend/touchcancel 注册）----
const start = src.indexOf('let panId = null');
const endMark = "stage.addEventListener('touchcancel', panEnd, { capture: true });";
const end = src.indexOf(endMark);
if (start < 0 || end < 0) { log(false, '在 app.js 里找不到拖画面代码段'); process.exit(1); }
const code = src.slice(start, end + endMark.length);

// ---- DOM 桩：只实现挡住功能所需的最小接口 ----
const handlers = {};
const canvasEl = { style: {}, width: 2560, height: 1600, id: 'screen' };
const stageEl = {
  clientWidth: 448, clientHeight: 423, id: 'stage',
  addEventListener: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
};
global.document = {
  body: { classList: { _s: new Set(['vkbd-open']), contains(c) { return this._s.has(c); }, toggle() { }, add() { }, remove() { } } },
  getElementById: (id) => (id === 'screen' ? canvasEl : null),
  querySelector: (s) => (s === '#screen' ? canvasEl : (s === '#stage' ? stageEl : null)),
  querySelectorAll: () => [],
};

// state 与辅助函数桩（真实代码会用到）
const state = {
  panX: 0, panY: 0, panMode: true,
  stageW: 448, stageH: 423, imgW: 1075, imgH: 672,   // 放大 2.4 倍后的实测值
};
global.state = state;
let redrawCount = 0;
global.scheduleRedraw = () => { redrawCount++; };
global.toast = () => { };
global.vibrate = () => { };

// ---- 执行真实代码 ----
try {
  const factory = new Function('state', 'scheduleRedraw', 'toast', 'stage', code + '\n; return {};');
  factory(state, global.scheduleRedraw, global.toast, stageEl);
} catch (e) {
  log(false, '执行拖画面代码抛异常: ' + e.message);
  process.exit(1);
}
log(true, '拖画面代码可正常执行');
log((handlers.touchstart || []).length > 0, '已注册 touchstart');
log((handlers.touchmove || []).length > 0, '已注册 touchmove');

const fire = (ev, x, y, extra = {}) => {
  const e = {
    touches: [{ identifier: 1, clientX: x, clientY: y }],
    target: { closest: () => null },
    preventDefault() { }, stopPropagation() { }, stopImmediatePropagation() { },
    ...extra,
  };
  (handlers[ev] || []).forEach((fn) => fn(e));
};

// ---- 1) 左滑（手指向左 = 看右边）----
fire('touchstart', 300, 200);
fire('touchmove', 200, 200);          // dx = -100
log(state.panX !== 0, `左滑后 panX 被写入（实际 ${state.panX}）`);
log(state.panX > 0, `panX 方向正确：手指左滑 -> 画面左移、看右侧内容（panX=${state.panX}）`);
log(redrawCount > 0, `滑动的确请求了重绘（${redrawCount} 次）`);
log(Math.abs(state.panY) < 1, '纯水平滑动不改变 panY');

// ---- 2) 边界钳制：不允许超过溢出量 ----
fire('touchstart', 400, 200);
fire('touchmove', -5000, 200);
fire('touchend');
const maxX = state.imgW - state.stageW;
log(Math.abs(state.panX) <= maxX + 0.5, `panX 被限制在 ±${maxX} 内（实际 ${state.panX}）`);

// ---- 3) 上滑（看下方）----
state.panX = 0; state.panY = 0;
fire('touchstart', 200, 400);
fire('touchmove', 200, 250);          // dy = -150
log(state.panY > 0, `手指上滑 -> 看下方，panY 被写入（实际 ${state.panY}）`);

// ---- 4) panMode 关闭时不接管 ----
fire('touchend');          // 先结束上一段手势，否则 panId 残留会绕过模式检查
state.panMode = false;
state.panX = 0; state.panY = 0;
fire('touchstart', 300, 200);
fire('touchmove', 100, 200);
log(state.panX === 0, 'panMode off: drag must not move picture');

console.log('');
console.log(failures === 0 ? '拖画面手势验证通过 ✅' : `存在 ${failures} 项问题 ❌`);
process.exit(failures === 0 ? 0 : 1);
