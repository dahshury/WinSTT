param(
	[string]$Base = "http://127.0.0.1:4173",
	[int]$Port = 4173,
	[int]$Runs = 9,
	[int]$Warmup = 2,
	[double]$Budget = 50,
	[switch]$Json
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$bun = (Get-Command bun).Source
$node = (Get-Command node).Source
$measureScript = Join-Path $repoRoot "tools\perf\measure-page-load.mjs"

$existing = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
if ($existing) {
	throw "Port $Port is already in use. Stop the existing server or pass a different -Port/-Base pair."
}

$job = Start-Job -Name "winstt-page-load-preview" -ArgumentList $repoRoot, $bun, $Port -ScriptBlock {
	param($repoRoot, $bun, $port)
	Set-Location $repoRoot
	& $bun run preview -- --host 127.0.0.1 --port $port --strictPort
}

try {
	$deadline = (Get-Date).AddSeconds(30)
	do {
		try {
			$response = Invoke-WebRequest -Uri $Base -UseBasicParsing -TimeoutSec 2
			if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
				break
			}
		} catch {
			Start-Sleep -Milliseconds 250
		}
		if ((Get-Job -Id $job.Id).State -ne "Running") {
			Receive-Job -Id $job.Id
			throw "Preview server exited before it became ready."
		}
	} while ((Get-Date) -lt $deadline)

	if ((Get-Date) -ge $deadline) {
		Receive-Job -Id $job.Id
		throw "Preview server did not become ready within 30 seconds."
	}

	$args = @(
		$measureScript,
		"--base",
		$Base,
		"--runs",
		[string]$Runs,
		"--warmup",
		[string]$Warmup,
		"--budget",
		[string]$Budget
	)
	if ($Json) {
		$args += "--json"
	}

	& $node @args
	if ($LASTEXITCODE -ne 0) {
		exit $LASTEXITCODE
	}
} finally {
	Stop-Job -Id $job.Id -ErrorAction SilentlyContinue
	Remove-Job -Id $job.Id -Force -ErrorAction SilentlyContinue
}
