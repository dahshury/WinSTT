@echo off
REM WinSTT Rust port cargo helper. Sets up the VS dev env plus cmake/ninja/cargo on PATH.
REM Usage: cargo-env.bat build | cargo-env.bat check | cargo-env.bat build --release
set "REPO_ROOT=%~dp0..\.."
for %%I in ("%REPO_ROOT%") do set "REPO_ROOT=%%~fI"
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat" >nul
set "PATH=%USERPROFILE%\.cargo\bin;C:\Program Files\LLVM\bin;C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin;C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja;%PATH%"
set "LIBCLANG_PATH=C:\Program Files\LLVM\bin"
cd /d "%REPO_ROOT%\src-tauri"
cargo %*
exit /b %ERRORLEVEL%
