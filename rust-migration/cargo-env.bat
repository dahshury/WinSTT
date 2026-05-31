@echo off
REM WinSTT Rust port — cargo build helper. Sets up the VS 2026 dev env + cmake/ninja/cargo on PATH.
REM Usage:  cargo-env.bat build   |   cargo-env.bat check   |   cargo-env.bat build --release
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat" >nul
set "PATH=C:\Users\MASTE\.cargo\bin;C:\Program Files\LLVM\bin;C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin;C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja;%PATH%"
set "LIBCLANG_PATH=C:\Program Files\LLVM\bin"
cd /d E:\DL\Projects\WinSTT\src-tauri
cargo %*
