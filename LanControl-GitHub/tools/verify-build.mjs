// 构建产物自检：确认发布包里的可执行文件**真的能提供最新界面**。
//
// 为什么必须要有它：www 是通过 <EmbeddedResource Include="www\**\*" /> 打进 dll 的。
// 只改磁盘上的 www 而不同步重建 dll，发布包里的界面就还是旧的 ——
// 而我在沙箱里测的是刚构建的 .cache\pc-build，两边不一致，于是出现
// "改了、我这边测试通过、用户那边毫无变化"。这个坑真实发生过（提示条没生效）。
//
// 用法: node tools/verify-build.mjs <发布目录> [期望包含的标记...]
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.argv[2] || 'D:/Deepseekharness/LanControl-2.5.2';

let failures = 0;
const log = (ok, msg) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + msg); if (!ok) failures++; };

// 必须出现在 dll 嵌入资源里的界面标记。
// 每加一个用户可见的界面元素，就往这里补一条 —— 这是"发布包真的更新了"的证据。
const MARKS = [
  ['vkbdTip', '虚拟键盘提示条'],
  ['vkbdTipGo', '一键放大并允许拖动按钮'],
  ['拖动画面需先点', '提示条文案'],
  ['vkbdArmed', '已预备状态显示'],
  ['vkbdZoom', '放大画面按钮'],
  ['vkbdPan', '拖动画面按钮'],
  ['refreshKbTip', '提示条刷新逻辑'],
  ['vkPaintState', '修饰键高亮刷新'],
  ['state.stageW', '拖动范围尺寸变量'],
  ['customPanel', '触屏按键面板'],
  ['btnOpenCustom', '更多设置里的触屏按键入口'],
  ['LanControlCustomKeys', '触屏按键逻辑'],
  ['syncKbButtons', '键盘按钮统一同步'],
];

const dll = join(DIR, 'LanControlServer.dll');
if (!existsSync(dll)) {
  log(false, `找不到 ${dll}`);
  process.exit(1);
}
log(true, `检查 ${dll}`);

const buf = readFileSync(dll);
// 嵌入的文本资源在 dll 里以 UTF-8 存放，直接按 UTF-8 解码后查找即可
const text = buf.toString('utf8');

console.log('\n--- dll 内嵌 www 的界面标记 ---');
for (const [mark, desc] of MARKS) {
  log(text.includes(mark), `${desc}（${mark}）已打进 dll`);
}

// 发布包里不该有独立的 www 目录（会覆盖嵌入资源、造成两边不一致）
console.log('\n--- 目录结构 ---');
const wwwDir = join(DIR, 'www');
if (existsSync(wwwDir)) {
  console.log('  注意：存在磁盘 www 目录，它会优先于嵌入资源被使用。');
  const idx = join(wwwDir, 'index.html');
  if (existsSync(idx)) {
    const html = readFileSync(idx, 'utf8');
    log(html.includes('vkbdTip'), '磁盘 www/index.html 也含提示条（否则会盖掉新界面）');
  }
} else {
  log(true, '没有磁盘 www 目录（统一使用 dll 内嵌资源，不会出现两边不一致）');
}

// exe / dll 时间应一致
console.log('\n--- 文件时间 ---');
const exe = join(DIR, 'LanControlServer.exe');
if (existsSync(exe)) {
  const a = statSync(exe).mtimeMs, b = statSync(dll).mtimeMs;
  log(Math.abs(a - b) < 60_000, `exe 与 dll 构建时间接近（差 ${Math.round(Math.abs(a - b) / 1000)} 秒）`);
}

// releases 目录里的副本也要同步
const relDll = join(DIR, '..', 'LanControl-GitHub', 'releases', 'LanControlServer.dll');
if (existsSync(relDll)) {
  const rtext = readFileSync(relDll).toString('utf8');
  log(rtext.includes('vkbdTip'), 'GitHub releases 里的 dll 也已同步');
}

console.log('');
console.log(failures === 0 ? '构建产物自检通过 ✅' : `存在 ${failures} 项问题 ❌`);
process.exit(failures === 0 ? 0 : 1);
