# 局域网远程控制（LanControl）

用手机浏览器或 Android App，在**同一个局域网**内查看并控制电脑。
电脑端是一个单文件绿色程序，需要管理员权限运行；手机端零安装（浏览器）或装一个 25 KB 的 APK。

不需要公网、不需要账号、不经过任何服务器 —— 所有数据只在你的局域网内传输。

---

## 功能

| 分类 | 能力 |
|---|---|
| 画面 | 多显示器切换、分辨率自适应、可选帧率与画质 |
| 输入 | 鼠标、**虚拟鼠标**（手机上当触控板用）、滚轮、键盘按键、中文打字 |
| 声音 | 把电脑正在播放的声音实时传到手机（24 位 / 48 kHz） |
| 文件 | 双向传输，手机 ↔ 电脑 |
| 电源 | 关机 / 重启 / 睡眠 / 锁屏 |
| 连接 | 二维码扫码、6 位配对码、**固定配对码**、手机端「记住此设备」 |
| 系统 | 托盘常驻图标、开机自启、防火墙规则一键放行 |

---

## 快速开始

### 电脑端（被控端）

**方式一：绿色版（推荐）**

1. 双击 `LanControlServer.exe`
2. 首次运行 Windows 会弹出防火墙提示 → 勾选「专用网络」并允许
3. 控制面板会显示一个**二维码**和 **6 位配对码**

**方式二：安装程序**

运行 `LanControl-Setup-2.5.0.exe`（无需管理员权限）。
另有 `LanControl-Setup-2.5.0-admin.exe`，安装时需要管理员权限，但可以自动添加防火墙规则。

### 手机端

**方式一：浏览器（零安装）**

手机连同一个 Wi-Fi，扫电脑上的二维码即可。
或手动输入电脑地址 + 配对码，例如 `192.168.1.100:8848` / `123456`。

**方式二：Android App**

安装 `LanControl-Android.apk`（Android 8.0+）。

---

## 使用说明

### 忘掉配对码

电脑端控制面板点「**固定配对码**」，配对码就会在重启后保持不变。
这样手机端勾选「**记住此设备**」后，下次打开 App 会自动填好并直接连接。

> 固定配对码会降低安全性（码不再变化）。建议只在可信的家庭局域网内使用。

未固定时，每次启动都会随机生成新的配对码。

### 工具栏

连接后底部是工具栏：鼠标 / 虚拟鼠标 / 滚动 / 按键 / 打字 / 文件 / 电源 / 更多 / 全屏 / 收起。

点「收起」后工具栏会隐藏，右下角出现圆钮，点它唤回。
**全屏模式下按手机返回键也能退出全屏。**

### 声音

点顶栏的喇叭图标开启。电脑没在播放声音时，手机端是安静的 —— 这是正常现象，
不是故障（Windows 的回环采集在没有音频流时不会推送数据）。

### 文件

默认共享目录：`%USERPROFILE%\LanControl共享`。

---

## 从源码构建

### 依赖

| 项目 | 版本 | 说明 |
|---|---|---|
| .NET SDK | 8.0 | `net8.0-windows` + WinForms |
| JDK | 17 | 构建 Android 端 |
| Android SDK | compileSdk 34 | 需含 build-tools |
| Gradle | 8.7+ | 命令行 `gradle`，**本仓库不含 wrapper** |
| Inno Setup | 6.x | 仅打包安装程序时需要 |

> **本项目是 Windows 专用**：电脑端依赖 WinForms / GDI+ / WASAPI，
> 构建脚本是 PowerShell（`.ps1` / `.cmd`）。

### 准备工作

1. 安装 .NET 8 SDK、JDK 17、Android SDK、Gradle 8.7
2. 复制 `android-app/local.properties.example` 为 `local.properties`，改成你的 SDK 路径
3. 生成签名密钥库（见下节）

### 构建命令

```powershell
# 电脑端（输出到 .cache\pc-build）
tools\build-pcserver.cmd

# 手机端 APK
tools\build-apk.ps1

# 安装程序（需要 ISCC.exe 在 PATH 中，或改 build-installer.ps1 里的路径）
tools\build-installer.ps1

# 一键全流程
tools\build-all.ps1
```

这些脚本默认从**工作区内的固定路径**找工具链（`tools\jdk17`、`tools\gradle-8.7`、
`tools\android-sdk`）。如果你的环境不同，请修改脚本开头的路径变量。

### 签名密钥库

**仓库里故意不含 `lancontrol.keystore`** —— 签名密钥不应提交到公开仓库。
构建 APK 前请自己生成一个，放在 `android-app/app/lancontrol.keystore`：

```bash
keytool -genkeypair -v \
  -keystore android-app/app/lancontrol.keystore \
  -storetype PKCS12 -alias lancontrol \
  -keyalg RSA -keysize 2048 -validity 10950 \
  -storepass <你的密码> -keypass <你的密码> \
  -dname "CN=你的名字, OU=你的名字, O=你的名字, L=Local, ST=Local, C=CN"
```

然后修改 `android-app/app/build.gradle` 里的 `signingConfigs.release` 填上密码。
（更安全的做法见 `android-app/keystore.properties.example`。）

> ⚠️ **换密钥库会导致新旧 APK 签名不匹配，用户必须先卸载旧版才能安装新版。**
> 正式发布的密钥库请务必备份 —— 丢了就再也无法发布可覆盖升级的新版本。

---

## 技术架构

```
手机                          电脑
┌──────────┐   局域网    ┌──────────────────┐
│ 浏览器 /  │ ─ HTTP ──→ │ 自研轻量 HTTP 服务 │
│ Android  │ ←WebSocket→│  + RFC6455 WS    │
│  WebView │            ├──────────────────┤
└──────────┘            │ GDI+ 屏幕采集      │
                        │ WASAPI 回环采音    │
                        │ SendInput 输入注入 │
                        └──────────────────┘
```

**电脑端**（C# / .NET 8，无第三方依赖）

- `HttpServer.cs` — 基于 `TcpListener` 的极简 HTTP/1.1 服务
- `WebSocketConnection.cs` — 手写 RFC6455 帧编解码
- `ScreenCapture.cs` — GDI+ 截图 + JPEG 编码
- `SystemAudio.cs` — WASAPI 回环采集（手写 COM 互操作，无 NAudio）
- `InputInjector.cs` — `SendInput` / `SetCursorPos` 注入键鼠
- `QrCode.cs` — 手写 QR 编码器（字节模式，纠错等级 M）
- `OldVersionCleaner.cs` — 扫描并清理旧版本残留

**手机端**

- 网页界面（`pc-server/www/`）：原生 JS，零依赖，全部图标为内联 SVG
- Android 壳（`android-app/`）：纯 Java，零第三方库，仅承载 WebView + UDP/TCP 发现

### 通信协议

**画面**：WebSocket 二进制帧 + 14 字节头
```
[0]=版本 [1]=显示器 [2..5]=宽(f32) [6..9]=高(f32) [10..13]=时间戳(f32)
```

**声音**：WebSocket 二进制帧 + 8 字节头
```
[0]=0x41('A') [1]=版本 [2..3]=采样率(u16) [4]=声道 [5]=位深 [6..7]=序号(u16)
```

音频默认 **24 位 / 48 kHz / 单声道**（1152 kbps）。手机端可请求其它码率，服务端自动换算采样率。

---

## 自检工具

仓库自带若干验证脚本，改代码后建议跑一遍：

| 脚本 | 作用 |
|---|---|
| `tools/audit-web.mjs` | 手机端 UI 静态审计（元素、CSS 陷阱、图标按钮） |
| `tools/test-audio.mjs` | 声音链路验证（帧头格式、码率） |
| `tools/test-audio-timing.mjs` | **音频时长校验**：实测字节率与声明采样率对账 |
| `tools/analyze-wav.mjs` | 分析录音波形（削波 / 直流 / 过零率 / 分段 RMS） |
| `tools/apk-cert.mjs` | 从 APK 的 v2 签名块里取出签名证书主体 |
| `tools/test-e2e.mjs` | 端到端连通性 |
| `tools/test-vmouse.mjs` | 虚拟鼠标坐标换算 |
| `tools/test-discovery.mjs` | 局域网发现 |

---

## 常见问题

**搜索不到电脑？**
UDP 广播在部分路由器/企业网会被丢弃。请手动输入控制面板上显示的地址（会记住）。

**手机能连上但没画面？**
确认电脑端防火墙已放行（双击 `放行防火墙_双击即可.cmd`，需要管理员权限）。

**声音是杂音或变调？**
用 `录制声音测试.cmd` 录一段电脑声音并试听：
- 录音正常 → 问题在手机端播放
- 录音也不正常 → 问题在电脑端采集

**托盘图标不显示？**
Windows 默认把它收进隐藏区域。控制面板点「让托盘图标常显」。

**装新版 APK 提示"应用未安装"？**
签名变了。先卸载旧版再装。

---

## 卸载

**绿色版**：双击 `卸载部署.cmd`，然后手动删除文件夹。
**安装版**：设置 → 应用 → 卸载，或从开始菜单卸载。

卸载会自动：结束运行中的被控端、清理自启项、清理托盘注册表、清理配对码记忆。

---

## 安全说明

- 所有通信**仅限局域网**，不上公网、不经过第三方服务器
- 配对码是唯一的鉴权手段，**固定配对码会降低安全性**
- 电脑端以**普通用户权限**运行，注入输入需要与桌面处于同一会话
- 本程序能做到被控端的一切操作（截屏、听声、控制键鼠、传文件、关机），
  **请勿在不可信的网络上开启，也不要随意把地址和配对码给他人**

---

## 许可证

[MIT](LICENSE)

作者：xiaoke
