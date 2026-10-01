# 发布说明 / CHANGELOG

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
