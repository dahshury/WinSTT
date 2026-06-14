param(
    [string[]]$Targets = @(
        "gmail",
        "discord",
        "codex",
        "claude",
        "facebook-main",
        "facebook-messenger",
        "whatsapp",
        "x",
        "slack"
    ),
    [string]$OutDir = "",
    [switch]$AllowTabSwitch,
    [switch]$KeepRaw,
    [switch]$SkipBuild,
    [int]$WatchSeconds = 0,
    [int]$PollSeconds = 5,
    [int]$WarningRetryPasses = 6,
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
if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $OutDir = Join-Path $repoRoot "artifacts\context-safe-capture\$stamp"
}
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$sidecar = Join-Path $repoRoot "src-tauri\binaries\winstt-context.exe"
$cargoEnv = Join-Path $repoRoot "tools\windows\cargo-env.bat"
$smokeExe = Join-Path $repoRoot "src-tauri\target\debug\context_prompt_smoke.exe"

if (-not (Test-Path $sidecar)) {
    throw "Native context helper not found: $sidecar"
}

if (-not $SkipBuild) {
    & $cargoEnv build --bin context_prompt_smoke | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to build context_prompt_smoke"
    }
}
if (-not (Test-Path $smokeExe)) {
    throw "Prompt smoke executable not found: $smokeExe"
}

$pinvoke = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ContextSafeCaptureWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
Add-Type -TypeDefinition $pinvoke | Out-Null
Add-Type -AssemblyName UIAutomationClient | Out-Null
Add-Type -AssemblyName UIAutomationTypes | Out-Null

function Expand-TargetArgs([string[]]$Values) {
    @($Values |
        ForEach-Object { $_ -split "," } |
        ForEach-Object { $_.Trim() } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

$Targets = @(Expand-TargetArgs $Targets)
$RequiredTargets = @(Expand-TargetArgs $RequiredTargets)

function Sanitize-Text([string]$Value) {
    if ($null -eq $Value) {
        return ""
    }
    return (($Value -replace '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[email]') -replace '\s+', ' ').Trim()
}

function Get-ForegroundInfo {
    $hwnd = [ContextSafeCaptureWin32]::GetForegroundWindow()
    [uint32]$processId = 0
    [ContextSafeCaptureWin32]::GetWindowThreadProcessId($hwnd, [ref]$processId) | Out-Null
    $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
    $title = New-Object System.Text.StringBuilder 512
    [ContextSafeCaptureWin32]::GetWindowText($hwnd, $title, $title.Capacity) | Out-Null
    [pscustomobject]@{
        hwnd = $hwnd.ToInt64().ToString()
        processId = $processId
        process = if ($proc) { $proc.ProcessName } else { "" }
        title = Sanitize-Text $title.ToString()
    }
}

function Get-TabItems($Root) {
    $condition = New-Object System.Windows.Automation.PropertyCondition `
        ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), `
        ([System.Windows.Automation.ControlType]::TabItem)
    $tabs = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    $items = @()
    for ($i = 0; $i -lt $tabs.Count; $i++) {
        $tab = $tabs.Item($i)
        $selected = $false
        $selectable = $false
        try {
            $pattern = $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
            $selected = $pattern.Current.IsSelected
            $selectable = $true
        } catch {
            $pattern = $null
        }
        $items += [pscustomobject]@{
            index = $i
            name = $tab.Current.Name
            sanitizedName = Sanitize-Text $tab.Current.Name
            selected = $selected
            selectable = $selectable
            element = $tab
        }
    }
    return $items
}

function Select-TabItem($Item) {
    $pattern = $Item.element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    $pattern.Select()
}

function Write-Utf8NoBom([string]$Path, [string]$Value) {
    $encoding = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($Path, $Value, $encoding)
}

function Write-Utf8NoBomAtomic([string]$Path, [string]$Value) {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $directory = Split-Path -Parent $fullPath
    if (-not [string]::IsNullOrWhiteSpace($directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }

    $leaf = [System.IO.Path]::GetFileName($fullPath)
    $writeId = [Guid]::NewGuid().ToString("N")
    $tmpPath = Join-Path $directory ("." + $leaf + "." + $writeId + ".tmp")
    $backupPath = Join-Path $directory ("." + $leaf + "." + $writeId + ".bak")
    try {
        Write-Utf8NoBom -Path $tmpPath -Value $Value
        if (Test-Path -LiteralPath $fullPath) {
            [System.IO.File]::Replace($tmpPath, $fullPath, $backupPath)
        } else {
            Move-Item -LiteralPath $tmpPath -Destination $fullPath -Force
        }
    } finally {
        if (Test-Path -LiteralPath $tmpPath) {
            Remove-Item -LiteralPath $tmpPath -Force
        }
        if (Test-Path -LiteralPath $backupPath) {
            Remove-Item -LiteralPath $backupPath -Force
        }
    }
}

function Invoke-Capture($Window, [string]$Label, [string]$TargetDir) {
    $raw = & $sidecar --tree --hwnd $Window.hwnd
    $sidecarExit = $LASTEXITCODE
    $rawJsonValid = $false
    try {
        $null = $raw | ConvertFrom-Json -ErrorAction Stop
        $rawJsonValid = $true
    } catch {
        $rawJsonValid = $false
    }

    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    $rawPath = if ($KeepRaw) {
        Join-Path $TargetDir "rawSnapshot.json"
    } else {
        Join-Path ([System.IO.Path]::GetTempPath()) ("winstt-context-" + [Guid]::NewGuid().ToString("N") + ".json")
    }
    Write-Utf8NoBom -Path $rawPath -Value $raw
    try {
        $smokeOutput = & $smokeExe --input $rawPath --label $Label --require-prompt-json
        $smokeExit = $LASTEXITCODE
    } finally {
        if (-not $KeepRaw -and (Test-Path $rawPath)) {
            Remove-Item -LiteralPath $rawPath -Force
        }
    }

    $smoke = $null
    $smokeJsonValid = $false
    try {
        $smoke = $smokeOutput | ConvertFrom-Json -ErrorAction Stop
        $smokeJsonValid = $true
    } catch {
        $smokeJsonValid = $false
    }
    $replyContextReady = $false
    if ($smokeJsonValid -and $smoke.quality -and $null -ne $smoke.quality.replyContextReady) {
        $replyContextReady = [bool]$smoke.quality.replyContextReady
    }
    $contextPayloadUsable = $false
    if ($smokeJsonValid -and $smoke.quality -and $null -ne $smoke.quality.contextPayloadUsable) {
        $contextPayloadUsable = [bool]$smoke.quality.contextPayloadUsable
    }

    $promptSmokePath = Join-Path $TargetDir "promptSmoke.json"
    if ($smokeJsonValid) {
        Write-Utf8NoBomAtomic -Path $promptSmokePath `
            -Value ($smoke | ConvertTo-Json -Depth 8)
    }

    $status = "capture_or_prompt_json_error"
    if ($sidecarExit -eq 0 -and $rawJsonValid -and $smokeExit -eq 0 -and $smokeJsonValid) {
        $status = if ($replyContextReady) {
            "captured_reply_ready_prompt_json"
        } elseif ($contextPayloadUsable) {
            "captured_context_payload_json_quality_warning"
        } else {
            "captured_valid_prompt_json_quality_warning"
        }
    }

    [pscustomobject]@{
        status = $status
        sidecarExit = $sidecarExit
        rawJsonValid = $rawJsonValid
        rawChars = if ($raw) { $raw.Length } else { 0 }
        smokeExit = $smokeExit
        promptSmokeJsonValid = $smokeJsonValid
        replyContextReady = $replyContextReady
        contextPayloadUsable = $contextPayloadUsable
        promptSmokePath = if ($smokeJsonValid) { $promptSmokePath } else { $null }
        prompt = $smoke
    }
}

function New-PromptSummary($Smoke) {
    if ($null -eq $Smoke) {
        return $null
    }

    $quality = $null
    if ($Smoke.quality) {
        $quality = [pscustomobject]@{
            contextPayloadUsable = $Smoke.quality.contextPayloadUsable
            replyContextReady = $Smoke.quality.replyContextReady
            focusedFieldLooksComposer = $Smoke.quality.focusedFieldLooksComposer
            focusMissLike = $Smoke.quality.focusMissLike
            multiSpeakerContext = $Smoke.quality.multiSpeakerContext
            warnings = @($Smoke.quality.warnings)
        }
    }

    $source = $null
    if ($Smoke.source) {
        $source = [pscustomobject]@{
            app = $Smoke.source.app
            url = $Smoke.source.url
            window = $Smoke.source.window
        }
    }

    [pscustomobject]@{
        label = $Smoke.label
        promptJsonValid = $Smoke.promptJsonValid
        promptKeys = @($Smoke.promptKeys)
        fieldChars = $Smoke.fieldChars
        lineCounts = $Smoke.lineCounts
        privacySignals = $Smoke.privacySignals
        quality = $quality
        source = $source
    }
}

$targetSpecs = @{
    "gmail" = @{ pattern = "Gmail|mail\.google\.com" }
    "discord" = @{ pattern = "Discord|discord\.com" }
    "codex" = @{ pattern = "Codex|ChatGPT|chatgpt\.com" }
    "claude" = @{ pattern = "Claude|claude\.ai" }
    "facebook-main" = @{ pattern = "\bFacebook\b|facebook\.com"; exclude = "Messenger|Messages|facebook\.com/messages|messenger\.com" }
    "facebook-messenger" = @{ pattern = "Messenger|messages/t|messenger\.com|facebook\.com/messages" }
    "whatsapp" = @{ pattern = "WhatsApp|web\.whatsapp\.com" }
    "x" = @{ pattern = "Home / X|^X$|x\.com" }
    "slack" = @{ pattern = "Slack|app\.slack\.com" }
}

function Get-ChromeWindows {
    $chromeProcesses = @(Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
    $windows = @()
    foreach ($process in $chromeProcesses) {
        $windows += [pscustomobject]@{
            hwnd = $process.MainWindowHandle.ToInt64().ToString()
            processId = $process.Id
            title = Sanitize-Text $process.MainWindowTitle
            handle = $process.MainWindowHandle
        }
    }
    return $windows
}

function Invoke-Scan([int]$Pass, [hashtable]$Captured, [hashtable]$WarningAttempts) {
    $windows = @(Get-ChromeWindows)
    $results = @()
    $tabInventory = @()

    foreach ($window in $windows) {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($window.handle)
        $tabs = @(Get-TabItems $root)
        $selectedTabs = @($tabs | Where-Object { $_.selected } | ForEach-Object { $_.sanitizedName })
        $tabInventory += [pscustomObject]@{
            hwnd = $window.hwnd
            title = $window.title
            selectedTabs = $selectedTabs
            tabs = @($tabs | ForEach-Object { [pscustomobject]@{ index = $_.index; name = $_.sanitizedName; selected = $_.selected } })
        }

        foreach ($target in $Targets) {
            $key = "$target`:$($window.hwnd)"
            if ($Captured.ContainsKey($key)) {
                $results += [pscustomobject]@{
                    pass = $Pass
                    target = $target
                    hwnd = $window.hwnd
                    status = "already_captured"
                    matchedTab = $Captured[$key]
                }
                continue
            }

            if (-not $targetSpecs.ContainsKey($target)) {
                $results += [pscustomobject]@{
                    pass = $Pass
                    target = $target
                    hwnd = $window.hwnd
                    status = "unknown_target"
                }
                continue
            }

            $spec = $targetSpecs[$target]
            $pattern = $spec.pattern
            $excludePattern = if ($spec.ContainsKey("exclude")) { $spec.exclude } else { "" }
            $matches = @($tabs | Where-Object {
                $_.name -match $pattern -and (
                    [string]::IsNullOrWhiteSpace($excludePattern) -or $_.name -notmatch $excludePattern
                )
            })
            if ($matches.Count -eq 0) {
                $results += [pscustomobject]@{
                    pass = $Pass
                    target = $target
                    hwnd = $window.hwnd
                    status = "not_visible_in_chrome_tabs"
                }
                continue
            }

            $selectedMatch = @($matches | Where-Object { $_.selected } | Select-Object -First 1)
            $match = if ($selectedMatch.Count -gt 0) { $selectedMatch[0] } else { $matches[0] }
            $targetDir = Join-Path $OutDir ($target + "-" + $window.hwnd)
            $warning = $WarningAttempts[$key]
            if ($null -ne $warning -and $WarningRetryPasses -gt 0) {
                $lastPass = [int]$warning.lastPass
                if (($Pass - $lastPass) -lt $WarningRetryPasses) {
                    $results += [pscustomobject]@{
                        pass = $Pass
                        target = $target
                        hwnd = $window.hwnd
                        status = "awaiting_reply_ready_focus"
                        matchedTab = $match.sanitizedName
                        lastStatus = $warning.status
                        lastPass = $lastPass
                        retryAfterPass = $lastPass + $WarningRetryPasses
                    }
                    continue
                }
            }

            if ($selectedMatch.Count -eq 0 -and -not $AllowTabSwitch) {
                $results += [pscustomobject]@{
                    pass = $Pass
                    target = $target
                    hwnd = $window.hwnd
                    status = "visible_but_not_selected"
                    matchedTab = $match.sanitizedName
                    selectedTabs = $selectedTabs
                    note = "Skipped to avoid selecting a Chrome tab or changing foreground state."
                }
                continue
            }

            if ($selectedMatch.Count -eq 0 -and $AllowTabSwitch) {
                Select-TabItem $match
                Start-Sleep -Milliseconds 2000
            }

            $capture = Invoke-Capture -Window $window -Label $target -TargetDir $targetDir
            if ($capture.status -eq "captured_reply_ready_prompt_json") {
                $Captured[$key] = $match.sanitizedName
                if ($WarningAttempts.ContainsKey($key)) {
                    $WarningAttempts.Remove($key)
                }
            } elseif ($capture.status -like "captured_*_quality_warning") {
                $WarningAttempts[$key] = [pscustomobject]@{
                    lastPass = $Pass
                    status = $capture.status
                }
            }
            $results += [pscustomobject]@{
                pass = $Pass
                target = $target
                hwnd = $window.hwnd
                status = $capture.status
                matchedTab = $match.sanitizedName
                tabWasSelected = ($selectedMatch.Count -gt 0)
                tabSwitchAllowed = [bool]$AllowTabSwitch
                sidecarExit = $capture.sidecarExit
                rawJsonValid = $capture.rawJsonValid
                rawChars = $capture.rawChars
                smokeExit = $capture.smokeExit
                promptSmokeJsonValid = $capture.promptSmokeJsonValid
                replyContextReady = $capture.replyContextReady
                contextPayloadUsable = $capture.contextPayloadUsable
                promptSmokePath = $capture.promptSmokePath
                prompt = New-PromptSummary $capture.prompt
            }
        }
    }

    [pscustomobject]@{
        chromeWindows = $windows
        tabInventory = $tabInventory
        results = $results
    }
}

function Get-TargetAudit($Results, [string[]]$Required) {
    $items = @()
    foreach ($target in $Required) {
        $targetResults = @($Results | Where-Object { $_.target -eq $target })
        $readyResults = @($targetResults | Where-Object {
            $_.status -eq "captured_reply_ready_prompt_json" -or $_.status -eq "already_captured"
        })
        $last = if ($targetResults.Count -gt 0) { $targetResults[-1] } else { $null }
        $evidence = if ($readyResults.Count -gt 0) { $readyResults[-1] } else { $null }
        $items += [pscustomobject]@{
            target = $target
            required = $true
            replyReadyConfirmed = ($readyResults.Count -gt 0)
            proofStatus = if ($readyResults.Count -gt 0) { "confirmed_reply_ready" } else { "not_confirmed" }
            evidencePass = if ($evidence) { $evidence.pass } else { $null }
            evidenceStatus = if ($evidence) { $evidence.status } else { $null }
            lastPass = if ($last) { $last.pass } else { $null }
            lastStatus = if ($last) { $last.status } else { "not_seen" }
            matchedTab = if ($last) { $last.matchedTab } else { $null }
            replyContextReady = if ($last -and $null -ne $last.replyContextReady) { $last.replyContextReady } else { $null }
            contextPayloadUsable = if ($last -and $null -ne $last.contextPayloadUsable) { $last.contextPayloadUsable } else { $null }
        }
    }
    $ready = @($items | Where-Object { $_.replyReadyConfirmed })
    [pscustomobject]@{
        complete = ($Required.Count -gt 0 -and $ready.Count -eq $Required.Count)
        readyCount = $ready.Count
        requiredCount = $Required.Count
        requiredTargets = $Required
        missingTargets = @($items | Where-Object { -not $_.replyReadyConfirmed } | ForEach-Object { $_.target })
        items = $items
    }
}

function New-SummaryObject(
    $ForegroundBefore,
    $ForegroundAfter,
    $ChromeWindows,
    $TabInventory,
    $Results,
    [int]$ScanPasses
) {
    $resultTailCount = 500
    [pscustomobject]@{
        generatedAt = (Get-Date).ToString("o")
        mode = if ($AllowTabSwitch) { "allow-tab-switch" } elseif ($WatchSeconds -gt 0) { "no-tab-switch-watch" } else { "no-tab-switch" }
        watchSeconds = $WatchSeconds
        pollSeconds = $PollSeconds
        warningRetryPasses = $WarningRetryPasses
        scanPasses = $ScanPasses
        keepRaw = [bool]$KeepRaw
        stopWhenRequiredReady = [bool]$StopWhenRequiredReady
        foregroundBefore = $ForegroundBefore
        foregroundAfter = $ForegroundAfter
        chromeWindows = $ChromeWindows
        tabInventory = $TabInventory
        targetAudit = Get-TargetAudit -Results $Results -Required $RequiredTargets
        resultCount = @($Results).Count
        resultTailCount = $resultTailCount
        results = @($Results | Select-Object -Last $resultTailCount)
    }
}

$foregroundBefore = Get-ForegroundInfo
$captured = @{}
$warningAttempts = @{}
$allResults = @()
$lastChromeWindows = @()
$lastTabInventory = @()
$pass = 0
$deadline = if ($WatchSeconds -gt 0) { (Get-Date).AddSeconds($WatchSeconds) } else { Get-Date }
$summaryPath = Join-Path $OutDir "summary.json"

while ($true) {
    $scan = Invoke-Scan -Pass $pass -Captured $captured -WarningAttempts $warningAttempts
    $lastChromeWindows = $scan.chromeWindows
    $lastTabInventory = $scan.tabInventory
    $allResults += $scan.results
    $currentForeground = Get-ForegroundInfo
    $interimSummary = New-SummaryObject `
        -ForegroundBefore $foregroundBefore `
        -ForegroundAfter $currentForeground `
        -ChromeWindows $lastChromeWindows `
        -TabInventory $lastTabInventory `
        -Results $allResults `
        -ScanPasses ($pass + 1)
    Write-Utf8NoBomAtomic -Path $summaryPath -Value ($interimSummary | ConvertTo-Json -Depth 12)
    if ($StopWhenRequiredReady -and $interimSummary.targetAudit.complete) {
        break
    }
    if ($WatchSeconds -le 0 -or (Get-Date) -ge $deadline) {
        break
    }
    Start-Sleep -Seconds ([Math]::Max(1, $PollSeconds))
    $pass += 1
}

$foregroundAfter = Get-ForegroundInfo
$summary = New-SummaryObject `
    -ForegroundBefore $foregroundBefore `
    -ForegroundAfter $foregroundAfter `
    -ChromeWindows $lastChromeWindows `
    -TabInventory $lastTabInventory `
    -Results $allResults `
    -ScanPasses ($pass + 1)
Write-Utf8NoBomAtomic -Path $summaryPath -Value ($summary | ConvertTo-Json -Depth 12)
Write-Output "Wrote $summaryPath"
Write-Output ($summary.targetAudit | ConvertTo-Json -Depth 8)
