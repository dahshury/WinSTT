param(
    [ValidateSet("smoke", "standard", "full")]
    [string] $Profile = "standard",

    [switch] $NoBuildImage,
    [switch] $SkipLaunch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $PSCommandPath
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..")
$Image = "winstt-linux-verify:24.04"
$Dockerfile = Join-Path $ScriptDir "linux.Dockerfile"

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

function Read-TrimmedFile {
    param([string] $Path)

    $Text = Get-Content -Path $Path -Raw -ErrorAction SilentlyContinue
    if ($null -eq $Text) {
        return ""
    }
    return $Text.Trim()
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker CLI was not found on PATH."
}

$DockerOut = New-TemporaryFile
$DockerErr = New-TemporaryFile
try {
    $DockerProbe = Start-Process `
        -FilePath "docker" `
        -ArgumentList @("info", "--format", "{{.OSType}}/{{.Architecture}}") `
        -NoNewWindow `
        -Wait `
        -PassThru `
        -RedirectStandardOutput $DockerOut `
        -RedirectStandardError $DockerErr
    $DockerInfo = Read-TrimmedFile $DockerOut
    $DockerError = Read-TrimmedFile $DockerErr
    if ($DockerProbe.ExitCode -ne 0) {
        $Message = (@($DockerInfo, $DockerError) | Where-Object { $_ } | Out-String).Trim()
        throw "Docker daemon is not reachable. Start Docker Desktop with the Linux engine enabled, then rerun this script. Docker said: $Message"
    }
} finally {
    Remove-Item -LiteralPath $DockerOut, $DockerErr -Force -ErrorAction SilentlyContinue
}
Write-Host "Docker daemon: $DockerInfo"

if (-not $NoBuildImage) {
    Invoke-Logged "Build Linux verification image" {
        docker build -f $Dockerfile -t $Image $ScriptDir
    }
}

$Commands = @(
    "set -euo pipefail",
    "rustc --version",
    "cargo --version",
    "bun --version",
    "bun install --frozen-lockfile --ignore-scripts --no-save"
)

if ($Profile -eq "smoke") {
    $Commands += @(
        "bun run build",
        "cd /work/src-tauri && cargo check"
    )
} else {
    $Commands += @(
        "bun run build",
        "cd /work/src-tauri && cargo fmt --all -- --check",
        "cd /work/src-tauri && cargo check --all-targets",
        "cd /work/src-tauri && cargo clippy --all-targets -- -D warnings",
        "cd /work/src-tauri && cargo test"
    )
}

if ($Profile -eq "full") {
    $Commands += @(
        "cd /work && bun run test",
        "cd /work && bun run tauri build --no-bundle"
    )

    if (-not $SkipLaunch) {
        $Commands += @(
            'cd /work && set +e; out=$(mktemp); LD_LIBRARY_PATH=/work/src-tauri/target/release:${LD_LIBRARY_PATH:-} dbus-run-session -- xvfb-run -a timeout 10s ./src-tauri/target/release/winstt >$out 2>&1; code=$?; cat $out; if grep -iq panicked $out || grep -iq panic $out || grep -iq fatal $out || grep -iq dumped $out || grep -iq libsherpa $out || grep -iq libonnxruntime $out; then rm -f $out; exit 1; fi; rm -f $out; set -e; if [ $code -eq 124 ]; then echo launch_ok_timeout; elif [ $code -eq 0 ]; then echo launch_exited_cleanly; else exit $code; fi'
        )
    }
}

$Bash = ($Commands -join "`n")
$RepoMount = "${RepoRoot}:/work"

$DockerArgs = @(
    "run",
    "--rm",
    "--volume", $RepoMount,
    "--volume", "winstt-linux-node-modules:/work/node_modules",
    "--volume", "winstt-linux-dist:/work/dist",
    "--volume", "winstt-linux-cargo-registry:/cargo/registry",
    "--volume", "winstt-linux-cargo-git:/cargo/git",
    "--volume", "winstt-linux-target:/work/src-tauri/target",
    "--env", "CI=true",
    "--env", "NO_AT_BRIDGE=1",
    "--env", "WEBKIT_DISABLE_COMPOSITING_MODE=1",
    "--workdir", "/work",
    $Image,
    "bash",
    "-lc",
    $Bash
)

Invoke-Logged "Linux Docker verification ($Profile)" {
    docker @DockerArgs
}
