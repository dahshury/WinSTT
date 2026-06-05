param(
    [ValidateSet("smoke", "standard", "full")]
    [string] $Profile = "standard",

    [switch] $Windows,
    [switch] $Linux,
    [switch] $SkipWindows,
    [switch] $SkipLinux,
    [switch] $NoDockerBuild,
    [switch] $SkipLaunch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $PSCommandPath

$ExplicitPlatform = $Windows -or $Linux
$RunWindows = if ($ExplicitPlatform) { $Windows } else { -not $SkipWindows }
$RunLinux = if ($ExplicitPlatform) { $Linux } else { -not $SkipLinux }

if (-not $RunWindows -and -not $RunLinux) {
    throw "No platforms selected."
}

if ($RunWindows) {
    & (Join-Path $ScriptDir "verify-windows.ps1") -Profile $Profile -SkipLaunch:$SkipLaunch
}

if ($RunLinux) {
    & (Join-Path $ScriptDir "verify-linux-docker.ps1") `
        -Profile $Profile `
        -NoBuildImage:$NoDockerBuild `
        -SkipLaunch:$SkipLaunch
}
