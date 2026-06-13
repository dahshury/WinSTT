param(
    [int]$WatchMinutes = 15,
    [int]$PollSeconds = 5,
    [string]$OutDir = "",
    [string[]]$RequiredTargets = @(
        "gmail",
        "discord",
        "facebook-main",
        "facebook-messenger"
    ),
    [switch]$StopWhenRequiredReady
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$captureScript = Join-Path $repoRoot "tools\windows\context-safe-capture.ps1"
if (-not (Test-Path $captureScript)) {
    throw "Safe capture script not found: $captureScript"
}

function Expand-TargetArgs([string[]]$Values) {
    @($Values |
        ForEach-Object { $_ -split "," } |
        ForEach-Object { $_.Trim() } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

$RequiredTargets = @(Expand-TargetArgs $RequiredTargets)

if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $OutDir = Join-Path $repoRoot "artifacts\context-safe-capture-monitor\$stamp"
}
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$watchSeconds = [Math]::Max(1, $WatchMinutes) * 60
$stdoutPath = Join-Path $OutDir "monitor.stdout.log"
$stderrPath = Join-Path $OutDir "monitor.stderr.log"
$metadataPath = Join-Path $OutDir "monitor.json"

$arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $captureScript,
    "-SkipBuild",
    "-WatchSeconds", $watchSeconds.ToString(),
    "-PollSeconds", ([Math]::Max(1, $PollSeconds)).ToString(),
    "-OutDir", $OutDir
)
if ($RequiredTargets.Count -gt 0) {
    $arguments += "-RequiredTargets"
    $arguments += ($RequiredTargets -join ",")
}
if ($StopWhenRequiredReady) {
    $arguments += "-StopWhenRequiredReady"
}

$process = Start-Process -FilePath "powershell.exe" `
    -ArgumentList $arguments `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru

$metadata = [ordered]@{
    startedAt = (Get-Date).ToString("o")
    processId = $process.Id
    watchSeconds = $watchSeconds
    pollSeconds = [Math]::Max(1, $PollSeconds)
    outDir = $OutDir
    summaryPath = (Join-Path $OutDir "summary.json")
    stdoutPath = $stdoutPath
    stderrPath = $stderrPath
    rawSnapshotsEnabled = $false
    tabSwitchingEnabled = $false
    requiredTargets = $RequiredTargets
    stopWhenRequiredReady = [bool]$StopWhenRequiredReady
}

$encoding = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($metadataPath, ($metadata | ConvertTo-Json -Depth 4), $encoding)
Write-Output ($metadata | ConvertTo-Json -Depth 4)
