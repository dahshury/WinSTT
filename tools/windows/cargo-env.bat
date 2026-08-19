@echo off
REM WinSTT Rust port cargo helper. Sets up the VS dev env plus cmake/ninja/cargo on PATH.
REM Usage: cargo-env.bat build | cargo-env.bat check | cargo-env.bat build --release
REM
REM Visual Studio is located with vswhere (fixed path, ships with every VS 2017+ install)
REM instead of a hardcoded edition/version directory. The previous hardcoded
REM "Visual Studio\18\Community" path silently broke every script in this folder when that
REM install was replaced by Build Tools. See tools\windows\cargo-env.ps1 for the PowerShell
REM equivalent (which is also what runs the headless audio probes).
setlocal
set "REPO_ROOT=%~dp0..\.."
for %%I in ("%REPO_ROOT%") do set "REPO_ROOT=%%~fI"

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
    echo cargo-env: vswhere.exe not found; install Visual Studio Build Tools with the C++ workload.
    exit /b 1
)
set "VS_ROOT="
for /f "usebackq delims=" %%I in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VS_ROOT=%%I"
if not defined VS_ROOT (
    for /f "usebackq delims=" %%I in (`"%VSWHERE%" -latest -products * -property installationPath`) do set "VS_ROOT=%%I"
)
if not defined VS_ROOT (
    echo cargo-env: no Visual Studio install found.
    exit /b 1
)
if not exist "%VS_ROOT%\VC\Auxiliary\Build\vcvars64.bat" (
    echo cargo-env: vcvars64.bat missing under "%VS_ROOT%"; install the "Desktop development with C++" workload.
    exit /b 1
)

call "%VS_ROOT%\VC\Auxiliary\Build\vcvars64.bat" >nul
set "PATH=%USERPROFILE%\.cargo\bin;C:\Program Files\LLVM\bin;%VS_ROOT%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin;%VS_ROOT%\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja;%PATH%"
if exist "C:\Program Files\LLVM\bin\libclang.dll" (
    set "LIBCLANG_PATH=C:\Program Files\LLVM\bin"
) else (
    REM .cargo\config.toml asks for lld-link.exe; without LLVM fall back to the MSVC linker.
    set "CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER=link.exe"
)
cd /d "%REPO_ROOT%\src-tauri"
cargo %*
exit /b %ERRORLEVEL%
