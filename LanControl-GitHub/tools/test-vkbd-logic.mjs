// 虚拟键盘逻辑实测：把 app.js 里 VK_PAGES..renderKeys 之间的真实代码抽出来，
// 在一个极简 DOM 桩里**真的执行一遍**（含模拟点击），看修饰键状态到底有没有被写入。
//
// 为什么需要它：高亮问题改了四轮都靠"读代码猜"，而这是纯前端逻辑，
// 完全可以在这里跑起来验证 —— 不该再靠猜。
//
// 用法: node tools/test-vkbd-logic.mjs [app.js路径]
import { readFileSync } from 'node:fs';

const SRC = process.argv[2] || 'D:/Deepseekharness/LanControl/PcServer/www/app.js';
const src = readFileSync(SRC, 'utf8');

// ---- 抽出虚拟键盘那一段真实代码 ----
const from = src.indexOf('const VK_MODS = []');
const to = src.indexOf('function renderKeys()');
if (from < 0 || to < 0) { console.log('FAIL  在 app.js 里找不到虚拟键盘代码段'); process.exit(1); }
const code = src.slice(from, to);

let failures = 0;
const log = (ok, msg) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + msg); if (!ok) failures++; };

// ---- 极简 DOM 桩 ----
class El {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      toggle: (c, on) => { if (on) this.classList._s.add(c); else this.classList._s.delete(c); },
      contains: (c) => this.classList._s.has(c),
    };
    this.textContent = '';
    this._handlers = {};
  }
  set className(v) { this._cls = v; }
  get className() { return this._cls || ''; }
  set innerHTML(v) { if (v === '') this.children = []; }
  get innerHTML() { return ''; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); }
  // 触发点击
  click() { if (this.onclick) this.onclick({ stopPropagation() { }, preventDefault() { } }); }
  querySelectorAll(sel) {
    // 支持 "#vkbdBody .vkbd-key" 这类后代选择器；记录每个元素的 id 供匹配
    const parts = sel.trim().split(/\s+/);
    const last = parts[parts.length - 1];
    const wantId = last.startsWith('#') ? last.slice(1) : '';
    const wantCls = last.startsWith('.') ? last.slice(1) : '';
    const rootId = parts.length > 1 && parts[0].startsWith('#') ? parts[0].slice(1) : '';
    if (rootId && this.id !== rootId) return [];
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (wantCls && (c.className || '').includes(wantCls)) out.push(c);
        else if (wantId && c.id === wantId) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

const nodes = { vkbdMods: new El(), vkbdBody: new El(), vkbdArmed: new El(),
  vkbdPan: new El(), vkbdZoom: new El(), vkbdTipText: new El(), vkbdTipGo: new El() };
for (const k of Object.keys(nodes)) nodes[k].id = k;
nodes.vkbdPan.textContent = '拖动画面';
nodes.vkbdZoom.textContent = '放大画面';
global.document = {
  createElement: (t) => new El(t),
  querySelector: (s) => nodes[s.replace('#','')] || null,
  _unusedQuerySelector: (s) => {
    if (s === '#vkbdMods') return nodes.vkbdMods;
    if (s === '#vkbdBody') return nodes.vkbdBody;
    if (s === '#vkbdArmed') return nodes.vkbdArmed;
    return null;
  },
  getElementById: (id) => nodes[id] || null,
  // document 级查询：#vkbdBody .vkbd-key 这类后代选择器交给根的桩实现
  querySelectorAll: (sel) => nodes.vkbdBody.querySelectorAll(sel),
};
global.$ = (s) => document.querySelector(s);
const sent = [];
global.send = (m) => sent.push(m);
global.vibrate = () => { };
global.toast = () => { };
global.setTimeout = setTimeout;
global.clearTimeout = clearTimeout;
global.Date = Date;

// ---- 执行真实代码 ----
let mod = null;
try {
  const factory = new Function(code + '\n; return { VK_PAGES, vkState, renderVkbd, vkTap, vkModTap, vkModOf, VK_MOD_ALIAS, vkPaintState, vkPaintArmed };');
  mod = factory();
} catch (e) {
  log(false, '执行虚拟键盘代码抛异常: ' + e.message);
  process.exit(1);
}
log(true, '虚拟键盘代码可正常执行');

// ---- 1) 别名归一 ----
log(mod.vkModOf('shiftL') === 'shift' && mod.vkModOf('ctrl') === 'ctrl' && mod.vkModOf('a') === '',
  'vkModOf 归一正确（shiftL→shift、a→空）');

// ---- 2) 渲染后，底排修饰键是否被识别为修饰键 ----
mod.renderVkbd();
const keys = nodes.vkbdBody.querySelectorAll('.vkbd-key');
log(keys.length > 60, `渲染出 ${keys.length} 个按键`);

const ctrlBtn = keys.find((b) => b.dataset.key === 'ctrl');
const shiftBtn = keys.find((b) => b.dataset.key === 'shiftL');
log(!!ctrlBtn, '能找到底排的 Ctrl 键');
log(!!shiftBtn, '能找到左 Shift 键');
if (!ctrlBtn || !shiftBtn) { console.log('\n存在 ' + failures + ' 项问题 ❌'); process.exit(1); }

// ---- 3) 点 Ctrl：状态是否写入、是否有高亮、是否显示"已预备" ----
ctrlBtn.click();
log(mod.vkState.mods.has('ctrl'), '点 Ctrl 后 vkState.mods 里写入了 ctrl');
log(ctrlBtn.classList.contains('on'), 'Ctrl 键带上了 .on 类');
log((ctrlBtn.style.background || '') !== '', `Ctrl 键设了内联背景色（实际: "${ctrlBtn.style.background || '无'}"）`);
log(nodes.vkbdArmed.textContent.includes('Ctrl'), `标题栏显示已预备（实际: "${nodes.vkbdArmed.textContent}"）`);

// ---- 4) 再点 C：是否发出 ctrl+c，并且修饰键被清空 ----
sent.length = 0;
const cBtn = nodes.vkbdBody.querySelectorAll('.vkbd-key').find((b) => b.dataset.key === 'c');
if (!cBtn) { log(false, '找不到 c 键'); }
else {
  cBtn.click();
  const combo = sent.find((m) => m.type === 'key');
  log(!!combo && JSON.stringify(combo.keys) === '["ctrl","c"]',
    `发出了组合键（实际: ${combo ? JSON.stringify(combo.keys) : '无'}）`);
  log(!mod.vkState.mods.has('ctrl'), '组合键发出后修饰键自动松开');
}

// ---- 5) Shift 是否走修饰键分支（而不是被当成普通键发出去）----
sent.length = 0;
const shiftBtn2 = nodes.vkbdBody.querySelectorAll('.vkbd-key').find((b) => b.dataset.key === 'shiftL');
shiftBtn2.click();
log(mod.vkState.mods.has('shift'), '点 Shift 后 vkState.mods 里写入了 shift');
log(sent.every((m) => m.type !== 'key' || !m.keys.includes('shiftL')),
  'Shift 没有被当成普通键 "shiftL" 发出去');

// ---- 6) 按钮外观与 state 必须永远一致 ----
// 真实踩过：提示文字说"拖动中"，但「拖动画面」按钮还是灰的（用户截图反馈）。
// 根因是 UI 更新散落在多处、必然漏掉。现在统一由 syncKbButtons 负责，
// 这里验证这个契约。
const syncSrc = (() => {
  const a = src.indexOf('window.syncKbButtons =');
  const b = src.indexOf('// 「拖动画面」按钮：默认拖动=移动鼠标', a);
  return a >= 0 && b > a ? src.slice(a, b) : '';
})();
if (syncSrc.length > 50) {
  const win = {};
  const factory2 = new Function('state', '$', 'document', 'window', syncSrc + '\n; return window.syncKbButtons;');
  const st2 = { panMode: false, kbZoom: false };
  const sync = factory2(st2, global.$, global.document, win);

  const check = (pan, zoom, wantPanText, wantZoomText, tipWord) => {
    st2.panMode = pan; st2.kbZoom = zoom;
    sync();
    const okPan = nodes.vkbdPan.textContent === wantPanText;
    const okZoom = nodes.vkbdZoom.textContent === wantZoomText;
    const okLit = nodes.vkbdPan.classList.contains('on') === pan &&
      nodes.vkbdZoom.classList.contains('on') === zoom;
    const okTip = nodes.vkbdTipText.textContent.includes(tipWord);
    log(okPan && okZoom && okLit && okTip,
      `pan=${pan} zoom=${zoom} -> 按钮"${nodes.vkbdPan.textContent}"/"${nodes.vkbdZoom.textContent}"、点亮一致、提示含"${tipWord}"`);
  };

  check(false, false, '拖动画面', '放大画面', '需先点');
  check(true, false, '拖动中', '放大画面', '未放大');
  check(true, true, '拖动中', '还原大小', '上下左右');
  check(false, true, '拖动画面', '还原大小', '需先点');

  st2.panMode = true; st2.kbZoom = true; sync();
  log(nodes.vkbdTipGo.style.display === 'none', '两步都完成后隐藏「一键放大并允许拖动」按钮');
} else {
  log(false, '找不到 syncKbButtons 实现');
}

console.log('');
console.log(failures === 0 ? '虚拟键盘逻辑验证通过 ✅' : `存在 ${failures} 项问题 ❌`);
process.exit(failures === 0 ? 0 : 1);
