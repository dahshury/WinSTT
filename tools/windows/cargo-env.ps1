# WinSTT cargo helper (PowerShell). Sets up the MSVC build environment, then runs cargo.
#
# PowerShell sibling of cargo-env.bat, and the way to run the headless audio probes in
# src-tauri/examples — they need the same MSVC environment `tauri dev` sets up:
#
#     .\tools\windows\cargo-env.ps1 run --release --example le_audio_capture_timeline -- all 5
#     .\tools\windows\cargo-env.ps1 run --release --example capture_live_gate_probe -- 3 6
#     .\tools\windows\cargo-env.ps1 check --all-targets
#
# Visual Studio is located with vswhere rather than a hardcoded edition/version path, so
# any edition works and a VS upgrade does not break this script.

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

$vsRoot = $null
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vswhere) {
    $vsRoot = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath |
        Select-Object -First 1
    if (-not $vsRoot) {
        $vsRoot = & $vswhere -latest -products * -property installationPath | Select-Object -First 1
    }
}
$vcvars = if ($vsRoot) { Join-Path $vsRoot 'VC\Auxiliary\Build\vcvars64.bat' } else { $null }
if (-not $vcvars -or -not (Test-Path $vcvars)) {
    throw "vcvars64.bat not found (vswhere reported '$vsRoot'). Install the 'Desktop development with C++' workload."
}

& cmd.exe /c "`"$vcvars`" >NUL 2>&1 && set" | ForEach-Object {
    $pair = $_ -split '=', 2
    if ($pair.Count -eq 2) { Set-Item -Path ("Env:" + $pair[0]) -Value $pair[1] }
}

$llvmBin = 'C:\Program Files\LLVM\bin'
$prepend = @(
    (Join-Path $env:USERPROFILE '.cargo\bin')
    $llvmBin
    (Join-Path $vsRoot 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin')
    (Join-Path $vsRoot 'Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja')
) | Where-Object { Test-Path $_ }
$env:PATH = "$($prepend -join ';');$env:PATH"
if (Test-Path $llvmBin) {
    $env:LIBCLANG_PATH = $llvmBin
} else {
    # .cargo/config.toml asks for lld-link.exe as a link-time optimization only. Without
    # LLVM that is a hard "linker not found" error, so fall back to the MSVC linker.
    $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = 'link.exe'
}
$env:CARGO_TERM_PROGRESS_WHEN = 'never'

Set-Location (Join-Path $repoRoot 'src-tauri')
& cargo @args
exit $LASTEXITCODE
