$f = '%APPDATA%\winstt\winstt-settings.json'
# Read raw, strip any UTF-8 BOM, parse.
$raw = [System.IO.File]::ReadAllText($f)
$raw = $raw -replace '^\xEF\xBB\xBF', ''  # printable BOM-strip (defensive)
if ($raw[0] -eq [char]0xFEFF) { $raw = $raw.Substring(1) }
$j = $raw | ConvertFrom-Json
Write-Host "before: $($j.model.model)"
$j.model.model = 'nemo-canary-180m-flash'
# Write WITHOUT BOM. Set-Content -Encoding UTF8 emits BOM on Windows
# PowerShell 5.1 (which is what's on the path here); use the .NET helper
# that writes plain UTF-8.
$bytes = [System.Text.UTF8Encoding]::new($false).GetBytes(($j | ConvertTo-Json -Depth 50))
[System.IO.File]::WriteAllBytes($f, $bytes)
# Verify
$verifyRaw = [System.IO.File]::ReadAllText($f)
if ($verifyRaw[0] -eq [char]0xFEFF) {
    Write-Host "ERROR: BOM still present after write"
    exit 1
}
$after = (ConvertFrom-Json $verifyRaw).model.model
Write-Host "after:  $after"
Write-Host "first byte (hex): $('{0:X2}' -f [byte]([System.IO.File]::ReadAllBytes($f)[0]))"
