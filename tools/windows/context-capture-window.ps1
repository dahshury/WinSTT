<#
.SYNOPSIS
  One-shot UIA context capture for a single top-level window, found by title regex.

  Unlike context-safe-capture.ps1 (which enumerates Chrome via MainWindowHandle and
  is limited to one window per process), this enumerates ALL visible top-level windows
  via EnumWindows and targets the first whose title matches -TitleMatch. It then runs
  the native UIA sidecar HWND-scoped and pipes the snapshot through context_prompt_smoke.

  Designed to capture a specific browser tab that an automation harness has navigated +
  focused, even while the window is NOT in the foreground (occlusion/focus-proof read).

.EXAMPLE
  pwsh tools/windows/context-capture-window.ps1 -TitleMatch 'Gmail' -Label gmail -KeepRaw
#>
param(
    [Parameter(Mandatory = $true)][string]$TitleMatch,
    [Parameter(Mandatory = $true)][string]$Label,
    [string]$ExeMatch = "chrome",
    [string]$OutDir = "",
    [switch]$KeepRaw,
    [switch]$Json
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$sidecar = Join-Path $repoRoot "examples\winstt-electron\frontend\electron\native\bin\winstt-context.exe"
$smokeExe = Join-Path $repoRoot "src-tauri\target\debug\context_prompt_smoke.exe"

if (-not (Test-Path $sidecar)) { throw "Native context helper not found: $sidecar" }
if (-not (Test-Path $smokeExe)) { throw "Prompt smoke exe not found (build it first): $smokeExe" }

if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $OutDir = Join-Path $repoRoot "artifacts\context-capture\$Label"
}
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$pinvoke = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class WinEnum {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public static List<object[]> List() {
    var rows = new List<object[]>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len <= 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      uint pid; GetWindowThreadProcessId(h, out pid);
      rows.Add(new object[] { h.ToInt64(), sb.ToString(), pid });
      return true;
    }, IntPtr.Zero);
    return rows;
  }
}
'@
Add-Type -TypeDefinition $pinvoke | Out-Null

function Sanitize([string]$v) {
    if ($null -eq $v) { return "" }
    return (($v -replace '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[email]') -replace '\s+', ' ').Trim()
}

$windows = @()
foreach ($row in [WinEnum]::List()) {
    $hwnd = [int64]$row[0]
    $title = [string]$row[1]
    $procId = [uint32]$row[2]
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    $procName = if ($proc) { $proc.ProcessName } else { "" }
    if ($title -notmatch $TitleMatch) { continue }
    if (-not [string]::IsNullOrWhiteSpace($ExeMatch) -and $procName -notmatch $ExeMatch) { continue }
    $windows += [pscustomobject]@{ hwnd = $hwnd; title = $title; sanitizedTitle = Sanitize $title; process = $procName; pid = $procId }
}

if ($windows.Count -eq 0) {
    Write-Error "No visible window matched title /$TitleMatch/ (exe /$ExeMatch/)."
    exit 2
}

$target = $windows[0]
$raw = & $sidecar --tree --hwnd $target.hwnd
$sidecarExit = $LASTEXITCODE

$rawPath = Join-Path $OutDir "rawSnapshot.json"
$enc = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($rawPath, $raw, $enc)

$smokeOutput = $raw | & $smokeExe --label $Label --require-prompt-json
$smokeExit = $LASTEXITCODE
$smokePath = Join-Path $OutDir "promptSmoke.json"
[System.IO.File]::WriteAllText($smokePath, $smokeOutput, $enc)

if (-not $KeepRaw -and (Test-Path $rawPath)) { Remove-Item -LiteralPath $rawPath -Force }

$smoke = $null
try { $smoke = $smokeOutput | ConvertFrom-Json -ErrorAction Stop } catch {}

$result = [pscustomobject]@{
    label              = $Label
    matchedWindow      = $target.sanitizedTitle
    matchedHwnd        = $target.hwnd
    candidateCount     = $windows.Count
    sidecarExit        = $sidecarExit
    smokeExit          = $smokeExit
    rawChars           = if ($raw) { $raw.Length } else { 0 }
    replyContextReady  = if ($smoke) { $smoke.quality.replyContextReady } else { $null }
    contextPayloadUsable = if ($smoke) { $smoke.quality.contextPayloadUsable } else { $null }
    focusedFieldLooksComposer = if ($smoke) { $smoke.quality.focusedFieldLooksComposer } else { $null }
    focusMissLike      = if ($smoke) { $smoke.quality.focusMissLike } else { $null }
    multiSpeakerContext = if ($smoke) { $smoke.quality.multiSpeakerContext } else { $null }
    promptKeys         = if ($smoke) { @($smoke.promptKeys) } else { @() }
    fieldChars         = if ($smoke) { $smoke.fieldChars } else { $null }
    lineCounts         = if ($smoke) { $smoke.lineCounts } else { $null }
    privacySignals     = if ($smoke) { $smoke.privacySignals } else { $null }
    warnings           = if ($smoke) { @($smoke.quality.warnings) } else { @() }
    source             = if ($smoke) { $smoke.source } else { $null }
    smokePath          = $smokePath
}

if ($Json) {
    $result | ConvertTo-Json -Depth 8
} else {
    Write-Output ("window:   {0}  (hwnd {1}, {2} candidate(s))" -f $result.matchedWindow, $result.matchedHwnd, $result.candidateCount)
    Write-Output ("exits:    sidecar={0} smoke={1}  rawChars={2}" -f $result.sidecarExit, $result.smokeExit, $result.rawChars)
    Write-Output ("verdict:  replyContextReady={0}  contextPayloadUsable={1}  composer={2}  focusMiss={3}  multiSpeaker={4}" -f `
        $result.replyContextReady, $result.contextPayloadUsable, $result.focusedFieldLooksComposer, $result.focusMissLike, $result.multiSpeakerContext)
    Write-Output ("keys:     {0}" -f ($result.promptKeys -join ', '))
    Write-Output ("warnings: {0}" -f ($result.warnings -join ', '))
    Write-Output ("smoke:    {0}" -f $result.smokePath)
}
