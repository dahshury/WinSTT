# Headless UI-hang probe for WinSTT.
#
# The reported failure is: record a couple of times with the main window open, then interact
# with the window and the whole app freezes until it is killed. The cause is main-thread
# starvation -- Tauri runs SYNCHRONOUS commands on the UI thread, so any command that waits on
# an audio lock parks the window for as long as the audio work holds it, and a Bluetooth
# teardown holds it for seconds.
#
# This script measures that directly, without a debugger and without a human clicking:
#
#   1. Finds WinSTT's window and pings its UI thread with SendMessageTimeout(WM_NULL) every
#      ~50 ms, recording how long each ping takes. That round-trip IS the definition of a
#      responsive window: it only completes when the thread reaches its message loop.
#   2. Drives real recordings through the app's own CLI toggle (--toggle-transcription,
#      delivered to the running instance by the single-instance plugin), so the recording
#      start and the post-recording microphone teardown run exactly as in normal use.
#      Synthetic keystrokes deliberately CANNOT drive this: the push-to-talk hook ignores
#      LLKHF_INJECTED input (see shortcut/modifier_combo.rs), so a keybd_event-based driver
#      silently records nothing and makes this probe pass without testing anything.
#   3. Reports the worst ping latency, which is the longest the UI was frozen.
#
# Recordings are deliberately silent, so nothing is transcribed and nothing is pasted.
#
#     .\tools\windows\measure-ui-responsiveness.ps1 -Takes 3 -HoldSeconds 2

[CmdletBinding()]
param(
    [int]$Takes = 3,
    [double]$HoldSeconds = 2.0,
    [double]$GapSeconds = 6.0,
    # Latency above which the window counts as visibly stalled to a user.
    [int]$StallThresholdMs = 400
)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace UiProbe -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);

'@

$WM_NULL = 0x0000
$SMTO_NORMAL = 0x0000

function Get-WinsttWindow {
    $proc = Get-Process -Name WinSTT, winstt -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
        Select-Object -First 1
    if (-not $proc) { throw "No WinSTT process with a visible main window. Open the main window first." }
    return $proc
}

# One WM_NULL round-trip. Returns elapsed milliseconds; the timeout value on failure, which is
# what a genuinely wedged UI thread produces.
function Measure-Ping {
    param([IntPtr]$Hwnd, [uint32]$TimeoutMs)
    $result = [UIntPtr]::Zero
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $ret = [UiProbe.Native]::SendMessageTimeout($Hwnd, $WM_NULL, [UIntPtr]::Zero, [IntPtr]::Zero, $SMTO_NORMAL, $TimeoutMs, [ref]$result)
    $sw.Stop()
    return [pscustomobject]@{
        ElapsedMs = $sw.Elapsed.TotalMilliseconds
        TimedOut  = ($ret -eq [IntPtr]::Zero)
    }
}

$proc = Get-WinsttWindow
$hwnd = $proc.MainWindowHandle
Write-Host "Probing WinSTT pid=$($proc.Id) hwnd=$hwnd"
Write-Host "Baseline (no recording):"

$samples = New-Object System.Collections.Generic.List[double]
for ($i = 0; $i -lt 20; $i++) {
    $p = Measure-Ping -Hwnd $hwnd -TimeoutMs 10000
    $samples.Add($p.ElapsedMs)
    Start-Sleep -Milliseconds 50
}
$baseline = ($samples | Measure-Object -Maximum).Maximum
Write-Host ("  worst baseline ping = {0:N1}ms" -f $baseline)

# The recording loop runs on a background runspace so the pinging stays evenly spaced and is
# never blocked by the sleeps between takes.
$driver = [powershell]::Create()
$null = $driver.AddScript({
        param($Takes, $Hold, $Gap, $Exe)
        Start-Sleep -Seconds 1
        for ($t = 1; $t -le $Takes; $t++) {
            # First toggle starts the recording, second stops it. Each invocation is a short
            # lived process that the single-instance plugin forwards to the running app.
            Start-Process -FilePath $Exe -ArgumentList '--toggle-transcription' -WindowStyle Hidden | Out-Null
            Start-Sleep -Milliseconds ([int]($Hold * 1000))
            Start-Process -FilePath $Exe -ArgumentList '--toggle-transcription' -WindowStyle Hidden | Out-Null
            Start-Sleep -Seconds $Gap
        }
    }).AddArgument($Takes).AddArgument($HoldSeconds).AddArgument($GapSeconds).AddArgument($proc.Path)
$handle = $driver.BeginInvoke()

$totalSeconds = 1 + $Takes * ($HoldSeconds + $GapSeconds) + 3
Write-Host ("Driving {0} recording(s) while probing for {1:N0}s..." -f $Takes, $totalSeconds)

$worst = 0.0
$worstAt = 0.0
$stalls = New-Object System.Collections.Generic.List[string]
$timeouts = 0
$run = [Diagnostics.Stopwatch]::StartNew()
while ($run.Elapsed.TotalSeconds -lt $totalSeconds) {
    $p = Measure-Ping -Hwnd $hwnd -TimeoutMs 30000
    if ($p.TimedOut) { $timeouts++ }
    if ($p.ElapsedMs -gt $worst) {
        $worst = $p.ElapsedMs
        $worstAt = $run.Elapsed.TotalSeconds
    }
    if ($p.ElapsedMs -ge $StallThresholdMs) {
        $stalls.Add(("    t={0:N1}s stalled {1:N0}ms" -f $run.Elapsed.TotalSeconds, $p.ElapsedMs))
    }
    Start-Sleep -Milliseconds 50
}
$null = $driver.EndInvoke($handle)
$driver.Dispose()

Write-Host ""
Write-Host "RESULTS"
Write-Host ("  worst UI-thread stall  = {0:N0}ms (at t={1:N1}s)" -f $worst, $worstAt)
Write-Host ("  pings over {0}ms       = {1}" -f $StallThresholdMs, $stalls.Count)
Write-Host ("  hard timeouts (30s)    = {0}" -f $timeouts)
foreach ($s in $stalls) { Write-Host $s }
if ($timeouts -gt 0) {
    Write-Host "  VERDICT: FAIL -- the UI thread stopped responding entirely."
    exit 1
}
if ($worst -ge $StallThresholdMs) {
    Write-Host "  VERDICT: FAIL -- the UI thread stalled long enough to be visible."
    exit 1
}
Write-Host "  VERDICT: PASS -- the window stayed responsive across every recording."
exit 0
