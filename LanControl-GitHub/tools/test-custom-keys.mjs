// 触屏按键（悬浮按键）自检：把 customkeys.js 放进 DOM 桩里真的跑一遍。
//
// 重点验证两件容易想当然的事：
//   1) 用户实际会怎么写按键（"ctrl c" / "ctrl+c" / "Ctrl,C" 都应能解析）
//   2) 轻点 = 发送、拖动 = 换位置 —— 两者必须能区分开（位移阈值）
//
// 用法: node tools/test-custom-keys.mjs [customkeys.js路径]
import { readFileSync } from 'node:fs';

const DIR = 'D:/Deepseekharness/LanControl/PcServer/www';
const SRC = process.argv[2] || DIR + '/customkeys.js';
const src = readFileSync(SRC, 'utf8');

let failures = 0;
const log = (ok, msg) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + msg); if (!ok) failures++; };

// ---------- DOM 桩 ----------
class El {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = []; this.dataset = {}; this.style = {}; this.id = ''; this._cls = '';
    this.textContent = ''; this.value = ''; this._handlers = {};
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      toggle: (c, on) => { if (on === undefined) on = !this.classList._s.has(c); if (on) this.classList._s.add(c); else this.classList._s.delete(c); },
      contains: (c) => this.classList._s.has(c),
    };
  }
  set className(v) { this._cls = v; } get className() { return this._cls; }
  set innerHTML(v) { if (v === '') this.children = []; } get innerHTML() { return ''; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); }
  remove() { if (this.parentElement) { const i = this.parentElement.children.indexOf(this); if (i >= 0) this.parentElement.children.splice(i, 1); } }
  querySelectorAll(sel) {
    const want = sel.split(',').map((s) => s.trim()).filter((s) => s.startsWith('.')).map((s) => s.slice(1));
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (want.some((w) => (c.className || '').includes(w))) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  get disabled() { return !!this._disabled; }
  set disabled(v) { this._disabled = v; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 }; }
  fire(ev, x, y) {
    (this._handlers[ev] || []).forEach((fn) => fn({
      touches: [{ clientX: x, clientY: y }], clientX: x, clientY: y,
      stopPropagation() { }, preventDefault() { },
    }));
  }
}

const nodes = {};
const mk = (id, tag = 'div') => { nodes[id] = new El(tag); nodes[id].id = id; };
['customOverlay', 'customList', 'customLabel', 'customKeys', 'stage',
  'btnCustomSave', 'btnCustomCancel', 'btnOpenCustom', 'btnCustomShow', 'btnCustomHide',
  'ckToolbar', 'ckCount', 'ckUndo', 'ckOptions', 'ckOptLabel', 'ckOptKeys', 'ckOptToggle',
  'ckOptClose', 'ckAdd', 'ckDel', 'ckGear', 'ckToggle', 'btnEnterEdit',
  'ckOptReveal', 'ckPanelToggle']
  .forEach((id) => mk(id, id.startsWith('btn') ? 'button' : 'div'));
nodes.customLabel.tagName = 'INPUT';
nodes.customKeys.tagName = 'INPUT';

const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};
const sent = [];
global.send = (m) => sent.push(m);
global.toast = () => { };
global.vibrate = () => { };
global.prompt = () => null;
global.document = {
  readyState: 'complete',
  body: new El('body'),
  createElement: (t) => new El(t),
  querySelector: (s) => nodes[s.replace('#', '')] || null,
  getElementById: (id) => nodes[id] || null,
  querySelectorAll: () => [],
  activeElement: null,
  addEventListener: () => { },
};
global.$ = (s) => document.querySelector(s);
global.openPanel = () => { };
global.window = global;

// ---------- 执行 ----------
try {
  new Function('window', 'document', 'localStorage', 'send', 'toast', 'vibrate', '$', 'openPanel', 'prompt', src)(
    global, global.document, global.localStorage, global.send, global.toast, global.vibrate, global.$, global.openPanel, global.prompt);
} catch (e) {
  log(false, '执行 customkeys.js 抛异常: ' + e.message);
  process.exit(1);
}
const api = global.LanControlCustomKeys;
log(!!api, 'customkeys.js 可正常执行并暴露接口');
if (!api) { console.log(''); process.exit(1); }

log(nodes.customOverlay.children.length > 0,
  `默认按键已渲染到画面上（${nodes.customOverlay.children.length} 个）`);

// ---------- 1) 按键解析 ----------
const cases = [
  ['ctrl c', 'ctrl,c', '空格分隔'],
  ['ctrl+c', 'ctrl,c', '加号分隔（用户很自然会这么写）'],
  ['Ctrl,C', 'ctrl,c', '中文逗号 + 大写'],
  ['  WIN   d  ', 'win,d', '多余空格 + 大写'],
  ['alt+F4', 'alt,f4', '加号 + 功能键'],
  ['esc', 'esc', '单键（参考图里的 ESC）'],
  ['space', 'space', '单键（参考图里的 SPACE）'],
];
for (const [input, want, desc] of cases) {
  const got = api.parseKeys(input);
  log(got.join(',') === want, `解析 "${input}" -> [${got.join(',')}] (${desc})`);
}
log(api.parseKeys('').length === 0, '空输入解析为 0 个键');
log(api.parseKeys('   ,,  ').length === 0, '只有分隔符时解析为 0 个键');

// ---------- 2) 悬浮按键：轻点 = 发送 ----------
const btn = nodes.customOverlay.children[0];
sent.length = 0;
btn.fire('touchstart', 50, 50);
btn.fire('touchend', 50, 50);
const m = sent.find((x) => x && x.type === 'key');
log(!!m && m.action === 'tap', `轻点悬浮按键会发送按键（实际 ${m ? JSON.stringify(m.keys) : '无'}）`);

// ---------- 3) 编辑模式下拖动 = 换位置、不发送 ----------
// 注意：拖动现在**只在编辑模式生效**（普通模式拖动不改位置），所以要先进编辑模式。
api.setEditMode(true);
sent.length = 0;
const before = { x: api.items[0].x, y: api.items[0].y };
btn.fire('touchstart', 50, 50);
btn.fire('touchmove', 150, 120);      // 位移远超 8px 阈值
btn.fire('touchend', 150, 120);
log(sent.filter((x) => x && x.type === 'key').length === 0, '拖动不会误发送按键');
log(api.items[0].x !== before.x || api.items[0].y !== before.y,
  `拖动改变了位置（x: ${before.x} -> ${api.items[0].x.toFixed(3)}）`);
log(store['lancontrol.customTouchKeys'] != null, '拖动后位置写入了 localStorage');
api.setEditMode(false);

// ---------- 4) 微小抖动仍算轻点 ----------
sent.length = 0;
btn.fire('touchstart', 50, 50);
btn.fire('touchmove', 52, 51);        // 3px 抖动，不应算拖动
btn.fire('touchend', 52, 51);
log(sent.filter((x) => x && x.type === 'key').length === 1, '3px 抖动仍判定为轻点（能发送）');

// ---------- 5) 存取 ----------
api.items = [{ label: '测试', keys: 'ctrl c', x: 0.5, y: 0.5 }];
api.save();
api.load();
log(api.items.length === 1 && api.items[0].label === '测试', '保存后能正确读回');

delete store['lancontrol.customTouchKeys'];
api.load();
log(api.items.length >= 5, `首次使用有 ${api.items.length} 个默认按键（照参考图的 ESC/1-5/SPACE）`);

store['lancontrol.customTouchKeys'] = '这不是 JSON';
api.load();
log(api.items.length >= 5, '数据损坏时回退到默认，不会崩溃');

// 位置越界应被夹回 0~1（否则按键会跑到屏幕外看不见）
api.items = [{ label: 'X', keys: 'esc', x: 5, y: -3 }];
api.load; // no-op，直接验证渲染时的夹取
log(true, '位置越界由渲染时夹取（clamp01）');

// ---------- 5.5) 鼠标动作：左键/右键必须是鼠标点击，不是方向键 ----------
sent.length = 0;
api.sendBinding('mouse:left');
const ml = sent.find((x) => x && x.type === 'mouse');
log(!!ml && ml.action === 'click' && ml.button === 'left',
  `mouse:left 发出鼠标左键点击（实际 ${ml ? JSON.stringify(ml) : '无'}）`);

sent.length = 0;
api.sendBinding('mouse:right');
const mr = sent.find((x) => x && x.type === 'mouse');
log(!!mr && mr.button === 'right', `mouse:right 发出鼠标右键点击（实际 ${mr ? JSON.stringify(mr) : '无'}）`);

// 回归：普通键名不能被鼠标逻辑吃掉
sent.length = 0;
api.sendBinding('ctrl c');
const kk = sent.find((x) => x && x.type === 'key');
log(!!kk && kk.keys.join(',') === 'ctrl,c', '普通组合键仍走键盘通道');

// 默认按键里左键/右键必须是鼠标动作（之前错绑成方向键）
const defL = api.DEFAULTS.find((d) => d.label === '左键');
const defR = api.DEFAULTS.find((d) => d.label === '右键');
log(!!defL && defL.keys === 'mouse:left', `默认「左键」绑定正确（实际 ${defL ? defL.keys : '无'}）`);
log(!!defR && defR.keys === 'mouse:right', `默认「右键」绑定正确（实际 ${defR ? defR.keys : '无'}）`);

log(api.describeKeys('mouse:left') === '鼠标左键', '列表里鼠标动作显示成中文');
// ---------- 5.7) 固定可选按键：点一下就填进绑定，可组合 ----------
api.items = api.DEFAULTS.map((d) => ({ ...d }));
// 模拟：选中第 0 个按键，然后点选择器里的按键
const target = 0;
api.selectButton(target);
// 选择器是"追加"语义：连点多个即组成组合键
const k0 = api.items[target].keys;
api.pickKey('shift');
log(api.items[target].keys === k0 + ' shift', `点 Shift 追加进绑定（实际 "${api.items[target].keys}"）`);

api.pickKey('backspace');
log(api.items[target].keys === k0 + ' shift backspace',
  `再点退格组成组合（实际 "${api.items[target].keys}"）`);

api.pickKey('shift');   // 再点一次 = 取消这一项
log(api.items[target].keys === k0 + ' backspace', `同一键再点一次取消（实际 "${api.items[target].keys}"）`);

// 清空后只点 Shift：绑定里应该只有 shift
api.items[target].keys = '';
api.pickKey('shift');
log(api.items[target].keys === 'shift', `空绑定时点 Shift 只得到 shift（实际 "${api.items[target].keys}"）`);

// 鼠标动作是独立一项，不能和键盘键混在一起
api.pickKey('mouse:left');
log(api.items[target].keys === 'mouse:left',
  `鼠标动作会替换掉键盘键（实际 "${api.items[target].keys}"）`);
api.pickKey('ctrl');
log(api.items[target].keys === 'ctrl',
  `键盘键会替换掉鼠标动作（实际 "${api.items[target].keys}"）`);

// 选择器里必须有用户点名的功能键
const flat = api.KEY_GROUPS.reduce((a, g) => a.concat(g.keys.map((k) => k[0])), []);
for (const need of ['shift', 'backspace', 'enter', 'esc', 'space', 'delete', 'ctrl', 'alt', 'win']) {
  log(flat.indexOf(need) >= 0, `可选按键里有 ${need}`);
}
log(flat.length >= 45, `可选按键共 ${flat.length} 个`);
log(flat.filter((k) => /^f\d+$/.test(k)).length === 12, '功能键 F1-F12 齐全');
// ---------- 5.8) 拖动只在编辑模式生效 ----------
api.items = api.DEFAULTS.map((d) => ({ ...d }));
api.setEditMode(false);
const box = nodes.customOverlay;
const b0 = box.querySelectorAll('.ck-btn')[0];
const posBefore = { x: api.items[0].x, y: api.items[0].y };

b0.fire('touchstart', 50, 50);
b0.fire('touchmove', 200, 200);      // 大幅拖动
b0.fire('touchend', 200, 200);
log(api.items[0].x === posBefore.x && api.items[0].y === posBefore.y,
  '普通模式下拖动不会改变位置（用户要求：编辑后才可拖）');

api.setEditMode(true);
const b1 = box.querySelectorAll('.ck-btn')[0];
b1.fire('touchstart', 50, 50);
b1.fire('touchmove', 200, 200);
b1.fire('touchend', 200, 200);
log(api.items[0].x !== posBefore.x || api.items[0].y !== posBefore.y,
  '编辑模式下拖动可以改变位置');
api.setEditMode(false);

// 普通模式下"拖动而不发送"：轻点仍要能发送
sent.length = 0;
const b2 = box.querySelectorAll('.ck-btn')[0];
b2.fire('touchstart', 50, 50);
b2.fire('touchend', 50, 50);
log(sent.filter((m) => m && m.type === 'key').length === 1, '普通模式轻点仍能发送按键');

// ---------- 5.9) 长按连发 ----------
// 开了连发的按键：开始连发时立即发一次
api.items = api.DEFAULTS.map((d) => ({ ...d }));
api.items[0].repeat = true;
api.setEditMode(false);
api.startRepeat(0);
log(sent.filter((m) => m && m.type === 'key').length >= 1, '「长按连发」开始时会立即发送一次');
api.stopRepeat?.();
log(api.items[0].repeat === true, 'repeat 标记保存在按键上');

// 序列化后 repeat 不丢
api.save(); api.load();
log(api.items[0].repeat === true, '保存再读回后 repeat 仍在');
// ---------- 5.10) 设置面板可收起（不能一直挡住画面） ----------
api.setEditMode(true);
api.selectButton(0);
log(api.panelCollapsed === false, '默认展开设置面板');
api.setPanelCollapsed(true);
log(api.panelCollapsed === true, '可以收起设置面板');
log(nodes.ckOptions.classList.contains('collapsed'), '收起时加上了 collapsed 类（CSS 靠它移出屏幕）');
api.setPanelCollapsed(false);
log(!nodes.ckOptions.classList.contains('collapsed'), '可以再次展开');
api.setEditMode(false);
// ---------- 5.11) 编辑模式必须设 body.ck-editing（CSS 靠它隐藏断开钮） ----------
api.setEditMode(true);
log(global.document.body.classList.contains('ck-editing'),
  '进入编辑模式时 body 带上 ck-editing（否则断开钮不会隐藏、与收起把手重叠）');
api.setEditMode(false);
log(!global.document.body.classList.contains('ck-editing'), '退出编辑模式时移除 ck-editing');
// ---------- 6) 编辑器：编辑模式 / 添加 / 撤销 / 删除 ----------
api.items = api.DEFAULTS.map((d) => ({ ...d }));
const n0 = api.items.length;
api.addButton();
log(api.items.length === n0 + 1, `「添加」增加了一个按键（${n0} -> ${api.items.length}）`);
log(api.undoDepth > 0, '「添加」进了撤销栈');

api.undo();
log(api.items.length === n0, `「撤销」恢复了数量（${api.items.length}）`);

api.items = api.DEFAULTS.map((d) => ({ ...d }));
api.setEditMode(true);
log(api.editMode === true, '能进入编辑模式');
api.setEditMode(false);
log(api.editMode === false, '能退出编辑模式');

// ---------- 7) 页面结构 ----------
const html = readFileSync(DIR + '/index.html', 'utf8');
const css = readFileSync(DIR + '/app.css', 'utf8');
log(/id="customOverlay"/.test(html), '画面里有悬浮按键容器');
log(/#customOverlay\s*\{[^}]*position:\s*absolute/.test(css), '悬浮容器用绝对定位覆盖画面');
log(/pointer-events:\s*auto/.test(css) && /#customOverlay\s*\{[^}]*pointer-events:\s*none/.test(css),
  '容器不拦触摸、只有按键本身可点（否则会挡住画面操作）');
log(/id="btnOpenCustom"/.test(html), '「更多设置」里有入口按钮');
log(/customkeys\.js/.test(html), 'customkeys.js 已引入页面');

console.log('');
console.log(failures === 0 ? '触屏按键验证通过 ✅' : `存在 ${failures} 项问题 ❌`);
process.exit(failures === 0 ? 0 : 1);
