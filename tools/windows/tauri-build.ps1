param(
    [switch] $NoBundle,
    [string] $Bundles = "",
    [string] $Config = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $PSCommandPath
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..")

function Find-VcVars64 {
    $Candidates = @()

    $VsWhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path -LiteralPath $VsWhere) {
        $InstallPath = & $VsWhere -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if ($LASTEXITCODE -eq 0 -and $InstallPath) {
            $Candidates += (Join-Path $InstallPath "VC\Auxiliary\Build\vcvars64.bat")
        }
    }

    $Candidates += @(
        "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat",
        "C:\Program Files\Microsoft Visual Studio\17\Enterprise\VC\Auxiliary\Build\vcvars64.bat",
        "C:\Program Files\Microsoft Visual Studio\17\Professional\VC\Auxiliary\Build\vcvars64.bat",
        "C:\Program Files\Microsoft Visual Studio\17\Community\VC\Auxiliary\Build\vcvars64.bat",
        "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat",
        "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat",
        "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat",
        "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
    )

    foreach ($Candidate in $Candidates | Select-Object -Unique) {
        if (Test-Path -LiteralPath $Candidate) {
            return $Candidate
        }
    }

    throw "Could not find vcvars64.bat. Install Visual Studio Build Tools with the MSVC x64 toolchain."
}

function Import-VcVars {
    param([string] $VcVars)

    cmd /d /s /c "`"$VcVars`" >nul && set" | ForEach-Object {
        if ($_ -match "^([^=]+)=(.*)$") {
            Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2]
        }
    }
}

function Import-Llvm {
    $Candidates = @()
    if ($env:LLVM_BIN) {
        $Candidates += $env:LLVM_BIN
    }
    if ($env:LLVM_HOME) {
        $Candidates += (Join-Path $env:LLVM_HOME "bin")
    }
    $Candidates += "C:\Program Files\LLVM\bin"

    foreach ($Candidate in $Candidates | Select-Object -Unique) {
        $Linker = Join-Path $Candidate "lld-link.exe"
        if (Test-Path -LiteralPath $Linker) {
            $env:PATH = "$Candidate;$env:PATH"
            $env:LIBCLANG_PATH = $Candidate
            return
        }
    }

    throw "Could not find lld-link.exe. Install LLVM and ensure C:\Program Files\LLVM\bin is available."
}

if (-not $NoBundle -and -not $Bundles) {
    $NoBundle = $true
}

$BuildArgs = @()
if ($NoBundle) {
    $BuildArgs += "--no-bundle"
}
if ($Bundles) {
    $BuildArgs += @("--bundles", $Bundles)
}
if ($Config) {
    $BuildArgs += @("--config", $Config)
}

Import-VcVars (Find-VcVars64)
Import-Llvm

Push-Location $RepoRoot
try {
    # Build + stage the native context sidecar (winstt_context) BEFORE the bundle so
    # the bundler picks it up via tauri.conf.json `resources` (binaries/winstt-context.exe).
    # It is a SEPARATE cargo bin that `tauri build` does NOT build on its own, and nothing
    # else stages it — without this the packaged app cannot resolve winstt-context.exe and
    # context-awareness is silently disabled in release. (Dev parity: tauri-dev.ps1.)
    # Fatal here (unlike dev): a release that ships without the sidecar is broken.
    cargo build --release --manifest-path (Join-Path $RepoRoot "src-tauri\Cargo.toml") --bin winstt_context
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to build the winstt_context sidecar (exit code $LASTEXITCODE)"
    }
    $BinDir = Join-Path $RepoRoot "src-tauri\binaries"
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    Copy-Item -Force `
        -Path (Join-Path $RepoRoot "src-tauri\target\release\winstt_context.exe") `
        -Destination (Join-Path $BinDir "winstt-context.exe")

    bun run tauri build @BuildArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri build failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}
