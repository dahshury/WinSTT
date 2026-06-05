@echo off
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat" 1>nul 2>nul
set "PATH=C:\Users\MASTE\.cargo\bin;C:\Program Files\LLVM\bin;%PATH%"
set "LIBCLANG_PATH=C:\Program Files\LLVM\bin"
cd /d E:\DL\Projects\WinSTT\src-tauri
cargo check --release --example tts_spike %*
