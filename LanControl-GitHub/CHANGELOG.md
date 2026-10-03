# 发布说明 / CHANGELOG

## v2.5.2

### 虚拟键盘

- **新增虚拟键盘**：工具条「键盘」按钮，分「常用 / 功能」两页。
  布局**逐排对照实物键盘照片**核对，各排键数与真实键盘一致：

  ```
  常用页：F1 … F12
          ` 1 2 3 4 5 6 7 8 9 0 - = 退格
          Tab Q W E R T Y U I O P [ ] \
          Caps A S D F G H J K L ; ' 回车
          Shift Z X C V B N M , . / Shift
          Ctrl Win Alt 空格 Alt Win 菜单 Ctrl

  功能页：Esc Del Ins 方向键 / PrtSc ScrLk Pause / Home End PgUp PgDn / 音量 / 媒体
  ```

  - 修饰键在**最下一排**（真实键盘就是这样）。
    早期自造了一整行 Ctrl/Shift/Alt/Win，属于**重复按键**，已删除。
  - **粘滞修饰键**：单击 Ctrl 预备组合，再点 C 即发 Ctrl+C 并自动松开；
    **双击或长按修饰键 = 单独发送该键**（Win 键单独按可弹出开始菜单）。
    左右两侧的 Alt/Win/Ctrl 共用同一份状态（现实中它们本就是同一个键）。
  - **Caps 大写锁定**：点击后本地记录状态，按钮高亮、字母显示大写
  - **长按字母/数字连续输出**：首字立即发出，450ms 后连发，间隔 110ms 逐渐加快到 45ms
  - **滑动防误触**：指部位移超过 8px 判定为滑动，不触发按键
  - **拖动画面查看被遮挡部分**：键盘打开时**单指拖动画面**，上下左右都可拖。
    这里有个关键点：原来画面是按「整幅塞进舞台」缩放的，`maxPan` 恒为 0
    —— **不是手势没生效，而是根本没有可移动的空间**。现在键盘打开时按
    「希望上下各能拖 34vh」反推缩放比例把画面放大，才真正拖得动。
- 键宽按真实键盘比例（Caps 1.4 / Shift 1.8 / 回车 1.9 / Tab 1.5），
  按键用 flex 份数撑满整行，不留空白也不会被压没

### 界面与交互

- **面板高度可拖动**：所有面板（键盘/按键/打字/文件/电源）顶部有拖动把手，
  高度记入 localStorage，不同机型都能自己调到合适高度
- **虚拟键盘提示条**：打开键盘后明确提示「拖动画面需先点『放大画面』，再点『拖动画面』」，
  并提供「**一键放大并允许拖动**」按钮（省去自己摸索两步）；
  提示文字随状态变化，拖动中/未放大时各给出对应的下一步说明
- **键盘打开时隐藏下方工具栏**，避免面板与工具栏叠在一起
- 工具条按钮的"已启用"状态加上**背景色高亮**（原来只改字色，两者都是灰蓝，看不出来）
- 顶栏图标按钮补齐 `.icon-btn.on` 激活态
- 抽屉正文与文件列表补 `min-height: 0`（flex 子项默认 `min-height:auto` 会导致
  **滚不动**且底部留白）

### 清理

- 删除两份**无人引用**的重复图标 `app.png`（`pc-server/` 与 `installer/` 各一份）。
  `app.ico` 的两份**必须保留**：一份编译进 exe 资源，一份给安装程序用
  （路径相对 `.iss` 文件，不能合并）。

### 重要：www 是嵌入资源，必须重建 dll 才会生效

`www\**\*` 通过 `<EmbeddedResource>` 打进 dll，运行时**先找磁盘 www、再回退嵌入资源**。
所以只改磁盘上的 `www` 而不同步重建 dll，发布包里的界面还是旧的 —— 而开发时若测的是
刚构建的 `.cache\pc-build`，两边不一致，就会出现"改了、这边测试通过、用户那边毫无变化"。

**这个坑真实发生过**：虚拟键盘提示条加好后，发布包里的 dll 仍是旧 www，
用户完全看不到提示。

对策：新增 `tools/verify-build.mjs`，直接**在 dll 二进制里查找界面标记字符串**，
确认发布包真的带上了最新界面，并检查 `releases` 目录副本是否同步。
它第一次运行就抓出了「GitHub releases 里的 dll 是旧的」这个不一致。

```
node tools/verify-build.mjs LanControl-2.5.2
```

### 卸载清理：不再留下自己的注册表

卸载时**必须清干净的注册表项**：

**实测发现的残留**（用户用 Geek Uninstaller 扫描到 6 项）：

```
HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{8F3A1C2E-...}_is1
  DisplayName     = 局域网远程控制 被控端
  InstallLocation = D:\yuanchenlianjei\LanControl\      <- 目录已删除
```

这是 Inno Setup 写的**卸载记录**。`--uninstall-clean` 之前完全没碰它，
只依赖卸载程序在最后一步自己删 —— 而卸载程序一旦没跑到最后（被杀毒软件锁文件、
用户手动删目录、卸载中断），记录就留下来了。

**对策（三层）**：

1. `--uninstall-clean` 里显式调用 `CleanUninstallRecords()`：
   先按**已知 AppId 精确匹配**（最可靠，不管显示名被改成什么、安装目录换过几次），
   再按 `DisplayName` / `UninstallString` / `InstallLocation` 兜底匹配
2. 安装器 `[Code]` 里也显式 `RegDeleteKeyIncludingSubkeys` 删这两个路径
3. 新增 `--cleanup-traces` 开关与 `清理残留.cmd`（纯 `reg delete`，不依赖程序还在），
   用于"已经卸载完、只想清掉残留"的场景，可重复运行

| 位置 | 用途 | 之前 | 现在 |
|---|---|---|---|
| `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\LanControlServer` | 开机自启 | 只有安装器 `[Code]` 兜底清；程序被手动删掉时清不到 | `--uninstall-clean` 里也调用 `RemoveAutoStart()` |
| `HKCU\Control Panel\NotifyIconSettings\<hash>` | 托盘图标是否固定 | **只删 `IsPromoted` 值，留下整个子键空壳** | 先清值再 `DeleteSubKeyTree` 删掉整个子键 |
| `HKCU\Software\LanControl` | 记住的端口 / 固定配对码 | 已清 | 保持 |
| 防火墙规则（管理员版） | 入站放行 | 已清 | 保持 |

安装器侧也补了 `RemoveNotifyIconSettings()`（按 `ExecutablePath` 匹配后整键删除），
覆盖"程序已被手动删掉、`--uninstall-clean` 跑不了"的情况。

> 注意：`HKCU\Control Panel\NotifyIconSettings` 是 Windows 管理通知区图标的公共位置，
> 所以只删**属于本程序**的条目（按 `ExecutablePath` 判断），绝不整棵树删掉。

### 新增：按键演练模式（避免干扰正在用电脑的人）

自动化测试如果真注入按键，会**直接干扰正在使用这台电脑的人** ——
实测中发送 `Win` 会弹出开始菜单、发送 `CapsLock` 会切换大小写，
用户反馈"改动对我的现实按键产生了临时性改变"。

新增 `--keys-dryrun`：按键只记录、**不调用 SendInput**：

```
LanControlServer.exe --port 8845 --code 111111 --keys-dryrun
```

`InputInjector.DryRunLog` 保留最近 500 条记录供核对。

### 已修复的问题

| 问题 | 根因 | 修复 |
|---|---|---|
| 非全屏时点「收起」无反应 | CSS 选择器写成 `body.immersive.barhidden #toolbar`，非全屏缺少 `immersive` 类导致规则不匹配 | 改为 `body.barhidden #toolbar` |
| 唤回工具条的圆钮不显示 | HTML 上硬编码 `class="float-bar hidden"`，`.hidden` 的 `!important` 压死了显示规则 | 移除该硬编码类 |
| 浮钮变成无图标空按钮 | `updateFullscreenUi` 用 `textContent` 覆盖了按钮内的 SVG | 改用 CSS 类切换 |
| 无法退出全屏 | 退出分支依赖状态判断，标记不同步时会落进「进入全屏」分支 | 改为幂等硬清场 `exitFullscreenHard()` |
| 「关机」图标消失 | 电源面板该按钮仍用 emoji `⏻` (U+23FB)，部分 WebView 不渲染 | 换成内联 SVG |
| 点「任务管理器」无反应 | 复用 `Run()` 启动，而它强制 `CreateNoWindow` + `WindowStyle.Hidden`，任务管理器被启动成隐藏窗口 | 改用 `LaunchVisible()`（`UseShellExecute=true` + 正常窗口） |
| 键盘占满整屏 | `max-height: min(400px, 58vh)` —— 老 WebView 不认 `min()`，会**整条丢弃声明**（不是回退），高度限制完全失效 | 只用最基础的 `vh`；审计禁止 `min/max/clamp/dvh` |
| 左右 Shift 键消失 | 键用 `width:30px` + `flex-shrink:1`，窄屏被压成 0 宽 | 改固定宽度，再改 flex 份数 + `flex-shrink:0` |
| 键盘两边留空 | 键用固定像素宽度，屏幕更宽时两边各空一块 | 按份数 `flex-grow` 撑满整行 |
| 虚拟鼠标图标不更新 | `setVmouseEnabled` 只刷新工具条、点顶栏时又只刷新顶栏，两处状态不同步 | 图标刷新统一收进 `setVmouseEnabled` |
| **Shift 键完全无效** | 别名表漏了 `shiftL`/`shiftR`，两个 Shift 掉进普通键分支，发出的 `'shiftL'` 服务端不认、静默丢弃 | 别名表补上 `shiftL/shiftR → shift`，并抽出 `vkModOf()` 统一归一 |
| Ctrl/Shift 点击不高亮 | `vkPaintState` 同样认不出别名键 | 改用 `vkModOf()` 判断 |
| 键盘打开后画面被放大且无法缩放 | 我为"让拖动有意义"在键盘打开时**自动放大画面** —— 属于擅自改变用户看到的画面尺寸 | 撤销自动缩放；缩放只由用户双指手势决定 |
| 键盘图标点击后不更新 | 底排 Ctrl/Win/Alt 走普通键分支，`paintMods` 只扫 `#vkbdMods` 认不出它们 | 新增 `vkPaintState()` 按 `data-key` 统一刷新 |
| 连携键高亮反复无效 | 只用 CSS class 上色；任何优先级/缓存问题都会让它静默失效，且从代码上完全看不出毛病 | 改为 **class + 内联样式**双重设置（内联优先级最高），一次排除"样式没生效"这一整类原因 |
| 连携键高亮（根因）| `vkModTap` 只调了 `paintMods()`（它只扫 `#vkbdMods`），而修饰键在底排 `#vkbdBody` 里 —— 状态写进去了、界面毫无变化。为此改了四轮颜色都没用，因为**根本不是颜色问题** | `vkModTap` 里补上 `vkPaintState()` 与 `vkPaintArmed()`；新增 `tools/test-vkbd-logic.mjs` **在 Node 里真的执行一遍点击流程**来验证 |
| 连携键高亮（辅助）| 只靠颜色无法判断"到底有没有被记住" | 键盘标题栏新增「**已预备 Ctrl + Shift**」文字状态 |
| **左右拖动完全没反应** | `state.stageW` / `state.imgW` **从未被赋值**（一次字符串替换没匹配上、静默失败），导致 `panMaxX()` 恒返回 0 | 补上赋值；新增审计项强制校验四个尺寸变量都存在赋值 |
| 取消拖动后画面弹回中央 | 关闭拖动模式时我主动把 `pan` 归零；收起键盘、点放大/还原时也各有一处复位 | 全部去掉，拖到哪里就停在哪里（仅在舞台尺寸变化时自动钳制回可见范围） |
| 虚拟鼠标在键盘打开时失效 | 拖画面手势一进 `touchstart` 就 `stopImmediatePropagation()`，把鼠标手势整个屏蔽了 | 加 `panMode` **显式开关**（默认关闭）：默认拖动=移动鼠标；点「拖动画面」后才拖动=移动画面 |
| 左右滑动画面不生效 | 同上 —— 被拖画面手势的拦截逻辑挡住；且"按落点区分黑色留白"在放大后不成立（画面铺满舞台，没有留白） | 同上，改为显式开关控制，不再依赖落点判定 |
| 放大后拖不到底 | 边界仍按"居中、各移一半"钳制，画面底边永远差一截 | 放大后允许拖满**整个**溢出量，底边能真正拖到屏幕上 |
| 键盘打开后拖不动画面 | 上一版撤销自动放大后，画面又变回"完整塞进舞台"，`maxPan` 恒为 0 —— 不是手势问题，是没有可移动空间 | 新增键盘面板头部的「**放大画面**」按钮（**默认关闭**）：放大 2.4 倍后 `maxPan` 从 0 变成 ~124px，拖动才真正有效 |
| 全屏图标不更新 | `openPanel()` 无条件重写**所有**工具条按钮的 `.active`，把模式类按钮的高亮一起抹掉 | 引入 `PANEL_ACTS`，只更新面板类按钮 |
| 滑动时误触按键 | 键盘上滑动时按下落点的键会被当成点击发送 | `vkScroll` 位移判定 + 连发循环内二次校验 |
| 抽屉里滑动会操纵电脑 | `#drawer` 在 `#stage` 的 DOM 子树内，事件冒泡被当成画面操作 | `touchstart` 里用 `closest()` 排除抽屉/面板/顶栏/工具条 |
| 抽屉/文件界面底部留空、滚不动 | `.drawer-body` / `.file-list` 缺 `min-height:0`；`.drawer` 又被压了 `max-height:90vh` | 补 `min-height:0`，移除多余的 `max-height` |
| 固定配对码按钮文字不变 | 文字仅在创建时设置一次，点击后未刷新 | 抽出 `refreshPairBtn()` 每次点击后刷新 |
| 手机端配对码记不住 | 网页回写桥因字符串替换锚点不匹配而**静默未插入**；且用 `apply()` 异步落盘 | 修正插入位置，改用 `commit()` 同步写 |

### 自检增强

新增只读接口 `GET /api/keys`：列出服务端支持的全部键名，供自检脚本核对。

`tools/audit-web.mjs` 现有检查项（持续增加，每次踩坑都会补一条）：

- 界面不得含 emoji / 渲染不可靠字形
  （注意 `U+23FB` 既不属于 `Extended_Pictographic` 也不属于 `Emoji_Presentation`，
  用 Unicode 属性判断会完全漏掉它 —— 改用"图形符号区段黑名单 + 中文标点白名单"）
- CSS 禁用 `min()` / `max()` / `clamp()` / `dvh`（老 WebView 会整条丢弃声明）
- 键盘按键不得写死像素宽度
- 可滚动区域必须有 `min-height: 0`
- 图标按钮不得被 `textContent`/`innerHTML` 覆盖
- 收起工具条的规则不得依赖 `.immersive`
- 虚拟鼠标图标两处必须同步刷新
- 模式类按钮不得被 `openPanel` 清掉高亮

新增工具：`tools/test-pan.mjs`（**抽出拖画面手势代码在 Node 里模拟 touchstart/touchmove**，验证 panX/panY 是否真的写入与应用）、`tools/test-vkbd-logic.mjs`（**把虚拟键盘代码抽出来在 Node 里真的跑一遍点击流程** —— 高亮那个坑就靠它定位）、`tools/test-keysync.mjs`（**键盘键名与服务端映射表逐一核对** —— Shift 无效那个坑的针对性检查）、`tools/test-vkbd.mjs`（虚拟键盘链路，37 组按键）、
`tools/apk-cert.mjs`（解析 APK v2 签名块取证书主体）、
`tools/bump-version.ps1`（一键同步所有版本号位置并回读校验）。

---

### 其它内容

- **虚拟键盘**：工具条新增「键盘」按钮，提供完整键盘布局
  （Esc / F1-F12 / 数字行 / QWERTY / 符号 / 方向键 / Home / End / Del / 空格）。
  - **粘滞修饰键**：点 `Ctrl` 后再点 `C` 即发出 **Ctrl+C**，发完自动松开修饰键
    （不自动松开的话，下一次点击会再次带上修饰键，极易误操作）。
  - **Shift 联动显示**：按下 Shift 后字母显示大写、符号显示 Shift 后的字符
    （`1`→`!`、`,`→`<`），所见即所得。
  - 与原有「按键」面板（常用按键网格）和「打字」（中文输入）**并存，互不影响**。
- 新增 `tools/bump-version.ps1`、`tools/test-vkbd.mjs`。

### 版本号管理

版本号散落在 5 个文件里，历史上漏改过多次，出现过
「exe 的 FileVersion 是 2.5.1.0 但 ProductVersion 还是 2.5.0」、
「安装程序 VersionInfo 停在 1.0.0.0」这类不一致。

现在统一由 `tools/bump-version.ps1` 处理，改完逐项回读校验，任何一处没改上都会报错退出：

```
tools\bump-version.ps1 2.5.3
```

---

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

新增只读接口 `GET /api/keys`：列出服务端支持的全部键名，供自检脚本核对。

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
