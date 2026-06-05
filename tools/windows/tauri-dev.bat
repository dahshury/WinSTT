@echo off
REM Backward-compat launcher. The real dev session is tauri-dev.ps1.
REM
REM Do not wait inside this batch file. If cmd.exe is still executing a .bat when Ctrl+C
REM arrives, Windows prompts with "Terminate batch job (Y/N)?". Launch PowerShell as the
REM long-running process and let this batch file exit immediately.

set "POWERSHELL_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%POWERSHELL_EXE%" set "POWERSHELL_EXE=powershell"

start "WinSTT Tauri Dev" "%POWERSHELL_EXE%" -NoProfile -ExecutionPolicy Bypass -NoExit -File "%~dp0tauri-dev.ps1" %*
exit /b 0
