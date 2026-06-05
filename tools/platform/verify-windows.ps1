param(
    [ValidateSet("smoke", "standard", "full")]
    [string] $Profile = "standard",

    [switch] $SkipLaunch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $PSCommandPath
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..")
$CargoEnv = Join-Path $RepoRoot "tools\windows\cargo-env.bat"
$TauriBuild = Join-Path $RepoRoot "tools\windows\tauri-build.bat"

function Invoke-Logged {
    param(
        [string] $Label,
        [scriptblock] $Command
    )

    Write-Host ""
    Write-Host "==> $Label"
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE"
    }
}

function Invoke-Cargo {
    param([string[]] $CargoArgs)

    & $CargoEnv @CargoArgs
}

if ($Profile -eq "smoke") {
    Invoke-Logged "Rust check" {
        Invoke-Cargo @("check")
    }
    Invoke-Logged "Renderer build" {
        Push-Location $RepoRoot
        try {
            bun run build
        } finally {
            Pop-Location
        }
    }
    return
}

Invoke-Logged "Rust format check" {
    Invoke-Cargo @("fmt", "--all", "--", "--check")
}

Invoke-Logged "Rust check" {
    Invoke-Cargo @("check")
}

Invoke-Logged "Rust clippy" {
    Invoke-Cargo @("clippy", "--all-targets", "--", "-D", "warnings")
}

Invoke-Logged "Rust tests" {
    Invoke-Cargo @("test")
}

Invoke-Logged "Renderer build" {
    Push-Location $RepoRoot
    try {
        bun run build
    } finally {
        Pop-Location
    }
}

if ($Profile -ne "full") {
    return
}

Invoke-Logged "Frontend tests" {
    Push-Location $RepoRoot
    try {
        bun run test
    } finally {
        Pop-Location
    }
}

Invoke-Logged "Tauri build (no bundle)" {
    & $TauriBuild
}

if (-not $SkipLaunch) {
    Invoke-Logged "Release executable launch smoke" {
        $Exe = Resolve-Path (Join-Path $RepoRoot "src-tauri\target\release\winstt.exe")
        $Process = Start-Process -FilePath $Exe -PassThru -WindowStyle Hidden
        Start-Sleep -Seconds 5
        if ($Process.HasExited) {
            throw "winstt.exe exited during launch smoke with code $($Process.ExitCode)"
        }
        Write-Host "launch_ok pid=$($Process.Id)"
        $null = $Process.CloseMainWindow()
        Start-Sleep -Seconds 2
        if (-not $Process.HasExited) {
            Stop-Process -Id $Process.Id -Force
            Write-Host "stopped pid=$($Process.Id)"
        }
    }
}
