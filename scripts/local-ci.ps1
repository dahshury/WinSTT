<#
.SYNOPSIS
    Run the WinSTT CI pipeline locally on Windows.

.DESCRIPTION
    Mirrors the GitHub Actions pipeline (.github/workflows/ci.yml) so you can
    catch typecheck / lint / FSD / test / coverage regressions before pushing.

    Frontend steps (in frontend/):
        bun install --frozen-lockfile
        bun typecheck
        bun lint
        bun run check:fsd
        bun test --coverage                # soft-fail -- Electron-mock tests are flaky locally
        bun run coverage:gate              # soft-fail -- CI enforces this as a hard gate

    Server steps (in server/):
        uv sync --group dev --extra cpu    # CPU extra -- script runs without CUDA
        uv run ruff check .
        uv run ruff format --check .
        uv run pytest --cov-fail-under=99  # lenient gate (matches CI)

    Exit code 0 if every HARD step passes. Exit code 1 if any HARD step fails.
    The frontend `bun test` step is treated as SOFT -- its pass/fail is reported
    but does not influence the exit code, because the electron-mock harness
    has long-running local flakiness (see memory/project_relay_test_preexisting_fail.md).

.PARAMETER WhatIf
    Print the steps that would run without executing them.

.PARAMETER SkipFrontend
    Skip the frontend section entirely (useful when iterating on the server).

.PARAMETER SkipServer
    Skip the server section entirely (useful when iterating on the frontend).

.EXAMPLE
    pwsh ./scripts/local-ci.ps1

.EXAMPLE
    pwsh ./scripts/local-ci.ps1 -WhatIf

.EXAMPLE
    pwsh ./scripts/local-ci.ps1 -SkipServer
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch] $SkipFrontend,
    [switch] $SkipServer
)

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

$ErrorActionPreference = "Continue"
$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:FrontendDir = Join-Path $script:RepoRoot "frontend"
$script:ServerDir = Join-Path $script:RepoRoot "server"

# Tracks every step's outcome so we can emit a summary at the end.
$script:Results = New-Object System.Collections.Generic.List[pscustomobject]
$script:HardFailures = 0

function Write-Banner {
    param([string] $Text)
    $border = "=" * 72
    Write-Host ""
    Write-Host $border -ForegroundColor Cyan
    Write-Host (" " + $Text) -ForegroundColor Cyan
    Write-Host $border -ForegroundColor Cyan
}

function Write-Section {
    param([string] $Text)
    Write-Host ""
    Write-Host (">>> " + $Text) -ForegroundColor Yellow
}

function Invoke-Step {
    <#
    .SYNOPSIS
        Run a CI step, record its outcome, and respect -WhatIf / -Soft.
    #>
    param(
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [string] $Command,
        [string] $WorkingDirectory = $script:RepoRoot,
        [switch] $Soft
    )

    $kind = if ($Soft) { "soft" } else { "hard" }
    Write-Section "[$kind] $Name :: $Command"

    if ($PSCmdlet.ShouldProcess($Name, "run '$Command' in '$WorkingDirectory'") -eq $false) {
        $script:Results.Add([pscustomobject]@{
            Name    = $Name
            Kind    = $kind
            Result  = "skipped (WhatIf)"
            Color   = "DarkGray"
        })
        return
    }

    Push-Location -LiteralPath $WorkingDirectory
    try {
        # cmd.exe-style invocation so '&&', tools-on-PATH, etc. behave as written.
        & cmd.exe /c $Command
        $code = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }

    if ($code -eq 0) {
        $script:Results.Add([pscustomobject]@{
            Name   = $Name
            Kind   = $kind
            Result = "ok"
            Color  = "Green"
        })
        Write-Host "    -> ok" -ForegroundColor Green
        return
    }

    if ($Soft) {
        $script:Results.Add([pscustomobject]@{
            Name   = $Name
            Kind   = $kind
            Result = "soft-fail (exit $code, not gating)"
            Color  = "DarkYellow"
        })
        Write-Host "    -> soft-fail (exit $code) -- not gating" -ForegroundColor DarkYellow
        return
    }

    $script:HardFailures++
    $script:Results.Add([pscustomobject]@{
        Name   = $Name
        Kind   = $kind
        Result = "FAIL (exit $code)"
        Color  = "Red"
    })
    Write-Host "    -> FAIL (exit $code)" -ForegroundColor Red
}

function Test-CommandExists {
    param([string] $Name)
    $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------

Write-Banner "WinSTT local CI"
Write-Host "Repo root      : $script:RepoRoot"
Write-Host "Frontend dir   : $script:FrontendDir"
Write-Host "Server dir     : $script:ServerDir"
Write-Host "WhatIf mode    : $($WhatIfPreference -eq 'Stop' -or $PSBoundParameters.ContainsKey('WhatIf'))"
Write-Host "Skip frontend  : $SkipFrontend"
Write-Host "Skip server    : $SkipServer"

# ---------------------------------------------------------------------------
# Pre-flight: required toolchains
# ---------------------------------------------------------------------------

Write-Banner "Pre-flight checks"

$missing = @()
if (-not $SkipFrontend -and -not (Test-CommandExists "bun")) {
    $missing += "bun (https://bun.sh)"
}
if (-not $SkipServer -and -not (Test-CommandExists "uv")) {
    $missing += "uv (https://github.com/astral-sh/uv)"
}

if ($missing.Count -gt 0) {
    foreach ($m in $missing) {
        Write-Host "Missing required tool: $m" -ForegroundColor Red
    }
    Write-Host "Install the missing tool(s) and retry." -ForegroundColor Red
    exit 1
}

Write-Host "All required toolchains are on PATH." -ForegroundColor Green

# ---------------------------------------------------------------------------
# Frontend
# ---------------------------------------------------------------------------

if ($SkipFrontend) {
    Write-Banner "Frontend (skipped)"
}
else {
    Write-Banner "Frontend"

    if (-not (Test-Path -LiteralPath $script:FrontendDir)) {
        Write-Host "Frontend directory not found at $script:FrontendDir" -ForegroundColor Red
        $script:HardFailures++
    }
    else {
        Invoke-Step -Name "frontend:install" `
            -Command "bun install --frozen-lockfile" `
            -WorkingDirectory $script:FrontendDir

        Invoke-Step -Name "frontend:typecheck" `
            -Command "bun typecheck" `
            -WorkingDirectory $script:FrontendDir

        Invoke-Step -Name "frontend:lint" `
            -Command "bun lint" `
            -WorkingDirectory $script:FrontendDir

        Invoke-Step -Name "frontend:check:fsd" `
            -Command "bun run check:fsd" `
            -WorkingDirectory $script:FrontendDir

        # Soft -- see header docstring (Electron-mock harness flakiness).
        # Run with --coverage so the coverage-gate step below has fresh lcov.
        Invoke-Step -Name "frontend:test" `
            -Command "bun test --coverage" `
            -WorkingDirectory $script:FrontendDir `
            -Soft

        # Coverage regression gate -- soft because local-ci is lenient by design.
        # CI enforces this as a HARD gate; here it's informational so a developer
        # working on a slice with deliberately thin coverage isn't blocked locally.
        Invoke-Step -Name "frontend:coverage:gate" `
            -Command "bun run coverage:gate" `
            -WorkingDirectory $script:FrontendDir `
            -Soft
    }
}

# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------

if ($SkipServer) {
    Write-Banner "Server (skipped)"
}
else {
    Write-Banner "Server"

    if (-not (Test-Path -LiteralPath $script:ServerDir)) {
        Write-Host "Server directory not found at $script:ServerDir" -ForegroundColor Red
        $script:HardFailures++
    }
    else {
        # Use the CPU extra -- local-ci should run on machines without CUDA.
        Invoke-Step -Name "server:install" `
            -Command "uv sync --group dev --extra cpu" `
            -WorkingDirectory $script:ServerDir

        Invoke-Step -Name "server:ruff:check" `
            -Command "uv run ruff check ." `
            -WorkingDirectory $script:ServerDir

        Invoke-Step -Name "server:ruff:format" `
            -Command "uv run ruff format --check ." `
            -WorkingDirectory $script:ServerDir

        # 99% gate instead of the 100% local gate -- matches CI; see
        # memory/project_server_coverage_preexisting_gap.md.
        # Pytest also writes a fresh JSON coverage report into
        # server/reports/crap-coverage.json so the CRAP analyzer below
        # can reuse it via --skip-coverage (avoids a second test run).
        Invoke-Step -Name "server:pytest" `
            -Command "uv run pytest --tb=short --cov-fail-under=99 --cov-report=json:reports/crap-coverage.json" `
            -WorkingDirectory $script:ServerDir

        # CRAP analyzer -- cyclomatic-complexity x inverse-coverage score
        # per function. Mirrors the frontend's `bun run scripts/crap.ts`
        # step. Treated as SOFT: the score is informational; CI uploads
        # the report but doesn't block on it. --skip-coverage reuses the
        # JSON we just produced.
        Invoke-Step -Name "server:crap" `
            -Command "uv run python scripts/crap.py --skip-coverage" `
            -WorkingDirectory $script:ServerDir `
            -Soft
    }
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

Write-Banner "Summary"

if ($script:Results.Count -eq 0) {
    Write-Host "No steps ran." -ForegroundColor DarkYellow
    exit 0
}

$nameWidth = ($script:Results | ForEach-Object { $_.Name.Length } | Measure-Object -Maximum).Maximum
foreach ($r in $script:Results) {
    $padded = $r.Name.PadRight($nameWidth)
    $kind = $r.Kind.PadRight(4)
    Write-Host ("  {0}  [{1}]  {2}" -f $padded, $kind, $r.Result) -ForegroundColor $r.Color
}

$hard = ($script:Results | Where-Object { $_.Kind -eq "hard" -and $_.Result -like "FAIL*" }).Count
$soft = ($script:Results | Where-Object { $_.Kind -eq "soft" -and $_.Result -like "soft-fail*" }).Count
$ok   = ($script:Results | Where-Object { $_.Result -eq "ok" }).Count

Write-Host ""
Write-Host "  ok          : $ok"   -ForegroundColor Green
Write-Host "  soft-fail   : $soft" -ForegroundColor DarkYellow
Write-Host "  hard-fail   : $hard" -ForegroundColor Red
Write-Host ""

if ($script:HardFailures -gt 0) {
    Write-Host "Local CI FAILED ($script:HardFailures hard failure(s))." -ForegroundColor Red
    exit 1
}

Write-Host "Local CI PASSED." -ForegroundColor Green
exit 0
