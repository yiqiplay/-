#define AdminMode
; 局域网远程控制 · 被控端安装程序
; 使用工作区内的 Inno Setup 6.7.3 编译：tools\innosetup\ISCC.exe
; 两种模式：
;   默认（无参数）  = 按当前用户安装，无需管理员权限、无 UAC 提示
;   /DAdminMode     = 管理员模式，可自动添加防火墙规则、自定义监听端口

#define AppName "局域网远程控制"
#define AppVersion "2.5.0"
#define AppPublisher "xiaoke"
#define AppCopyright "Copyright (C) 2026 xiaoke"
#define ServerExe "LanControlServer.exe"

[Setup]
AppId={{8F3A1C2E-5B7D-4A6F-9C21-7E4D5A8B1F30}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\LanControl
AppCopyright={#AppCopyright}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
UninstallDisplayName={#AppName} 被控端
UninstallDisplayIcon={app}\{#ServerExe}
OutputDir=D:\Deepseekharness\dist\optional
#ifdef AdminMode
OutputBaseFilename=LanControl-Setup-2.5.0-admin
#else
OutputBaseFilename=LanControl-Setup-2.5.0
#endif
SetupIconFile=app.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
#ifdef AdminMode
; 管理员模式：可自动添加防火墙规则、自定义监听端口（安装时会出现 UAC 授权提示）
PrivilegesRequired=admin
#else
; 默认模式：按当前用户安装，全程无需管理员权限；首次运行被控端时由 Windows 弹出
; 防火墙授权提示，勾选“专用网络”并允许即可（端口固定为默认的 8848）
PrivilegesRequired=lowest
DefaultDirName={localappdata}\LanControl
#endif
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
; 版本资源：之前写死 1.0.0.0，与应用版本 2.5.0 不一致，安装包属性里显示错误的版本号
VersionInfoVersion=2.5.0.0
VersionInfoDescription=局域网远程控制 被控端 安装程序
VersionInfoProductName={#AppName}
VersionInfoCompany={#AppPublisher}
VersionInfoCopyright={#AppCopyright}

[Languages]
; 使用内置 Default.isl，并在下面覆写为简体中文文案
Name: "cn"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
cn.PortPageTitle=网络设置
cn.PortPageSubtitle=设置被控端监听端口
cn.PortPageText=手机将通过这个端口连接本机。若该端口已被其他程序占用，请改成 1024-65535 之间的其他端口。
cn.PortLabel=监听端口：
cn.PortInvalid=请输入 1024 到 65535 之间的端口号。
cn.TaskDesktop=创建桌面快捷方式
cn.TaskStartup=开机自动启动被控端（推荐）
cn.TaskFirewall=添加 Windows 防火墙放行规则（允许局域网手机连接）
cn.TaskApk=复制手机安装包（APK）到桌面
cn.LaunchApp=立即启动被控端
cn.MsgNeedDotNet=.NET 8 桌面运行时未安装，被控端需要它才能运行。%n%n请先安装：https://dotnet.microsoft.com/download/dotnet/8.0/runtime （选择“Desktop Runtime x64”）%n%n安装完成后再次运行本程序即可。
cn.FinishedLabelNoDotNet=提示：当前电脑缺少 .NET 8 桌面运行时，被控端暂时无法运行。

; 界面文案本地化（内置 Default.isl 为英文，这里覆写常用项）
[Messages]
cn.WelcomeLabel1=欢迎安装 [name]
cn.WelcomeLabel2=现在将安装 [name] [ver] 到你的电脑。%n%n被控端会在任务栏托盘常驻运行，手机在同一局域网内即可看屏并操作这台电脑。%n%n首次运行请在弹出的 Windows 防火墙提示中勾选“专用网络”并允许访问。%n%n点击“下一步”继续，或点击“取消”退出安装。
cn.ButtonNext=下一步(&N) >
cn.ButtonBack=< 上一步(&B)
cn.ButtonInstall=安装(&I)
cn.ButtonCancel=取消
cn.ButtonFinish=完成(&F)
cn.ButtonYes=是(&Y)
cn.ButtonNo=否(&N)
cn.ButtonOK=确定
cn.SelectDirLabel3=安装程序将把 [name] 安装到下面的文件夹。若需安装到其他文件夹，点击“浏览”。
cn.SelectDirBrowseLabel=点击“下一步”继续；若想选择其他文件夹，点击“浏览”。
cn.ReadyLabel1=安装程序已准备好，即将开始安装 [name]。
cn.ReadyLabel2=点击“安装”开始安装，或点击“上一步”检查并修改设置。
cn.InstallingLabel=正在安装 [name]，请稍候…
cn.FinishedHeadingLabel=正在完成 [name] 安装向导
cn.FinishedLabel=安装已完成。若勾选了“立即启动被控端”，程序会自动启动并在任务栏托盘显示图标；双击托盘图标即可看到访问地址和配对码。
cn.ConfirmUninstall=确定要完全卸载 %1 及其组件吗？
cn.UninstalledAll=%1 已成功卸载。
cn.SetupAppTitle=安装 - [name]
cn.UninstallAppTitle=卸载 - [name]

[Tasks]
Name: "desktopicon"; Description: "{cm:TaskDesktop}"; GroupDescription: "附加任务："
Name: "startup"; Description: "{cm:TaskStartup}"; GroupDescription: "附加任务："
#ifdef AdminMode
Name: "firewall"; Description: "{cm:TaskFirewall}"; GroupDescription: "附加任务："
#endif
Name: "apk"; Description: "{cm:TaskApk}"; GroupDescription: "附加任务："

[Files]
Source: "..\..\dist\*"; DestDir: "{app}"; Excludes: "LanControl-Setup-*.exe,optional\,_setup_temp\"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\..\dist\LanControl-Android.apk"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "..\..\dist\LanControl-Android.apk"; DestDir: "{userdesktop}"; DestName: "远程控制手机端.apk"; Flags: ignoreversion skipifsourcedoesntexist uninsneveruninstall; Tasks: apk
Source: "..\..\dist\使用说明.txt"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist isreadme

[Icons]
Name: "{group}\{#AppName} 控制面板"; Filename: "{app}\{#ServerExe}"; WorkingDir: "{app}"; Comment: "查看连接地址与配对码"
Name: "{group}\使用说明"; Filename: "{app}\使用说明.txt"
Name: "{group}\卸载 {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#ServerExe}"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\LanControl"; ValueType: string; ValueName: "Port"; ValueData: "{code:GetPort}"; Flags: uninsdeletekey; Check: IsCustomPort
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "LanControlServer"; ValueData: """{app}\{#ServerExe}"""; Flags: uninsdeletevalue; Tasks: startup

[Run]
; 注意：这里**故意不自动启动被控端**。
; 之前的写法（nowait postinstall）会在最后一步拉起程序，实测在部分机器上
; 会让向导停在最后阶段不返回（安装其实已经完成，但窗口卡住）。
; 改为安装完由用户从桌面/开始菜单快捷方式启动，最稳。
Filename: "{app}\使用说明.txt"; Description: "查看使用说明"; Flags: shellexec nowait postinstall skipifsilent unchecked

#ifdef AdminMode
[UninstallRun]
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""LanControl Server TCP"""; Flags: runhidden; RunOnceId: "DelFwTcp"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""LanControl Server UDP"""; Flags: runhidden; RunOnceId: "DelFwUdp"
#endif

[UninstallDelete]
Type: filesandordirs; Name: "{app}\logs"

[Code]
var
  PortPage: TInputQueryWizardPage;

function GetPort(Param: String): String;
begin
  if (PortPage <> nil) and (PortPage.Values[0] <> '') then
    Result := PortPage.Values[0]
  else
    Result := '8848';
end;

procedure InitializeWizard();
begin
#ifdef AdminMode
  PortPage := CreateInputQueryPage(wpSelectTasks,
    ExpandConstant('{cm:PortPageTitle}'),
    ExpandConstant('{cm:PortPageSubtitle}'),
    ExpandConstant('{cm:PortPageText}'));
  PortPage.Add(ExpandConstant('{cm:PortLabel}'), False);
  PortPage.Values[0] := '8848';
#else
  PortPage := nil;
#endif
end;

function IsCustomPort(): Boolean;
begin
  Result := GetPort('') <> '8848';
end;

function HasRuntimeUnder(Root: String): Boolean;
var
  FindRec: TFindRec;
begin
  Result := False;
  if FindFirst(Root + '\8.*', FindRec) then
  begin
    Result := True;
    FindClose(FindRec);
  end;
end;

function IsDotNetDesktopInstalled(): Boolean;
begin
  Result := HasRuntimeUnder(ExpandConstant('{commonpf}\dotnet\shared\Microsoft.WindowsDesktop.App'))
         or HasRuntimeUnder(ExpandConstant('{commonpf32}\dotnet\shared\Microsoft.WindowsDesktop.App'))
         or HasRuntimeUnder(ExpandConstant('{localappdata}\Microsoft\dotnet\shared\Microsoft.WindowsDesktop.App'));
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  P: Integer;
begin
  Result := True;
#ifdef AdminMode
  if (PortPage <> nil) and (CurPageID = PortPage.ID) then
  begin
    P := StrToIntDef(PortPage.Values[0], 0);
    if (P < 1024) or (P > 65535) then
    begin
      MsgBox(ExpandConstant('{cm:PortInvalid}'), mbError, MB_OK);
      Result := False;
    end;
  end;
#endif
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    // .NET 检测失败时只提示一次，绝不阻塞安装收尾
    if not IsDotNetDesktopInstalled() then
      MsgBox(ExpandConstant('{cm:MsgNeedDotNet}'), mbInformation, MB_OK);
  end;
end;

// 卸载前的运行状态检查：把"被控端还在运行"这件事明确告诉用户，
// 而不是等卸载到一半突然报错。真正的结束动作在 CurUninstallStepChanged 里做。
function InitializeUninstall(): Boolean;
var
  Exe: String;
  ResultCode: Integer;
begin
  Result := True;
  Exe := ExpandConstant('{app}') + '\LanControlServer.exe';
  if not FileExists(Exe) then Exit;
  if Exec(Exe, '--check-running', ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    if ResultCode <> 0 then
    begin
      if MsgBox('检测到被控端正在运行。' + #13#10 + #13#10 +
                '继续卸载会自动结束它（否则程序文件会因被占用而删不干净）。' + #13#10 +
                '是否继续卸载？', mbConfirmation, MB_YESNO) = IDNO then
        Result := False;
    end;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DesktopApk: String;
  AppDir: String;
  Exe: String;
  ResultCode: Integer;
begin
  // ---- 卸载最开始就处理"自己还在运行"的问题 ----
  // 不处理的话：被控端占着 exe/dll，卸载程序删不掉文件，会中途报"文件被占用"，
  // 留下"装也装不上、卸也卸不干净"的半卸载状态。
  if CurUninstallStep = usUninstall then
  begin
    AppDir := ExpandConstant('{app}');
    Exe := AppDir + '\LanControlServer.exe';
    if FileExists(Exe) then
    begin
      // --uninstall-clean 会：结束正在运行的被控端 + 清托盘注册表 + 清 Software\LanControl
      Exec(Exe, '--uninstall-clean', AppDir, SW_HIDE, ewWaitUntilTerminated, ResultCode);
      Sleep(1200);   // 给进程退出、文件句柄释放留时间
    end;
  end;

  if CurUninstallStep = usPostUninstall then
  begin
    DesktopApk := ExpandConstant('{userdesktop}\远程控制手机端.apk');
    if FileExists(DesktopApk) then
      DeleteFile(DesktopApk);

    // 兜底：万一程序已经被手动删掉，--uninstall-clean 跑不了，
    // 这里再清一次残留注册表（失败不影响卸载）。
    RegDeleteValue(HKEY_CURRENT_USER, 'Software\Microsoft\Windows\CurrentVersion\Run', 'LanControlServer');
    RegDeleteKeyIncludingSubkeys(HKEY_CURRENT_USER, 'Software\LanControl');
  end;
end;
