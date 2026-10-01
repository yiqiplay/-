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

function IsCustomPort(Param: String): Boolean;
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
    if not IsDotNetDesktopInstalled() then
      MsgBox(ExpandConstant('{cm:MsgNeedDotNet}'), mbInformation, MB_OK);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DesktopApk: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DesktopApk := ExpandConstant('{userdesktop}\远程控制手机端.apk');
    if FileExists(DesktopApk) then
      DeleteFile(DesktopApk);
  end;
end;
