@echo off
if "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tauri-build.ps1" -NoBundle
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tauri-build.ps1" %*
)
