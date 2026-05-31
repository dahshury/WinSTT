param([int]$Seconds = 3)

$pids = 170284,41028,80960,53548,198032,203612,188560,220344,253456,147060,51300,260572,110064,222684,113100,10148
$cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors

$snap1 = @{}
foreach ($p in $pids) {
  $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
  if ($proc) { $snap1[$p] = $proc.CPU }
}
$t0 = Get-Date
Start-Sleep -Seconds $Seconds
$t1 = Get-Date
$dt = ($t1 - $t0).TotalSeconds

$rows = @()
foreach ($p in $pids) {
  $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
  if (-not $proc) { continue }
  if (-not $snap1.ContainsKey($p)) { continue }
  $dc = $proc.CPU - $snap1[$p]
  $pct1 = [math]::Round($dc / $dt * 100,1)
  $pctTotal = [math]::Round($dc / $dt * 100 / $cores,1)
  $rows += [pscustomobject]@{
    PID = $p
    Name = $proc.ProcessName
    'CPU%(1core)' = $pct1
    'CPU%(machine)' = $pctTotal
    'WS_MB' = [math]::Round($proc.WorkingSet64/1MB,1)
  }
}
$rows | Sort-Object 'CPU%(1core)' -Descending | Format-Table -AutoSize
Write-Host "Cores: $cores  Window: ${dt}s"
