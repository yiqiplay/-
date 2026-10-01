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

console.log(failures === 0 ? '\n手机端 UI 审计通过 ✅' : `\n存在 ${failures} 项问题 ❌`);
process.exit(failures === 0 ? 0 : 1);
