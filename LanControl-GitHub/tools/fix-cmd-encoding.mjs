// .cmd/.bat 必须是 CRLF 且不能有 BOM，否则 cmd.exe 会把行拼错、报
// "xxx is not recognized as an internal or external command"。
// 用法: node tools/fix-cmd-encoding.mjs [目录...]
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error('usage: node fix-cmd-encoding.mjs <dir> [dir...]');
  process.exit(2);
}

let fixed = 0, scanned = 0;

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'build') continue;
      walk(p);
      continue;
    }
    const ext = extname(entry.name).toLowerCase();
    if (ext !== '.cmd' && ext !== '.bat') continue;
    scanned++;
    let buf = readFileSync(p);
    const original = Buffer.from(buf);
    // 1) 去 UTF-8 BOM
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      buf = buf.subarray(3);
    }
    // 2) 统一换行为 CRLF
    const text = buf.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
    buf = Buffer.from(text, 'utf8');
    // 3) 提醒：cmd 用 OEM 代码页解析，非 ASCII 会乱码（文件名可以中文，内容不要）
    const nonAscii = [...buf].some((b) => b > 127);
    if (!buf.equals(original)) {
      writeFileSync(p, buf);
      fixed++;
      console.log(`FIXED  ${p}  (${statSync(p).size} bytes, CRLF${nonAscii ? ', 含非 ASCII 内容-建议改英文' : ''})`);
    } else if (nonAscii) {
      console.log(`WARN   ${p}  已符合 CRLF，但内容含非 ASCII，cmd 显示/解析可能异常`);
    }
  }
}

for (const r of roots) walk(r);
console.log(`\n扫描 ${scanned} 个 cmd/bat 文件，修正 ${fixed} 个。`);
