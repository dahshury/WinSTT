$f = 'C:\Users\MASTE\AppData\Roaming\winstt\winstt-settings.json'
$j = Get-Content -Path $f -Raw | ConvertFrom-Json
Write-Host "before: $($j.model.model)"
$j.model.model = 'nemo-canary-180m-flash'
($j | ConvertTo-Json -Depth 50) | Set-Content -Path $f -Encoding UTF8 -NoNewline
$after = (Get-Content -Path $f -Raw | ConvertFrom-Json).model.model
Write-Host "after:  $after"
