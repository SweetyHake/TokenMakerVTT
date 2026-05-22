; Token Maker Inno Setup script
; Install Inno Setup from https://jrsoftware.org/isdl.php first

#define MyAppName "Token Maker"
#define MyAppVersion "1.0.1"
#define MyAppPublisher "SweetyHake"
#define MyAppURL "https://github.com/SweetyHake/TokenMakerVTT"
#define MyAppExeName "TokenMaker.exe"

[Setup]
AppId={{F0A1B2C3-D4E5-6789-ABCD-EF0123456789}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=dist\installer
OutputBaseFilename=TokenMaker_Setup_v{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\{#MyAppExeName}
PrivilegesRequired=admin

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: checkedonce

[Files]
Source: "dist\TokenMaker\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Code]
function IsPythonInstalled: Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec('cmd.exe', '/C python --version', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

[Run]
Filename: "{cmd}"; Parameters: "/C python -m pip install numpy Pillow flask pywebview psutil --quiet"; StatusMsg: "Installing Python packages..."; Flags: runhidden; Check: IsPythonInstalled
Filename: "{cmd}"; Parameters: "/C python -m pip install onnxruntime-directml --quiet || python -m pip install onnxruntime --quiet"; StatusMsg: "Installing AI backend..."; Flags: runhidden; Check: IsPythonInstalled
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent


