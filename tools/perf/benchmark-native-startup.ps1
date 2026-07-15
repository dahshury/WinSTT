param(
    [string] $PackageDir = "dist\WinSTT-portable",
    [int] $Runs = 5,
    [int] $Warmup = 1,
    [int] $TimeoutSeconds = 90,
    [string] $Output = "",
    [switch] $Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($Runs -lt 2) { throw "-Runs must be at least 2" }
if ($Warmup -lt 0 -or $Warmup -ge $Runs) { throw "-Warmup must be >= 0 and smaller than -Runs" }
if ($TimeoutSeconds -lt 10) { throw "-TimeoutSeconds must be at least 10" }

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$resolvedPackage = if ([IO.Path]::IsPathRooted($PackageDir)) {
    [IO.Path]::GetFullPath($PackageDir)
} else {
    [IO.Path]::GetFullPath((Join-Path $repoRoot $PackageDir))
}
$exe = Join-Path $resolvedPackage "WinSTT.exe"
$portableMarker = Join-Path $resolvedPackage "portable"
$logDir = Join-Path $resolvedPackage "Data\logs"
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "Missing packaged executable: $exe" }
if (-not (Test-Path -LiteralPath $portableMarker -PathType Leaf)) {
    throw "Startup benchmark requires an isolated portable package (missing $portableMarker)"
}

function Get-LogSnapshot {
    if (-not (Test-Path -LiteralPath $logDir -PathType Container)) { return "" }
    $files = @(Get-ChildItem -LiteralPath $logDir -Filter "*.log" -File | Sort-Object LastWriteTimeUtc)
    return ($files | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue }) -join "`n"
}

function Marker-Milliseconds([string] $Text, [string] $Marker) {
    $escaped = [Regex]::Escape($Marker)
    $matches = [Regex]::Matches($Text, "\[startup\]\s+${escaped}:\s+(\d+)\s+ms since launch")
    if ($matches.Count -eq 0) { return $null }
    return [int64]$matches[$matches.Count - 1].Groups[1].Value
}

function Percentile([double[]] $Values, [double] $P) {
    $sorted = @($Values | Sort-Object)
    $index = [Math]::Min($sorted.Count - 1, [Math]::Max(0, [Math]::Ceiling($P * $sorted.Count) - 1))
    return [Math]::Round($sorted[$index], 1)
}

function Invoke-StartupRun([string] $Policy, [int] $Ordinal) {
    $before = Get-LogSnapshot
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $exe
    $start.WorkingDirectory = $resolvedPackage
    $start.UseShellExecute = $false
    $start.Environment["WINSTT_PROFILE_STARTUP"] = "1"
    $start.Environment["WINSTT_STT_WARMUP_POLICY"] = $Policy
    $start.Environment["RUST_LOG"] = "info"
    $process = [Diagnostics.Process]::Start($start)
    if ($null -eq $process) { throw "Could not start $exe" }
    $external = [Diagnostics.Stopwatch]::StartNew()
    $newLog = ""
    try {
        $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
        do {
            Start-Sleep -Milliseconds 100
            $all = Get-LogSnapshot
            if ($all.Length -ge $before.Length -and $all.StartsWith($before, [StringComparison]::Ordinal)) {
                $newLog = $all.Substring($before.Length)
            } else {
                # Rotation occurred. All startup markers in the current file belong to this
                # just-launched process because the previous process was already stopped.
                $newLog = $all
            }
            $reveal = Marker-Milliseconds $newLog "reveal dispatched"
            if ($null -eq $reveal) {
                $reveal = Marker-Milliseconds $newLog "reveal dispatched (timeout fallback)"
            }
            $stt = Marker-Milliseconds $newLog "STT boot/warmup complete"
            if ($null -ne $reveal -and $null -ne $stt) { break }
            if ($process.HasExited) { break }
        } while ((Get-Date) -lt $deadline)

        $paint = Marker-Milliseconds $newLog "main renderer painted"
        $rendererReady = Marker-Milliseconds $newLog "main renderer bootstrap ready"
        $sttWarm = Marker-Milliseconds $newLog "STT boot/warmup complete"
        $firstUsable = Marker-Milliseconds $newLog "reveal dispatched"
        if ($null -eq $firstUsable) {
            $firstUsable = Marker-Milliseconds $newLog "reveal dispatched (timeout fallback)"
        }
        $onboardingSkipped = $newLog.Contains("STT boot/warmup skipped -- onboarding active", [StringComparison]::Ordinal)
        $complete = $null -ne $paint -and $null -ne $rendererReady -and $null -ne $sttWarm -and $null -ne $firstUsable
        return [ordered]@{
            policy = $Policy
            ordinal = $Ordinal
            processObservedMs = [Math]::Round($external.Elapsed.TotalMilliseconds, 1)
            processToPaintMs = $paint
            processToRendererReadyMs = $rendererReady
            processToSttWarmMs = $sttWarm
            processToFirstUsableMs = $firstUsable
            valid = $complete -and -not $onboardingSkipped
            invalidReason = if ($onboardingSkipped) { "onboarding active; STT warmup skipped" } elseif (-not $complete) { "one or more startup markers missing or timed out" } else { $null }
        }
    }
    finally {
        if (-not $process.HasExited) {
            $process.Kill($true)
            $process.WaitForExit()
        }
    }
}

# Alternate policies so thermal/cache drift does not systematically favor one arm.
$samples = @()
for ($ordinal = 0; $ordinal -lt $Runs; $ordinal++) {
    foreach ($policy in @("eager", "renderer-ready")) {
        $samples += Invoke-StartupRun $policy $ordinal
    }
}

$summaries = foreach ($policy in @("eager", "renderer-ready")) {
    $measured = @($samples | Where-Object { $_.policy -eq $policy -and $_.ordinal -ge $Warmup -and $_.valid })
    $summary = [ordered]@{ policy = $policy; validRuns = $measured.Count }
    foreach ($metric in @("processToPaintMs", "processToRendererReadyMs", "processToSttWarmMs", "processToFirstUsableMs")) {
        $values = [double[]]@($measured | ForEach-Object { $_[$metric] })
        $summary["${metric}Median"] = if ($values.Count) { Percentile $values 0.5 } else { $null }
        $summary["${metric}P75"] = if ($values.Count) { Percentile $values 0.75 } else { $null }
    }
    [pscustomobject]$summary
}

$payload = [ordered]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    executable = $exe
    metric = "milliseconds from WinSTT run() process-entry anchor to native startup log marker"
    runs = $Runs
    warmup = $Warmup
    summaries = $summaries
    samples = $samples
}

if ($Json) { $payload | ConvertTo-Json -Depth 8 }
else {
    $summaries | Format-Table -AutoSize
    $invalid = @($samples | Where-Object { -not $_.valid })
    if ($invalid.Count) { Write-Warning "$($invalid.Count) samples were invalid; inspect samples/invalidReason in JSON output." }
}
if ($Output) {
    $outputPath = if ([IO.Path]::IsPathRooted($Output)) { $Output } else { Join-Path $repoRoot $Output }
    $payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $outputPath -Encoding utf8
}
