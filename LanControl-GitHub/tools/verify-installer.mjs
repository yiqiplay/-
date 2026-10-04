// 安装程序自检：语言已是中文、装完能启动、注册表清理齐全。
//
// 为什么单独做：安装器的问题（界面英文、装完不启动、卸载留残留）
// 在 Web 审计里查不到，而这几类问题反复出现过。
//
// 用法: node tools/verify-installer.mjs [Installer 目录]
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.argv[2] || 'D:/Deepseekharness/LanControl/Installer';
const REPO = 'D:/Deepseekharness/LanControl-GitHub/installer';

let failures = 0;
const log = (ok, msg) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + msg); if (!ok) failures++; };

const files = ['LanControl.iss', 'LanControl-admin.iss'];
for (const name of files) {
  const p = join(DIR, name);
  if (!existsSync(p)) { log(false, `找不到 ${name}`); continue; }
  const s = readFileSync(p, 'utf8');
  console.log(`\n--- ${name} ---`);

  // 1) 必须用完整的简体中文语言文件（内置 Default.isl 是英文，只覆写几条会剩大量英文）
  log(/MessagesFile:\s*"compiler:Languages\\ChineseSimplified\.isl"/.test(s),
    '使用完整简体中文语言文件（不是英文的 Default.isl）');
  log(!/MessagesFile:\s*"compiler:Default\.isl"/.test(s), '没有退回英文的 Default.isl');

  // 2) 装完必须能启动
  log(/\{cm:LaunchApp\}/.test(s), '安装完成页有「立即启动被控端」勾选项');
  // 注意 \r：.iss 是 CRLF 行尾，$ 匹配不到行尾
  const runLine = ((s.match(/^Filename: "\{app\}.*ServerExe.*$/m) || [''])[0]).replace(/\r/g, '');
  log(/postinstall/.test(runLine), '启动项带 postinstall（才会出现在完成页）');
  log(/skipifsilent/.test(runLine), '静默安装时不弹窗');
  // 历史踩坑：带 --silent 拉起会让向导卡在最后阶段
  log(!/--silent/.test(runLine), '启动项不带 --silent（带过会卡住向导）');

  // 完成页应有且只有 2 个勾选项：立即启动（默认勾）+ 查看使用说明（默认不勾）
  log(!/Flags:[^\r\n]*isreadme/.test(s), '没有 isreadme 标记（它会额外生成一个说明勾选项，导致重复）');
  const runEntries = s.split(/\r?\n/).filter((l) => l.startsWith('Filename:') && /postinstall/.test(l));
  log(runEntries.length === 2, `完成页有 2 个勾选项（实际 ${runEntries.length} 个）`);
  const launch = runEntries.find((l) => /\{cm:LaunchApp\}/.test(l)) || '';
  const readme = runEntries.find((l) => /使用说明\.txt/.test(l)) || '';
  log(!!launch, '有「立即启动被控端」勾选项');
  log(!!readme, '有「查看使用说明」勾选项');
  log(!!launch && !/unchecked/.test(launch), '「立即启动」默认勾选');
  log(!!readme && /unchecked/.test(readme), '「查看使用说明」默认不勾选（不打扰）');

  // 3) 卸载必须清干净
  log(/uninstall-clean/.test(s), '卸载时调用 --uninstall-clean');
  log(/Uninstall\\\{8F3A1C2E/.test(s), '卸载时删除自己的卸载记录（否则装完还有残留）');
  log(/Software\\LanControl/.test(s), '卸载时清 Software\\LanControl');
  log(/RegDeleteValue\([^)]*Run[^)]*LanControlServer/.test(s), '卸载时清开机自启项');
  log(/RemoveNotifyIconSettings/.test(s), '卸载时清托盘图标设置');
}

console.log('\n--- 语言文件 ---');
const isl = 'D:/Deepseekharness/tools/innosetup/Languages/ChineseSimplified.isl';
if (existsSync(isl)) {
  const b = readFileSync(isl);
  log(b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF, '语言文件带 UTF-8 BOM（Inno 6 要求）');
  const t = b.toString('utf8');
  log(/LanguageName=简体中文/.test(t), '语言名是简体中文');
  const n = (t.match(/^[A-Za-z][A-Za-z0-9]*=/gm) || []).length;
  log(n > 200, `翻译了 ${n} 条消息`);
  log(/RunEntryExec=运行 %1/.test(t), '「运行 xxx」这类完成页条目前缀也是中文');
} else {
  log(false, '找不到 ChineseSimplified.isl');
}

console.log('');
console.log(failures === 0 ? '安装程序自检通过 ✅' : `存在 ${failures} 项问题 ❌`);
process.exit(failures === 0 ? 0 : 1);
