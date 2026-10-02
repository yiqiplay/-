# 发布说明 / CHANGELOG

## v2.5.1

### 新增功能

- **固定配对码**：电脑端控制面板新增「固定配对码」按钮，配对码在重启后保持不变。
  支持注册表存储，并在注册表不可写时自动回退到程序目录下的 `固定配对码.txt`（记事本即可编辑）。
  命令行：`LanControlServer.exe --pin-code=123456` / `--pin-code=off` / `--pin-code`（查看）
- **手机端「记住此设备」**：连接页新增复选框，勾选后保存地址与配对码，下次自动填入并直连。
  通过 JavaScript 桥 `LanControlApp` 与网页双向同步。
- **手机端显示版本号**：连接页底部显示 `手机端 v2.5.1  Copyright © 2026 xiaoke`。

### 品牌与发布信息

- 电脑端 exe 的**发布者/版权**改为 `xiaoke` / `Copyright (C) 2026 xiaoke`
  （公司、产品、文件版本、产品版本一并补齐，版本资源此前还停留在 1.0.0.0）
- 安装程序 `AppPublisher` / `AppCopyright` / `VersionInfo*` 同步为 `xiaoke`
- **APK 签名证书主体改为 `CN=xiaoke, O=xiaoke, OU=xiaoke`**（此前是 `CN=LanControl`）

> ⚠️ 因签名证书更换，新旧 APK 签名不匹配，**升级必须先卸载旧版**。

### 卸载行为修正

- **卸载时清理自己的注册表**：新增 `--uninstall-clean`，清理
  `HKCU\Control Panel\NotifyIconSettings` 里属于本程序的托盘提升项、
  自启项、`Software\LanControl` 记忆项；安装程序在 `usUninstall` 阶段调用，
  并在 `usPostUninstall` 用 Inno 内建 API 兜底。
- **卸载时检查运行状态**：新增 `--check-running`，卸载前弹窗告知；
  检测同时使用**命名互斥体**与进程枚举 —— 实测存在"进程枚举看不到、但确实在运行"的情况，
  只靠枚举会导致卸载因文件占用而失败。

### 已修复的问题

| 问题 | 根因 | 修复 |
|---|---|---|
| 点「任务管理器」无反应 | 复用 `Run()` 启动，而它强制 `CreateNoWindow` + `WindowStyle.Hidden`，任务管理器被启动成隐藏窗口 | 改用 `LaunchVisible()`（`UseShellExecute=true` + 正常窗口），并保留降级路径 |
| 「关机」图标消失 | 电源面板该按钮仍用 emoji `⏻` (U+23FB)，部分 Android WebView 不渲染 | 换成内联 SVG |
| 固定配对码按钮文字不变 | 文字仅在创建时设置一次，点击后未刷新 | 抽出 `refreshPairBtn()`，每次点击后刷新 |
| 手机端配对码记不住 | 网页回写桥因字符串替换锚点不匹配而**静默未插入**；且用 `apply()` 异步落盘 | 修正插入位置，改用 `commit()` 同步写，并调整 `openControl` 的存读顺序 |

### 自检增强

- `tools/audit-web.mjs` 新增检查：**界面不得含 emoji / 渲染不可靠字形**。
  注意 `U+23FB` 既不属于 `Extended_Pictographic` 也不属于 `Emoji_Presentation`，
  用 Unicode 属性判断会完全漏掉它 —— 改为"图形符号区段黑名单 + 中文标点白名单"。
  同时新增：收起工具条的 CSS 不得依赖 `.immersive`、图标按钮不得被 `textContent` 覆盖。
- 新增 `tools/apk-cert.mjs`：直接解析 APK 的 v2 签名块取出证书主体
  （`keytool -printcert -jarfile` 只认 v1 签名，对现代 APK 看不到任何东西）。

---

## v2.5.0

首个公开版本。

### 功能

- **画面**：GDI+ 采集，JPEG 编码，多显示器切换，可调帧率 / 画质 / 宽度
- **输入**：鼠标、虚拟鼠标、滚轮、键盘按键、中文文本输入
- **声音**：WASAPI 回环采集系统声音，24 位 / 48 kHz / 单声道（1152 kbps）
- **文件**：双向传输
- **电源**：关机 / 重启 / 睡眠 / 锁屏
- **连接**：二维码扫码、6 位配对码、固定配对码、手机端「记住此设备」
- **系统**：托盘常驻、开机自启、防火墙一键放行、旧版本清理

### 已修复的关键问题

| 问题 | 根因 | 修复 |
|---|---|---|
| 声音放慢且变调 | `ConvertToMono` 返回定长复用数组，重采样器误用 `src.Length`(4096) 当输入长度，把旧数据反复重采样，输出正好是应有值的 2 倍 | 显式传入有效样本数 `frames` |
| 降采样有金属味失真 | 48k→8k 直接线性插值，无抗混叠滤波，4 kHz 以上频率折叠回可听频段 | 增加窗化 sinc 低通（Hamming 窗） |
| 非全屏时点「收起」无反应 | CSS 选择器写成 `body.immersive.barhidden #toolbar`，非全屏缺少 `immersive` 类导致规则不匹配 | 改为 `body.barhidden #toolbar` |
| 唤回工具条的圆钮不显示 | HTML 上硬编码 `class="float-bar hidden"`，`.hidden` 的 `!important` 压死了显示规则 | 移除该硬编码类 |
| 浮钮变成无图标空按钮 | `updateFullscreenUi` 用 `textContent` 覆盖了按钮内的 SVG | 改用 CSS 类切换 |
| 无法退出全屏 | 退出分支依赖状态判断，标记不同步时会落进「进入全屏」分支 | 改为幂等硬清场 `exitFullscreenHard()` |
| 部分 Android WebView 图标不显示 | 使用了 emoji | 全部替换为内联 SVG |
| 托盘图标重启后消失 | `WM_TASKBARCREATED` 硬编码为 `0x8001`，实际应为 `RegisterWindowMessage("TaskbarCreated")` | 用 API 动态获取 |
| 托盘图标不显示 | `NotifyIconSettings` 里 `IsPromoted=0` | 启动后自动提升 + 提供手动按钮 |
| 卸载残留注册表 | 托盘提升设置以 exe 路径为键，程序退出时从不清理 | 卸载时调用 `--uninstall-clean` 清理 |
| 卸载不检查运行状态 | 被控端占用文件导致卸载到一半失败 | 新增 `--check-running`，按命名互斥体检测 |
| 固定配对码按钮文字不变 | 按钮文字仅在创建时设置一次，点击后未刷新 | 抽出 `refreshPairBtn()` 每次点击后刷新 |
| 手机端配对码记不住 | 网页回写桥因字符串替换锚点不匹配而静默未插入 | 修正插入位置并改用 `commit()` 同步落盘 |

### 自检工具

随仓库提供：`audit-web.mjs`（UI 静态审计）、`test-audio-timing.mjs`（音频时长校验）、
`analyze-wav.mjs`（波形分析）、`apk-cert.mjs`（APK 签名证书提取）等。
