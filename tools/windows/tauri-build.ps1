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

    # Stage the native runtime DLLs winstt.exe needs at runtime (DirectML for the ORT
    # DML EP — a load-time import — plus the MSVC CRT). tauri.windows.conf.json maps
    # binaries/runtime/*.dll into the install dir next to winstt.exe; without them the
    # installed app cannot start on a machine without a dev toolchain. The sidecar build
    # above already compiled the dependency graph, so the ort build script has placed
    # DirectML.dll in target\release. (tauri-portable.ps1 reuses this stage. sherpa-onnx
    # DLLs are gone — wake-word KWS runs natively on ort since the 2026-07 port.)
    $ReleaseDir = Join-Path $RepoRoot "src-tauri\target\release"
    $RuntimeDir = Join-Path $BinDir "runtime"
    if (Test-Path -LiteralPath $RuntimeDir) {
        Remove-Item -LiteralPath $RuntimeDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
    $RuntimeDlls = @(
        "DirectML.dll"
    )
    foreach ($Dll in $RuntimeDlls) {
        $Source = Join-Path $ReleaseDir $Dll
        if (-not (Test-Path -LiteralPath $Source)) {
            throw "Missing native runtime DLL: $Source (expected from the ort/sherpa-onnx build scripts)"
        }
        Copy-Item -Force -LiteralPath $Source -Destination (Join-Path $RuntimeDir $Dll)
    }
    # App-local MSVC CRT: winstt.exe imports MSVCP140/MSVCP140_1; do not assume the
    # target machine has the VC++ redistributable installed.
    if (-not $env:VCToolsRedistDir) {
        throw "VCToolsRedistDir not set by vcvars64 - cannot stage MSVC CRT DLLs"
    }
    $CrtDir = Get-ChildItem -Path (Join-Path $env:VCToolsRedistDir "x64") -Filter "Microsoft.VC*.CRT" -Directory |
        Select-Object -First 1
    if ($null -eq $CrtDir) {
        throw "No Microsoft.VC*.CRT directory under $env:VCToolsRedistDir\x64"
    }
    foreach ($Dll in @("msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll", "vcruntime140.dll", "vcruntime140_1.dll")) {
        $Source = Join-Path $CrtDir.FullName $Dll
        if (Test-Path -LiteralPath $Source) {
            Copy-Item -Force -LiteralPath $Source -Destination (Join-Path $RuntimeDir $Dll)
        }
    }

    bun run tauri build @BuildArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri build failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}
