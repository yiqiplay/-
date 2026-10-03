// 手机端 UI 静态审计：确认关键图标、按钮、悬浮控件都在，且没有"依赖 emoji 才能显示"的图标。
// 用法: node audit-web.mjs <www目录>
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] || 'D:\\Deepseekharness\\LanControl\\PcServer\\www';
let failures = 0;
const ok = (cond, msg) => { if (!cond) failures++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); };

const html = readFileSync(join(dir, 'index.html'), 'utf8');
const css = readFileSync(join(dir, 'app.css'), 'utf8');
const js = readFileSync(join(dir, 'app.js'), 'utf8');

// ---- 1) 关键元素必须存在 ----
const mustHaveIds = [
  'topbar', 'toolbar', 'stage', 'screen', 'drawer',
  'btnVmouseTop', 'btnAudio', 'btnFullscreen2', 'btnKeyboard', 'btnPanic',
  'floatingExit', 'floatBar', 'btnBarHide', 'discoverBtn', 'addrInput', 'codeInput', 'connectBtn',
];
for (const id of mustHaveIds) {
  ok(html.includes(`id="${id}"`), `元素 #${id} 存在`);
}

// ---- 2) 悬浮控件必须在 #stage 之外（否则会被层叠/裁剪影响，部分机型点不到）----
const stageStart = html.indexOf('id="stage"');
const stageEnd = html.indexOf('</div>', html.indexOf('id="waitingDiag"'));
const inStage = (id) => {
  const p = html.indexOf(`id="${id}"`);
  return p > stageStart && p < stageEnd;
};
ok(!inStage('floatingExit'), '#floatingExit 在 #stage 之外（不受 stage 层叠影响）');
ok(!inStage('floatBar'), '#floatBar 在 #stage 之外');

// ---- 3) CSS：任何模式下都不能出现"工具条/退出入口消失且无法恢复" ----
ok(/body\.immersive #topbar \{ display: none !important; \}/.test(css), '沉浸模式隐藏顶栏');
ok(/body\.immersive #floatingExit \{ display: flex; \}/.test(css), '沉浸模式显示悬浮退出钮');
ok(/body\.fs #floatingExit \{ display: flex; \}/.test(css), '真全屏时也显示悬浮退出钮');
ok(/body\.barhidden \.float-bar \{ display: flex; \}/.test(css), '工具条收起后显示唤出圆钮');
ok(/#floatingExit \{[^}]*position: fixed/.test(css), '悬浮退出钮用 position: fixed');
ok(/#floatingExit \{[^}]*z-index: 60/.test(css), '悬浮退出钮层级足够高');

// ---- 4) JS：切换逻辑必须成对存在 ----
ok(js.includes('function setBarHidden'), '存在 setBarHidden 统一切换');
ok(/setBarHidden\(true\)/.test(js) && /setBarHidden\(false\)/.test(js), '收起与唤回都有入口');

// ---- 5) 不能再依赖 emoji 表达关键功能（部分安卓机型不显示，图标会"消失"）----
const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const toolbarBlock = html.slice(html.indexOf('id="toolbar"'), html.indexOf('</nav>', html.indexOf('id="toolbar"')));
const emojiInToolbar = toolbarBlock.match(/[\u{1F300}-\u{1FAFF}]/gu) || [];
ok(emojiInToolbar.length === 0,
  `工具条不含 emoji 图标（发现 ${emojiInToolbar.length} 个: ${emojiInToolbar.join('') || '无'}）`);

const topbarBlock = html.slice(html.indexOf('id="topbar"'), html.indexOf('</header>'));
const emojiInTopbar = topbarBlock.match(/[\u{1F300}-\u{1FAFF}]/gu) || [];
ok(emojiInTopbar.length === 0,
  `顶栏不含 emoji 图标（发现 ${emojiInTopbar.length} 个: ${emojiInTopbar.join('') || '无'}）`);

// ---- 6) 搜索电脑：必须是真扫描，不能是 fetch 自己 ----
ok(js.includes('function runDiscovery'), '存在 runDiscovery 真扫描实现');
ok(/for \(let i = 1; i <= 254/.test(js), '扫描 /24 全段（1..254）');
ok(!js.includes('#hostInput'), '不再引用不存在的 #hostInput（真实 id 是 #addrInput）');
ok(/normalizeHost/.test(js) && /wsUrl\(target\)/.test(js), '连接时真正使用地址栏的内容（而不是写死 location.host）');
ok(!/discoverBtn'\)\.onclick = \(\) => \{\s*setLoginMsg\('正在搜索/.test(js), '已移除原来那个只 fetch 自己的假搜索');

// ---- 7) 声音：采样率要跟随手机端的 AudioContext ----
ok(/sampleRate/.test(js), '手机端会告知采样率');

// ---- 8) 关键：靠 CSS 规则显隐的元素，HTML 上不能带 .hidden ----
// .hidden 是 display:none !important，会压死任何"靠 CSS 显示"的规则。
// 这个 bug 真实发生过：floatBar 带 class="hidden"，导致工具条收起后唤回圆钮永不出现，
// 用户表现就是"收起后再也抬不起工具栏"。加这条检查防止复发。
const revealRules = [
  { id: 'floatBar', rule: /body\.barhidden \.float-bar\s*\{[^}]*display:\s*flex/, desc: '工具条收起后的唤回圆钮' },
  { id: 'floatingExit', rule: /body\.immersive #floatingExit\s*\{[^}]*display:\s*flex/, desc: '沉浸模式的悬浮断开钮' },
];
for (const { id, rule, desc } of revealRules) {
  ok(rule.test(css), `CSS 里有显示「${desc}」的规则`);
  const at = html.indexOf(`id="${id}"`);
  const tag = at < 0 ? '' : html.slice(Math.max(0, at - 130), at + 40);
  ok(!/class="[^"]*\bhidden\b[^"]*"/.test(tag),
    `「${desc}」（#${id}）没有带 .hidden 类（带了就永远显示不出来）`);
}

// ---- 9) 图标按钮不能被 textContent / innerHTML 覆盖 ----
// 真实踩过：updateFullscreenUi 里 fb.textContent = '⌃' 把浮钮的 SVG 抹掉，
// ---- 9) 图标按钮不能被 textContent / innerHTML 覆盖 ----
// 真实踩过：updateFullscreenUi 里 fb.textContent = '⌃' 把浮钮的 SVG 抹掉，
// 圆钮变成没有图标的空按钮，用户以为"点了没反应"。
// 检查所有对这几个 id 的元素写入文字/HTML 的语句（先剥掉注释，避免误伤说明文字）。
const iconIds = ['floatBar', 'floatingExit', 'btnFullscreen2', 'btnVmouseTop', 'btnAudio', 'btnFsBar'];
const jsNoBlockComments = js.replace(/\/\*[\s\S]*?\*\//g, '');
const clobberLines = jsNoBlockComments.split('\n').map((l, i) => ({ l: l.trim(), n: i + 1 })).filter(({ l }) => {
  if (l.startsWith('//')) return false;
  if (!/(textContent|innerHTML)\s*=/.test(l)) return false;
  return iconIds.some((id) => l.includes(`#${id}`)) || /(fb|floatBar|floatingExit|b2|vmTop|audioBtn|fsBar)\s*\)?\s*\.(textContent|innerHTML)\s*=/.test(l);
});
ok(clobberLines.length === 0,
  `图标按钮没有被 textContent/innerHTML 覆盖（违规: ${clobberLines.length ? clobberLines.map((o) => 'L' + o.n).join(',') : '无'}）`);

// ---- 10) 收起工具条的 CSS 不能依赖 .immersive ----
// 真实踩过：`body.immersive.barhidden #toolbar{display:none}` —— 非全屏下点「收起」
// 虽然加上了 barhidden 类却匹配不到规则，表现为"点了没反应"，而全屏下两个类都在、
// 反而正常，症状极具误导性。这条检查防止再写成依赖 immersive 的形式。
// 先剥掉 CSS 注释，否则解释这个坑的注释本身会被当成规则匹配
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
const barhideRules = cssNoComments.match(/body\.[\w.]*barhidden[^{]*\{[^}]*display:\s*none[^}]*\}/g) || [];
const badBarhide = barhideRules.filter((r) => /#toolbar/.test(r) && /immersive/.test(r));
ok(badBarhide.length === 0,
  `收起工具条的规则不依赖 .immersive（违规: ${badBarhide.length ? badBarhide[0].slice(0, 60) : '无'}）`);
ok(/body\.barhidden #toolbar\s*\{[^}]*display:\s*none/.test(cssNoComments),
  '存在 body.barhidden #toolbar{display:none} 规则（非全屏也能收起工具条）');

// ---- 10.5) 虚拟键盘面板必须存在且已接入 ----
ok(/id="vkbdPanel"/.test(html), '存在虚拟键盘面板 #vkbdPanel');
ok(/id="vkbdBody"/.test(html) && /id="vkbdMods"/.test(html), '虚拟键盘有键区与修饰键区');
ok(/function renderVkbd/.test(js), '存在 renderVkbd 渲染函数');
ok(/vkbd: 'vkbdPanel'/.test(js), '工具条 vkbd 动作已接入');
ok(/vkbdPanel: 'vkbd'/.test(js), 'panelAct 里的高亮映射已补 vkbd');
ok(/data-act="vkbd"/.test(html), '工具条有「键盘」按钮');
// ---- 10.6) 横屏/矮屏必须能完整够到键盘与面板 ----
// 真实踩过：手机横屏时虚拟键盘只显示 4 行，底部（ZXCV/方向键/空格）被裁掉，
// 而且面板不滚 —— 根因是 max-height 用了 % 且没有 overflow。
// 要求：① 键盘区可滚动 ② 有横屏媒体查询 ③ 高度用 dvh 而不是纯 %
ok(/orientation:\s*landscape/.test(css), 'CSS 有横屏（landscape）媒体查询');
ok(/#vkbdBody\s*\{[^}]*overflow-y:\s*auto/.test(cssNoComments), '虚拟键盘区可滚动（矮屏不会被裁掉）');

ok(/min-height:\s*0/.test(cssNoComments), 'flex 滚动子项设置了 min-height:0');
ok(/max-height:\s*380px/.test(css), '有极矮屏（<380px）的兜底档位');
// ---- 10.7) 禁止使用可能在老 WebView 上"整条声明失效"的 CSS 函数 ----
// 真实踩过：max-height: min(400px, 58vh) —— 老 WebView 不认 min()，
// 会把**整条声明丢弃**（不是回退），导致 max-height 完全失效、键盘占满整屏。
// 这类"用了新函数就全丢"的写法必须避免；只写最基础的 vh/px。
const riskyCssFns = [
  { re: /\bmin\(/g, name: 'min()' },
  { re: /\bmax\(/g, name: 'max()' },
  { re: /\bclamp\(/g, name: 'clamp()' },
];
const riskyHits = [];
for (const { re, name } of riskyCssFns) {
  const m = cssNoComments.match(re);
  if (m) riskyHits.push(`${name}x${m.length}`);
}
ok(riskyHits.length === 0, `CSS 未使用易失效的函数（min/max/clamp）（违规: ${riskyHits.join(', ') || '无'}）`);
// dvh 只在同一声明里与 vh 并存时才算安全；这里直接要求不出现 dvh
const dvhCount = (cssNoComments.match(/dvh/g) || []).length;
ok(dvhCount === 0, `CSS 未使用 dvh（老 WebView 不支持会丢声明）（违规: ${dvhCount} 处）`);
ok(/#vkbdPanel\s*\{[^}]*max-height:\s*\d+vh/.test(cssNoComments), '键盘面板用纯 vh 封顶高度');
ok(/body\.vkbd-open\s+#toolbar\s*\{[^}]*display:\s*none/.test(cssNoComments),
  '键盘打开时隐藏工具栏（避免面板与工具栏叠在一起）');
// ---- 10.8) 可滚动区域必须能真正滚动 ----
// 真实踩过：.file-list 有 overflow-y:auto 但缺 min-height:0，
// flex 子项默认 min-height:auto 会撑破父容器而不是滚动，
// 用户反馈"上传文件界面可滑动区域太少"。
ok(/\.file-list\s*\{[^}]*overflow-y:\s*auto/.test(cssNoComments), '文件列表可滚动');
ok(/\.file-list\s*\{[^}]*min-height:\s*0/.test(cssNoComments),
  '文件列表有 min-height:0（否则 flex 下滚不动）');
// 键盘打开时要隐藏工具栏（面板是绝对定位，否则两者叠在一起）
ok(/body\.vkbd-open\s+#toolbar/.test(cssNoComments), '键盘打开时隐藏下方工具栏');
// 面板要有拖动把手，用户可自行调节高度
ok(/class="panel-grip"/.test(html) && /function setupPanelGrips/.test(js),
  '面板有拖动把手可调节高度');
// ---- 10.9) 虚拟鼠标状态必须同时刷新工具条与顶栏两处图标 ----
// 真实踩过：setVmouseEnabled 只改工具条 .tb，点顶栏按钮时又只改顶栏，
// 于是"切换后总有一处图标不更新"。
ok(/function setVmouseEnabled/.test(js), '存在 setVmouseEnabled');
ok(/setVmouseEnabled[\s\S]{0,900}#btnVmouseTop/.test(js),
  '虚拟鼠标图标两处同步（setVmouseEnabled 里同时刷新顶栏 #btnVmouseTop）');
ok(/\.tb\.active\s*\{[^}]*background/.test(cssNoComments),
  '工具条激活态有背景色（只改字色的话视觉上看不出来）');
ok(/\.icon-btn\.on\s*\{/.test(cssNoComments), '顶栏图标按钮有 .on 激活态样式');
// ---- 10.95) openPanel 不能无条件重写所有工具条按钮的 active ----
// 真实踩过：`querySelectorAll('.tb').forEach(b => b.classList.toggle('active', ...))`
// 会把全屏 / 虚拟鼠标 / 鼠标 / 滚动这些**模式类**按钮的高亮一起抹掉，
// 表现为"进入全屏后图标不更新"。
ok(/const PANEL_ACTS\s*=/.test(js), '定义了 PANEL_ACTS（openPanel 只负责面板类按钮）');
ok(/PANEL_ACTS\.includes\(b\.dataset\.act\)/.test(js),
  'openPanel 只更新面板类按钮，不动模式类按钮的高亮');
ok(!/querySelectorAll\('\.tb'\)\.forEach\(\(b\) => b\.classList\.toggle\('active', b\.dataset\.act === panelAct\(id\)\)\)/.test(js),
  '没有残留的"无条件重写所有 .tb active"写法');
// ---- 10.96) 键盘按键不写死像素宽度 ----
// 写死宽度在宽屏上会让两边各留一大块空白（用户反馈"两边很空"）；
// 但也不能用 flex-shrink:1 的极小宽度（曾把左右 Shift 压成 0 宽直接消失）。
ok(!/\.vkbd-key\s*\{[^}]*\bwidth:\s*\d+px/.test(cssNoComments),
  '键盘按键不写死像素宽度（改用 flex 份数撑满整行）');
ok(/\.vkbd-key\s*\{[^}]*flex:\s*1 1 0/.test(cssNoComments), '键盘按键用 flex 撑满整行');
ok(/function vkWeight/.test(js), '存在按标签长度计算 flex 份数的 vkWeight');
// ---- 10.97) 滑动时不应误触按键 / 不应操纵画面 ----
// 真实踩过：手指在键盘上滑动想滚动时按到了键，直接误发按键；
// 在抽屉里滑动时事件冒泡到 #stage，被当成鼠标操作发给电脑。
ok(/const vkScroll\s*=/.test(js), '存在滑动判定状态 vkScroll');
ok(/function vkTap[\s\S]{0,200}vkScroll\.active/.test(js), '滑动时不应触发按键（vkTap 里有滑动判定）');
ok(/closest\('#drawer, \.panel, #topbar, #toolbar/.test(js),
  '抽屉/面板/顶栏/工具条里的触摸不会被当作画面操作');
ok(/\.drawer-body\s*\{[^}]*min-height:\s*0/.test(cssNoComments),
  '抽屉正文有 min-height:0（否则滚不动且底部留白）');
ok(!/\.drawer\s*\{[^}]*max-height/.test(cssNoComments),
  '抽屉没有被压 max-height（会造成底部留空）');
// ---- 10.98) Caps 必须有本地状态、长按字母要能连发 ----
// 真实踩过：Caps 只是把按键发给电脑，本地不记录状态，
// 于是"点了 Caps 图标不高亮、字母也不变大写"。
ok(/caps:\s*false/.test(js), 'Caps 有本地状态 vkState.caps');
ok(/vkState\.caps = !vkState\.caps/.test(js), '点击 Caps 会切换本地状态');
ok(/vkState\.mods\.has\('shift'\) \|\| vkState\.caps/.test(js), 'Caps 打开时字母显示大写');
ok(/\.vkbd-key\.on\s*\{/.test(cssNoComments), 'Caps 有 .on 高亮样式');
ok(/function vkBindRepeat/.test(js), '字母支持长按连续输出');
// ---- 10.99) 键盘布局要对齐真实键盘，且键盘打开时能拖动画面 ----
// 用户要求：Tab 移进键盘内部（对齐真实键盘）；键盘打开时能上下拖画面看被挡住的部分。
ok(/\[\['tab', 'Tab'[\s\S]{0,20}\['q', 'q'/.test(js), 'Tab 在 QWERTY 排最左（对齐真实键盘）');
ok(/\[\['shiftL', 'Shift'/.test(js) && /\['shiftR', 'Shift'/.test(js), '左右 Shift 都在');
ok(/\[\['ctrl', 'Ctrl'[\s\S]{0,200}\['space', '空格'/.test(js), '修饰键在最下一排（Ctrl Win Alt 空格 …）');
ok(/\['enter', '回车'/.test(js), '主键区有回车键');
ok(/state\.panY/.test(js), '画面支持上下平移（键盘打开时查看下方）');
ok(/v-kbd-open'\)\)[\s\S]{0,80}panId/.test(js) || /panId/.test(js), '拖动画面手势已实现');
ok(/function scheduleRedraw/.test(js), '存在拖动时的重绘调度');
// ---- 10.995) 键盘布局对齐真实键盘；键盘打开时画面真的能拖动 ----
// 真实键盘没有独立的修饰键行，修饰键在最下一排（Ctrl Win Alt 空格 Alt Win 菜单 Ctrl）。
// 早期自造了一行 Ctrl/Shift/Alt/Win —— 属于重复按键。
ok(/const VK_MODS = \[\];/.test(js), '修饰键不重复（不再单独占一行）');
ok(/VK_MOD_ALIAS/.test(js), '左右两侧 Alt/Win/Ctrl 共用粘滞状态');
// 拖画面必须真的可拖：画面要放大到超出舞台，否则 maxPan 恒为 0
// 键盘打开时**不得**自动放大画面 —— 用户明确反馈过"画面被放大且无法缩放"。
// 缩放应该只由用户的双指手势决定。
ok(!/panNeed/.test(js) && !/kbOpen/.test(js), '键盘打开时不自动放大画面（缩放交给用户）');
ok(/state\.panX/.test(js) && /state\.panY/.test(js), '画面支持上下左右拖动');
ok(/ev\.stopImmediatePropagation\(\)/.test(js), '拖画面时截断事件，不会变成操纵鼠标');
// ---- 10.996) 「放大画面」必须是用户主动点的，默认关闭 ----
ok(/id="vkbdZoom"/.test(html), '键盘面板有「放大画面」按钮');
ok(/state\.kbZoom/.test(js), '缩放由 state.kbZoom 控制（用户主动开启）');
ok(!/kbOpen\s*\)\s*scale/.test(js), '没有"打开键盘就自动放大"的残留写法');
ok(/\.vkbd-zoom/.test(cssNoComments), '放大按钮有样式');
// ---- 10.997) 修饰键状态要有文字显示；退格要能长按连发 ----
// 高亮只靠颜色时，颜色一旦不生效就完全无从判断，所以额外显示文字状态。
ok(/id="vkbdArmed"/.test(html), '键盘面板有「已预备」状态显示');
ok(/function vkPaintArmed/.test(js), '存在 vkPaintArmed 刷新状态文字');
ok(/name === 'backspace'\) vkBindRepeat|backspace' \|\| name === 'delete'/.test(js),
  '退格/Del 支持长按连续输出');
ok(/return dh - sh;/.test(js) && /return dw - sw;/.test(js), '有溢出就允许拖满整个溢出量（能拖到底、左右也能拖）');
// ---- 10.998) 修饰键点击必须真的刷新高亮与状态文字 ----
// 真实踩过：vkModTap 只调了 paintMods（它只扫 #vkbdMods），而修饰键在底排 #vkbdBody，
// 于是 vkState.mods 写进去了、界面毫无变化 —— "连携键没有高亮"改了四轮才找到。
// 更完整的验证见 tools/test-vkbd-logic.mjs（在 Node 里真的执行一遍点击流程）。
ok(/function vkModTap[\s\S]{0,900}vkPaintState\(\)/.test(js),
  'vkModTap 会调用 vkPaintState（否则点了修饰键界面不更新）');
ok(/function vkModTap[\s\S]{0,900}vkPaintArmed\(\)/.test(js),
  'vkModTap 会调用 vkPaintArmed');
ok(/name === 'backspace' \|\| name === 'delete'\) vkBindRepeat/.test(js), '退格/Del 与字母一样支持长按连发');
// ---- 10.999) 拖动画面必须是显式开关，且默认关闭 ----
// 真实踩过两轮：
//   ① 一进 touchstart 就 stopImmediatePropagation() -> **虚拟鼠标在键盘打开时完全失效**；
//   ② 改成"拖黑色留白=移画面"-> 放大后画面铺满舞台、根本没有留白，区分不成立。
ok(/panMode:\s*false/.test(js), 'panMode 默认关闭（默认拖动=移动鼠标，不会屏蔽虚拟鼠标）');
ok(/if \(!state\.panMode\) return;/.test(js), '拖画面手势由 panMode 显式控制');
ok(/id="vkbdPan"/.test(html), '键盘面板有「拖动画面」开关按钮');
// ---- 10.9995) 拖动范围依赖的四个尺寸变量必须都有赋值 ----
// 真实踩过：state.stageW / state.imgW 从未被赋值（一次字符串替换静默失败），
// 导致 panMaxX() 恒返回 0 —— 表现是"左右拖动完全没反应"，极难排查。
for (const v of ['state.stageW =', 'state.imgW =', 'state.stageH =', 'state.imgH =']) {
  ok(js.includes(v), `${v.trim()} 有赋值（缺失会导致对应方向拖不动）`);
}
// ---- 10.9997) 键盘必须有提示条，说明"拖画面要先放大" ----
// 用户反馈"打开虚拟键盘后缺少提示，如必须放大画面后才可以拖动画面"。
ok(/id="vkbdTip"/.test(html), '键盘面板有提示条');
ok(/id="vkbdTipText"/.test(html), '提示条有文字位');
ok(/id="vkbdTipGo"/.test(html), '提示条有「一键放大并允许拖动」按钮');
ok(/window\.refreshKbTip = /.test(js), '提示文字会随状态刷新');
// ---- 10.9998) 键盘按钮外观必须由单一函数同步 ----
// 真实踩过：提示文字说"拖动中"、按钮却还是灰的（用户截图）。
// 根因是 UI 更新散落在多处（一键按钮写一次、各自 onclick 再写一次），必然漏掉。
ok(/window\.syncKbButtons = /.test(js), '存在统一的 syncKbButtons');
// 按钮外观只允许出现在 syncKbButtons 里：统计全文件出现次数应恰好每组一次
const panPaint = (js.match(/panBtn\.textContent/g) || []).length;
const zoomPaint = (js.match(/zoomBtn\.textContent/g) || []).length;
ok(panPaint === 1, `「拖动画面」按钮文字只在 syncKbButtons 里改一次（实际 ${panPaint} 处）`);
ok(zoomPaint === 1, `「放大画面」按钮文字只在 syncKbButtons 里改一次（实际 ${zoomPaint} 处）`);
ok(!/pb\.classList|zb\.classList/.test(js), '没有残留的"就地改按钮外观"写法');
// ---- 10.9999) Toast 不得与提示条重复 ----
// 真实踩过：提示条显示"拖动中…"，同时又弹一个内容几乎一样的 Toast（用户反馈"通知重复了"）。
// 规则：只要提示条已经说明了当前模式，就不要再弹 Toast。
ok(!/toast\(state\.panMode/.test(js), '拖动模式切换不再弹与提示条重复的 Toast');
ok(!/toast\('已放大并允许拖动/.test(js), '一键按钮不再弹与提示条重复的 Toast');
// 但"状态不明朗"的必要提醒要保留（开了拖动却没放大 -> 拖不动，容易困惑）
ok(/画面未放大，拖动没有可移动的空间/.test(js), '保留"未放大导致拖不动"的必要提醒');
// ---- 11) 界面里不能有 emoji / 渲染不可靠的字形 ----
// 真实踩过：电源面板的「关机」按钮用了 ⏻ (U+23FB)，部分 Android WebView 不渲染它，
// 用户看到的就是"关机图标消失"。
//
// 注意：**不能只用 Extended_Pictographic 判断** —— U+23FB 既不属于
// Extended_Pictographic 也不属于 Emoji_Presentation，会被完全漏掉（这正是它当初溜进来的原因）。
// 所以这里改用"图形符号区段"黑名单，覆盖各种技术符号/杂项符号：
//   U+2000-206F 常用标点   U+2190-21FF 箭头      U+2300-23FF 技术符号（⏻ 在此）
//   U+2460-24FF 带圈字母   U+25A0-25FF 几何图形  U+2600-27BF 杂项符号/装饰
//   U+2B00-2BFF 杂项符号与箭头   U+FE0F 变体选择符
const badGlyphs = /[\u2000-\u206F\u2190-\u21FF\u2300-\u23FF\u2460-\u24FF\u25A0-\u25FF\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u{1F000}-\u{1FAFF}]/u;
// 例外：这些字符要么在 Android 上渲染稳定（已在使用），要么是中文排版标点
const glyphWhitelist = '✕☰↑↓←→×“”‘’…—–·、。！？：；（）《》【】「」';
const uiSources = [
  { name: 'index.html', text: html },
  { name: 'app.js', text: js },
  { name: 'app.css', text: cssNoComments },   // 注释不算
];
const emojiHits = [];
for (const { name, text } of uiSources) {
  text.split('\n').forEach((line, i) => {
    const stripped = [...line].filter((ch) => !glyphWhitelist.includes(ch)).join('');
    const m = stripped.match(new RegExp(badGlyphs, 'gu'));
    if (m) emojiHits.push(`${name}:${i + 1}[${[...new Set(m)].map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase()).join(' ')}]`);
  });
}
ok(emojiHits.length === 0,
  `界面无 emoji / 不可靠字形（违规: ${emojiHits.length ? emojiHits.slice(0, 3).join(', ') : '无'}）`);

console.log(failures === 0 ? '\n手机端 UI 审计通过 ✅' : `\n存在 ${failures} 项问题 ❌`);
process.exit(failures === 0 ? 0 : 1);
