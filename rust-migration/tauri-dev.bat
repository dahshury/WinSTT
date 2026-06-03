@echo off
REM Backward-compat shim. The real launcher is tauri-dev.ps1.
REM
REM NOTE: invoking THIS .bat and pressing Ctrl+C still triggers cmd.exe's
REM   "Terminate batch job (Y/N)?" prompt — that is a cmd limitation no batch file can
REM   suppress. For a fully clean Ctrl+C (no prompt), run the PowerShell launcher directly:
REM       .\rust-migration\tauri-dev.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tauri-dev.ps1" %*
