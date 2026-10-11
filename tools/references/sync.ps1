[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$examples = Join-Path $workspace 'examples'
$repositories = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'repositories.json') -Raw | ConvertFrom-Json
$inventory = @()
New-Item -ItemType Directory -Path $examples -Force | Out-Null

function Invoke-ReferenceGit {
    param([string[]]$Arguments)
    $result = & git @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git failed: $($result -join ' ')" }
    return $result
}

foreach ($reference in $repositories) {
    if ($reference.directory -notmatch '^[A-Za-z][A-Za-z0-9-]*$' -or $reference.repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
        throw 'Unsafe reference identifier'
    }
    $path = [IO.Path]::GetFullPath((Join-Path $examples $reference.directory))
    if (-not $path.StartsWith($examples + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Reference path escaped examples'
    }
    $url = "https://github.com/$($reference.repository).git"
    $action = 'cloned'
    if (-not (Test-Path -LiteralPath $path)) {
        Invoke-ReferenceGit @('-c', 'core.longpaths=true', 'clone', '--depth', '1', '--filter=blob:none', '--quiet', $url, $path) | Out-Null
    } else {
        # A playground/subdirectory inherits the parent's Git root. Require its own .git.
        if (-not (Test-Path -LiteralPath (Join-Path $path '.git'))) { throw "Not a reference checkout: $path" }
        $origin = (Invoke-ReferenceGit @('-C', $path, 'remote', 'get-url', 'origin') | Out-String).Trim()
        if ($origin -ne $url) { throw "Unexpected origin in $path : $origin" }
        Invoke-ReferenceGit @('-C', $path, 'fetch', '--quiet', 'origin') | Out-Null
        $dirty = Invoke-ReferenceGit @('-C', $path, 'status', '--porcelain')
        $branch = (Invoke-ReferenceGit @('-C', $path, 'rev-parse', '--abbrev-ref', 'HEAD') | Out-String).Trim()
        $default = (Invoke-ReferenceGit @('-C', $path, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD') | Out-String).Trim()
        if ($dirty -or "origin/$branch" -ne $default) {
            $action = 'fetched; working checkout preserved'
        } else {
            try {
                Invoke-ReferenceGit @('-C', $path, 'merge', '--ff-only', $default) | Out-Null
                $action = 'updated'
            } catch {
                $action = 'fetched; divergent checkout preserved'
                Write-Warning $_
            }
        }
    }
    $sha = (Invoke-ReferenceGit @('-C', $path, 'rev-parse', 'HEAD') | Out-String).Trim()
    $date = (Invoke-ReferenceGit @('-C', $path, 'log', '-1', '--format=%cI') | Out-String).Trim()
    $inventory += [ordered]@{ directory = $reference.directory; repository = $reference.repository; sha = $sha; commitDate = $date; action = $action; focus = $reference.focus }
    Write-Output "$($reference.directory): $action ($($sha.Substring(0, 12)))"
}
$inventory | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $examples 'reference-inventory.json') -Encoding utf8
