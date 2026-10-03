// 键盘-服务端一致性自检：把手机端虚拟键盘上的**每个键名**拿去和
// 服务端 /api/keys 列出的支持表核对。
//
// 为什么需要它：手机端曾把 'shiftL' 当键名发给服务端（别名表漏了它），
// 服务端不认这个键名 → 静默丢弃 → 表现是"Shift 键完全无效"，
// 客户端没有任何提示，极难排查。一条自动核对就能当场发现。
//
// 用法: node tools/test-keysync.mjs <host:port> [www目录]
import { readFileSync } from 'node:fs';

const HOST = process.argv[2] || '127.0.0.1:8848';
const WWW = process.argv[3] || 'D:/Deepseekharness/LanControl/PcServer/www';

let failures = 0;
const log = (ok, msg) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + msg); if (!ok) failures++; };

const js = readFileSync(WWW + '/app.js', 'utf8');

// ---- 1) 只从 VK_PAGES 定义里抽键名（不要全文乱抓，否则会抓到无关代码）----
const start = js.indexOf('const VK_PAGES');
const end = js.indexOf('\n];', start);
if (start < 0 || end < 0) { log(false, '在 app.js 里找不到 VK_PAGES 定义'); process.exit(1); }
const pagesSrc = js.slice(start, end);

const keyNames = new Set();
// 匹配形如 ['q', 'q', ''] / ['shiftL', 'Shift', 'k25']
for (const m of pagesSrc.matchAll(/\['([a-zA-Z0-9_]+)',\s*'/g)) keyNames.add(m[1]);
log(keyNames.size > 60, `从 VK_PAGES 提取到 ${keyNames.size} 个键名`);

// ---- 2) 问服务端支持哪些键名 ----
const res = await fetch(`http://${HOST}/api/keys`);
if (!res.ok) { log(false, `GET /api/keys 返回 ${res.status}`); process.exit(1); }
const data = await res.json();
const supported = new Set((data.keys || []).map((k) => String(k).toLowerCase()));
log(supported.size > 50, `服务端映射表里有 ${supported.size} 个键名`);

// ---- 3) 逐个核对 ----
// 服务端 Vk() 的处理顺序：① VkMap 查表 ② 单字符 A-Z/0-9 走 ASCII 码 ③ "0x.." 十六进制
// 手机端键盘上的键名必须落在这三条路径里，否则会被静默丢弃。
//
// 例外：别名键（shiftL/shiftR/alt2/win2/ctrl2）**本来就该**先被 VK_MOD_ALIAS 归一，
// 它们不会原样发给服务端，所以不参与这一步核对（下面第 4 步单独验证）。
const aliasSrc = js.slice(js.indexOf('const VK_MOD_ALIAS'), js.indexOf('\n', js.indexOf('const VK_MOD_ALIAS')));
const isAlias = (k) => aliasSrc.includes(`${k}:`);
const isAsciiFallback = (k) => k.length === 1 && /^[a-zA-Z0-9]$/.test(k);
const isHex = (k) => /^0x[0-9a-fA-F]+$/.test(k);

const unknown = [...keyNames]
  .filter((k) => !isAlias(k) && !supported.has(k.toLowerCase()) && !isAsciiFallback(k) && !isHex(k))
  .sort();

log(unknown.length === 0,
  `键盘上所有非别名键名服务端都能处理${unknown.length ? '（无法处理的: ' + unknown.join(', ') + '）' : ''}`);

// ---- 4) 别名键必须都登记在 VK_MOD_ALIAS 里 ----
// 这就是 shiftL/shiftR 那个坑的针对性检查：
// 一旦别名表漏了某个键，它会被当成普通键发给服务端 → 静默无效。
const needAlias = [...keyNames].filter((k) => /^(shift[LR]|alt\d|win\d|ctrl\d)$/.test(k)).sort();
for (const k of needAlias) {
  log(isAlias(k), `${k} 已在 VK_MOD_ALIAS 里归一（否则会被当成普通键发出去、静默无效）`);
}
if (needAlias.length === 0) log(true, '键盘上没有需要归一的别名键（不必检查）');

// ---- 5) 反查：服务端还有哪些键名没被键盘用上（提示，不算失败）----
const used = new Set([...keyNames].map((k) => k.toLowerCase()));
const unused = [...supported].filter((k) => !used.has(k)).sort();
console.log(`\n提示：服务端还有 ${unused.length} 个键名未出现在键盘上（同义词，不算错误）`);
console.log('  ' + unused.join(', '));

console.log('');
console.log(failures === 0 ? '键盘与服务端键名一致 ✅' : `存在 ${failures} 项问题 ❌`);
process.exit(failures === 0 ? 0 : 1);
