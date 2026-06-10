param(
  [int]$Seconds = 180,
  [int]$Interval = 3,
  [string]$LogPath = "<repo>\frontend\.profile\cpu.log"
)

$dir = Split-Path -Parent $LogPath
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
"timestamp`tpid`tname`tcpu_pct_1core`tws_mb`tcmd" | Set-Content -Path $LogPath -Encoding utf8

$cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
$deadline = (Get-Date).AddSeconds($Seconds)

# Track previous CPU readings per PID for delta sampling
$prev = @{}
$prevTime = Get-Date

while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds $Interval
  $now = Get-Date
  $dt = ($now - $prevTime).TotalSeconds
  $prevTime = $now

  # Get all node/electron/bun/esbuild/tsup processes plus their command lines
  $cim = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match '^(node|electron|bun|esbuild|tsup|next)\.exe$' -and
    (($_.CommandLine -match 'WinSTT|next dev|tsup|concurrently|dev-electron|electron-watch|electron/main|electron/preload') -or
     ($_.ExecutablePath -like '*WinSTT*'))
  }
  $byPid = @{}
  foreach ($c in $cim) { $byPid[[int]$c.ProcessId] = $c }

  $procs = Get-Process -Id $byPid.Keys -ErrorAction SilentlyContinue
  foreach ($p in $procs) {
    $cur = $p.CPU
    if ($prev.ContainsKey($p.Id)) {
      $dc = $cur - $prev[$p.Id]
      $pct1 = [math]::Round($dc / $dt * 100, 1)
    } else {
      $pct1 = 0
    }
    $prev[$p.Id] = $cur

    $cm = $byPid[$p.Id]
    $cmd = if ($cm.CommandLine) {
      $s = ($cm.CommandLine -replace "\s+", " ")
      $s.Substring(0, [Math]::Min(140, $s.Length))
    } else { '' }
    $ws = [math]::Round($p.WorkingSet64/1MB, 1)
    "$($now.ToString('HH:mm:ss'))`t$($p.Id)`t$($p.ProcessName)`t$pct1`t$ws`t$cmd" | Add-Content -Path $LogPath -Encoding utf8
  }
}
Write-Host "Done: $LogPath"
