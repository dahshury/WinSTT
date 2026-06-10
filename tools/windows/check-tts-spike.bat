@echo off
set "REPO_ROOT=%~dp0..\.."
for %%I in ("%REPO_ROOT%") do set "REPO_ROOT=%%~fI"
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat" 1>nul 2>nul
set "PATH=%USERPROFILE%\.cargo\bin;C:\Program Files\LLVM\bin;%PATH%"
set "LIBCLANG_PATH=C:\Program Files\LLVM\bin"
cd /d "%REPO_ROOT%\src-tauri"
cargo check --release --example tts_spike %*
