@echo off
REM Run the TTS engine spike with the VS dev env, redirecting ALL output to an absolute log.
REM Usage: spike.bat <engine> [voice] [text]
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
set "PATH=C:\Users\MASTE\.cargo\bin;C:\Program Files\LLVM\bin;%PATH%"
set "LIBCLANG_PATH=C:\Program Files\LLVM\bin"
cd /d E:\DL\Projects\WinSTT\src-tauri
cargo run --example tts_engine_spike -- %* > "%TEMP%\winstt-spike-out.log" 2>&1
echo CARGO_EXIT=%ERRORLEVEL% >> "%TEMP%\winstt-spike-out.log"
