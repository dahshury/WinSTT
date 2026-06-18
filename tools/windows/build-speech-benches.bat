@echo off
REM Build kokoro_tts_bench into an ISOLATED target dir (no dev-watcher lock contention),
REM picking up the kokoro.rs CPU-pin + multi-thread + style-index fixes.
set "REPO_ROOT=%~dp0..\.."
for %%I in ("%REPO_ROOT%") do set "REPO_ROOT=%%~fI"
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat" >nul
set "PATH=%USERPROFILE%\.cargo\bin;C:\Program Files\LLVM\bin;C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin;C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja;%PATH%"
set "LIBCLANG_PATH=C:\Program Files\LLVM\bin"
set "CARGO_TARGET_DIR=%REPO_ROOT%\target-verify-bench"
cd /d "%REPO_ROOT%\src-tauri"
cargo build --release --example stt_decode_bench --example kokoro_tts_bench > "%TEMP%\winstt-bench-build.log" 2>&1
echo DONE exit=%ERRORLEVEL% >> "%TEMP%\winstt-bench-build.log"
