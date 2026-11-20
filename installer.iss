; ═══════════════════════════════════════════════════════════════
;  Inno Setup Script — СЗЗ Инструмент
;  Требует Inno Setup 6+: https://jrsoftware.org/isdl.php
; ═══════════════════════════════════════════════════════════════

#define MyAppName      "СЗЗ Инструмент"
; Версия — единый источник: version.txt (его же читает приложение)
#define VerHandle      FileOpen("version.txt")
#define MyAppVersion   Trim(FileRead(VerHandle))
#expr FileClose(VerHandle)
#define MyAppPublisher "СЗЗ Инструмент"
#define MyAppExeName   "SZZ-Tool.exe"
#define MyAppId        "{{A3F7C2B1-4E8D-4F9A-B2C3-D1E5F6A7B8C9}"
; Имя правила брандмауэра — латиницей, чтобы не зависеть от кодировки консоли
#define FwRuleName     "SZZ-Tool"

; ── WebView2: офлайн-установщик, если он положен рядом со скриптом ──
; Скачать один раз: https://go.microsoft.com/fwlink/?linkid=2124701
;   (Evergreen Standalone Installer x64, ~180 МБ)
; Без него используется сетевой бутстраппер MicrosoftEdgeWebview2Setup.exe
#define WV2Offline     "MicrosoftEdgeWebView2RuntimeInstallerX64.exe"
#define WV2Bootstrap   "MicrosoftEdgeWebview2Setup.exe"
#if FileExists(WV2Offline)
  #define HaveWV2Offline
#endif

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppComments=Инструмент для построения и анализа санитарно-защитных зон
DefaultDirName={autopf}\SZZ-Tool
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
OutputDir=installer_output
OutputBaseFilename=SZZ-Tool-Setup-{#MyAppVersion}
SetupIconFile=main_icon.ico
; Иконку берём из .ico, а не из exe — там все размеры вплоть до 256×256
UninstallDisplayIcon={app}\_internal\main_icon.ico
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
WizardSizePercent=110
DisableWelcomePage=no
LicenseFile=
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesInstallIn64BitMode=x64compatible
; Минимальная версия Windows: 10
MinVersion=10.0
; Ассоциация файлов .szz
ChangesAssociations=yes

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[CustomMessages]
russian.WebView2Missing=Не удалось установить Microsoft Edge WebView2 Runtime автоматически.%n%nЧаще всего причина — нет доступа в интернет или было отклонено окно контроля учётных записей (UAC).%n%nСама программа установлена и появится в меню Пуск, но без этого компонента она не запустится.%n%nОткрыть страницу загрузки WebView2 в браузере?%n(на странице нужен "Evergreen Standalone Installer" → x64)
russian.WebView2Installing=Установка Microsoft Edge WebView2 Runtime...
russian.FirewallAdding=Настройка доступа в интернет (брандмауэр Windows)...
russian.FirewallFailed=Не удалось добавить правило брандмауэра Windows — вероятно, было отклонено окно контроля учётных записей (UAC).%n%nЕсли программа не сможет загружать данные НСПД, попросите администратора разрешить в брандмауэре исходящие подключения для файла:%n%n%1
russian.LaunchAfterInstall=Запустить СЗЗ Инструмент

[Tasks]
Name: "desktopicon"; Description: "Создать ярлык на рабочем столе"; GroupDescription: "Дополнительно:"; Flags: unchecked
Name: "firewall"; Description: "Разрешить программе доступ в интернет (брандмауэр Windows)"; GroupDescription: "Дополнительно:"

[Files]
; Главный исполняемый файл
Source: "dist\SZZ-Tool\SZZ-Tool.exe"; DestDir: "{app}"; Flags: ignoreversion

; Все внутренние файлы (HTML, JS, CSS, библиотеки, Python-зависимости)
Source: "dist\SZZ-Tool\_internal\*"; DestDir: "{app}\_internal"; \
  Flags: ignoreversion recursesubdirs createallsubdirs

; WebView2 — распаковывается во временную папку и ставится при необходимости.
; Офлайн-установщик (если есть) не требует интернета; бутстраппер остаётся
; запасным вариантом для не-x64 систем.
#ifdef HaveWV2Offline
Source: "{#WV2Offline}"; Flags: dontcopy noencryption
#endif
Source: "{#WV2Bootstrap}"; Flags: dontcopy noencryption

[Registry]
; Ассоциация .szz — двойной клик по проекту открывает приложение
Root: HKA; Subkey: "Software\Classes\.szz"; ValueType: string; ValueName: ""; \
  ValueData: "SZZTool.Project"; Flags: uninsdeletevalue
Root: HKA; Subkey: "Software\Classes\SZZTool.Project"; ValueType: string; ValueName: ""; \
  ValueData: "Проект СЗЗ Инструмент"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\SZZTool.Project\DefaultIcon"; ValueType: string; ValueName: ""; \
  ValueData: "{app}\_internal\main_icon.ico"
Root: HKA; Subkey: "Software\Classes\SZZTool.Project\shell\open\command"; ValueType: string; ValueName: ""; \
  ValueData: """{app}\{#MyAppExeName}"" ""%1"""

[Icons]
; Меню Пуск
Name: "{group}\{#MyAppName}"; \
  Filename: "{app}\{#MyAppExeName}"; \
  IconFilename: "{app}\_internal\main_icon.ico"; \
  Comment: "Построение и анализ санитарно-защитных зон"

Name: "{group}\Удалить {#MyAppName}"; \
  Filename: "{uninstallexe}"

; Рабочий стол (по желанию)
Name: "{autodesktop}\{#MyAppName}"; \
  Filename: "{app}\{#MyAppExeName}"; \
  IconFilename: "{app}\_internal\main_icon.ico"; \
  Tasks: desktopicon

[Run]
; Запустить после установки
Filename: "{app}\{#MyAppExeName}"; \
  Description: "{cm:LaunchAfterInstall}"; \
  Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Удалить папку установки и данные пользователя (кэш, логи) при деинсталляции
Type: filesandordirs; Name: "{app}"
Type: filesandordirs; Name: "{localappdata}\SZZ-Tool"

[Code]
// ─── Проверка WebView2 Runtime ───────────────────────────────
const
  WV2Key = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

// Ключ есть, но версия пустая или 0.0.0.0 — рантайм удалён, считаем что его нет
function WV2VerOk(const Ver: String): Boolean;
begin
  Result := (Ver <> '') and (Ver <> '0.0.0.0');
end;

function WebView2Installed: Boolean;
var
  Ver: String;
begin
  Result := False;
  // Машинная установка: ключ всегда пишется в 32-битный вид реестра
  if RegQueryStringValue(HKLM32, WV2Key, 'pv', Ver) and WV2VerOk(Ver) then
    begin Result := True; Exit; end;
  if IsWin64 then
    if RegQueryStringValue(HKLM64, WV2Key, 'pv', Ver) and WV2VerOk(Ver) then
      begin Result := True; Exit; end;
  // Установка на пользователя
  if RegQueryStringValue(HKCU32, WV2Key, 'pv', Ver) and WV2VerOk(Ver) then
    begin Result := True; Exit; end;
  if IsWin64 then
    if RegQueryStringValue(HKCU64, WV2Key, 'pv', Ver) and WV2VerOk(Ver) then
      begin Result := True; Exit; end;
  // Запасной вариант — файлы рантайма на диске (реестр мог быть почищен)
  if DirExists(ExpandConstant('{commonpf32}\Microsoft\EdgeWebView\Application')) or
     DirExists(ExpandConstant('{localappdata}\Microsoft\EdgeWebView\Application')) then
    Result := True;
end;

// ─── Правило брандмауэра Windows ─────────────────────────────
// Порты приложения слушаются только на 127.0.0.1, поэтому входящие
// подключения не нужны — но в сетях с политикой «исходящие запрещены»
// без явного разрешения не работает загрузка данных НСПД.
function RunFirewallScript(const Script: String): Boolean;
var
  CmdFile: String;
  ResultCode: Integer;
begin
  Result := False;
  CmdFile := ExpandConstant('{tmp}\szz_firewall.cmd');
  // chcp 65001 в первой строке — чтобы cmd верно прочитал путь с кириллицей
  if not SaveStringToFile(CmdFile, '@echo off' + #13#10 +
                                   'chcp 65001 >nul' + #13#10 + Script, False) then
    Exit;
  if IsAdminInstallMode then
    Result := Exec(ExpandConstant('{cmd}'), '/c "' + CmdFile + '"', '',
                   SW_HIDE, ewWaitUntilTerminated, ResultCode)
  else
    // Установка от обычного пользователя — правило требует повышения прав
    Result := ShellExec('runas', ExpandConstant('{cmd}'), '/c "' + CmdFile + '"', '',
                        SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if Result then
    Result := (ResultCode = 0);
end;

function AddFirewallRules(const ExePath: String): Boolean;
var
  S: String;
begin
  // Сначала удаляем старое правило — иначе при переустановке они копятся
  S := 'netsh advfirewall firewall delete rule name="{#FwRuleName}" >nul 2>&1' + #13#10 +
       'netsh advfirewall firewall add rule name="{#FwRuleName}" dir=out action=allow' +
       ' program="' + ExePath + '" enable=yes profile=any' + #13#10 +
       'netsh advfirewall firewall add rule name="{#FwRuleName}" dir=in action=allow' +
       ' program="' + ExePath + '" enable=yes profile=any' + #13#10;
  Result := RunFirewallScript(S);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  ExePath, WV2File: String;
begin
  // Автоустановка WebView2 — из вложенного установщика, без обращения к сети
  if CurStep = ssPostInstall then begin
    if not WebView2Installed then begin
      WizardForm.StatusLabel.Caption := CustomMessage('WebView2Installing');
      WV2File := '{#WV2Bootstrap}';
#ifdef HaveWV2Offline
      // Офлайн-пакет — только x64; на прочих архитектурах остаётся бутстраппер
      if Is64BitInstallMode then
        WV2File := '{#WV2Offline}';
#endif
      try
        ExtractTemporaryFile(WV2File);
        Exec(ExpandConstant('{tmp}\') + WV2File,
             '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
      except
      end;
      // Если и после этого нет (нет интернета / отменили UAC) — подсказка
      if not WebView2Installed then
        if MsgBox(CustomMessage('WebView2Missing'), mbInformation, MB_YESNO) = IDYES then
          ShellExec('open',
            'https://developer.microsoft.com/ru-ru/microsoft-edge/webview2/',
            '', '', SW_SHOW, ewNoWait, ResultCode);
    end;

    // Разрешение в брандмауэре Windows
    if WizardIsTaskSelected('firewall') then begin
      WizardForm.StatusLabel.Caption := CustomMessage('FirewallAdding');
      ExePath := ExpandConstant('{app}\{#MyAppExeName}');
      if not AddFirewallRules(ExePath) then
        MsgBox(FmtMessage(CustomMessage('FirewallFailed'), [ExePath]),
               mbInformation, MB_OK);
    end;
  end;
end;

// Убираем правило брандмауэра при удалении программы
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  CmdFile: String;
  ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then begin
    CmdFile := ExpandConstant('{tmp}\szz_firewall_del.cmd');
    if SaveStringToFile(CmdFile,
         '@echo off' + #13#10 +
         'netsh advfirewall firewall delete rule name="{#FwRuleName}" >nul 2>&1' + #13#10,
         False) then begin
      if IsAdminInstallMode then
        Exec(ExpandConstant('{cmd}'), '/c "' + CmdFile + '"', '',
             SW_HIDE, ewWaitUntilTerminated, ResultCode)
      else
        ShellExec('runas', ExpandConstant('{cmd}'), '/c "' + CmdFile + '"', '',
                  SW_HIDE, ewWaitUntilTerminated, ResultCode);
    end;
  end;
end;
