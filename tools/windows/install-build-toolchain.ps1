# Install the native build toolchain WinSTT needs on Windows. Run elevated.
#
# WHY THIS EXISTS: this repo builds a Tauri app with a large C++ dependency graph (ONNX
# Runtime, sherpa-onnx, DirectML). It needs an MSVC toolset, and the dev scripts also want
# LLVM for `lld-link` (link speed, see .cargo/config.toml) and `libclang` (bindgen).
#
#   1. Visual Studio Build Tools 2026 (VS 18) -- provides MSVC 14.5x. Binaries built with
#      the older 14.44 toolset that VS 2022 Build Tools ships were observed to
#      access-violate during STT model load on this codebase, while 14.5x builds run.
#   2. LLVM -- provides lld-link.exe and libclang.
#
#     powershell -ExecutionPolicy Bypass -File tools\windows\install-build-toolchain.ps1

$ErrorActionPreference = 'Continue'
$log = Join-Path $env:TEMP 'winstt-toolchain-install.log'
function Say($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
    Write-Host $line
    Add-Content -Path $log -Value $line -Encoding utf8
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "This script must run elevated (it installs machine-scope toolchains)."
}

$winget = "$env:LOCALAPPDATA\Microsoft\WindowsApps\winget.exe"
if (-not (Test-Path $winget)) {
    $winget = (Get-Command winget -ErrorAction SilentlyContinue).Source
}
if (-not $winget) { throw "winget not found; install App Installer from the Microsoft Store." }
Say "using winget at $winget"

# VS installer exit codes: 0 = ok, 3010 = success but a reboot is pending.
function Invoke-Install($id, $extra) {
    Say "installing $id ..."
    $args = @('install', '--id', $id, '--source', 'winget', '--exact',
              '--accept-package-agreements', '--accept-source-agreements',
              '--disable-interactivity')
    if ($extra) { $args += $extra }
    & $winget @args 2>&1 | ForEach-Object { Say "  $_" }
    $code = $LASTEXITCODE
    if ($code -eq 0 -or $code -eq 3010 -or $code -eq -1978335189) {
        Say "$id -> ok (exit $code)"
        return $true
    }
    Say "$id -> FAILED (exit $code)"
    return $false
}

# `--override` replaces the package's default install arguments wholesale, so it has to
# carry the quiet/wait flags as well as the workload selection.
$vsOverride = @('--override',
    '--quiet --wait --norestart --nocache --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended')
$okVs = Invoke-Install 'Microsoft.VisualStudio.BuildTools' $vsOverride
$okLlvm = Invoke-Install 'LLVM.LLVM' @('--scope', 'machine')

Say "=== result: VisualStudio.BuildTools=$okVs LLVM=$okLlvm ==="
Say "log: $log"
