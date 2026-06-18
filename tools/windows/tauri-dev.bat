@echo off
REM Backward-compat launcher. The real dev session is tauri-dev.ps1.
REM
REM Keep PowerShell attached to the original console. A plain `start` creates a second
REM console, so opening this .bat flashes a throwaway cmd window before the real dev
REM session appears. `start /b` lets this batch file exit while PowerShell keeps the
REM original console alive.

set "POWERSHELL_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%POWERSHELL_EXE%" set "POWERSHELL_EXE=powershell"

title WinSTT Tauri Dev
start "" /b "%POWERSHELL_EXE%" -NoProfile -ExecutionPolicy Bypass -NoExit -File "%~dp0tauri-dev.ps1" %*
exit /b 0
