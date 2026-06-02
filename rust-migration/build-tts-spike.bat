@echo off
REM Build tts_spike into an ISOLATED target dir (no dev-watcher lock contention),
REM picking up the kokoro.rs CPU-pin + multi-thread + style-index fixes.
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat" >nul
set "PATH=C:\Users\MASTE\.cargo\bin;C:\Program Files\LLVM\bin;C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin;C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja;%PATH%"
set "LIBCLANG_PATH=C:\Program Files\LLVM\bin"
set "CARGO_TARGET_DIR=E:\DL\Projects\WinSTT\target-verify2"
cd /d E:\DL\Projects\WinSTT\src-tauri
cargo build --release --bin stt_spike --bin tts_spike > E:\DL\Projects\WinSTT\rust-migration\spike_build.log 2>&1
echo DONE exit=%ERRORLEVEL% >> E:\DL\Projects\WinSTT\rust-migration\spike_build.log
