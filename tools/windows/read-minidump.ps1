# Minimal minidump reader -- prints the exception record and the faulting module.
#
# There is no debugger installed on every dev machine, and a WinSTT crash dump under
# %LOCALAPPDATA%\CrashDumps is otherwise opaque. This parses just enough of the MINIDUMP
# format (header -> stream directory -> ExceptionStream + ModuleListStream) to answer the
# only questions that matter first: what was the exception code, at what address, and which
# loaded module owns that address.
#
#     .\tools\windows\read-minidump.ps1 "$env:LOCALAPPDATA\CrashDumps\WinSTT.exe.33508.dmp"

param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = 'Stop'
$bytes = [System.IO.File]::ReadAllBytes($Path)
if ([System.Text.Encoding]::ASCII.GetString($bytes, 0, 4) -ne 'MDMP') {
    throw "$Path is not a minidump (missing MDMP signature)"
}

$streamCount = [BitConverter]::ToUInt32($bytes, 8)
$directoryRva = [BitConverter]::ToUInt32($bytes, 12)

$exceptionRva = 0
$moduleListRva = 0
for ($i = 0; $i -lt $streamCount; $i++) {
    $entry = $directoryRva + ($i * 12)
    $type = [BitConverter]::ToUInt32($bytes, $entry)
    $rva = [BitConverter]::ToUInt32($bytes, $entry + 8)
    switch ($type) {
        4 { $moduleListRva = $rva }   # ModuleListStream
        6 { $exceptionRva = $rva }    # ExceptionStream
    }
}

if ($exceptionRva -eq 0) {
    Write-Output "No exception stream -- this dump was captured on demand (a hang), not from a fault."
} else {
    $threadId = [BitConverter]::ToUInt32($bytes, $exceptionRva)
    $record = $exceptionRva + 8
    $code = [BitConverter]::ToUInt32($bytes, $record)
    $address = [BitConverter]::ToUInt64($bytes, $record + 16)
    $paramCount = [BitConverter]::ToUInt32($bytes, $record + 24)
    $name = switch ("{0:X8}" -f $code) {
        'C0000005' { 'ACCESS_VIOLATION' }
        'C00000FD' { 'STACK_OVERFLOW' }
        '80000003' { 'BREAKPOINT' }
        'C000001D' { 'ILLEGAL_INSTRUCTION' }
        'C0000094' { 'INT_DIVIDE_BY_ZERO' }
        'E06D7363' { 'CPP_EXCEPTION' }
        default    { 'UNKNOWN' }
    }
    Write-Output ("exception=0x{0:X8} ({1}) thread={2} address=0x{3:X16}" -f $code, $name, $threadId, $address)
    if ($name -eq "ACCESS_VIOLATION" -and $paramCount -ge 2) {
        $operation = [BitConverter]::ToUInt64($bytes, $record + 32)
        $target = [BitConverter]::ToUInt64($bytes, $record + 40)
        $kind = switch ($operation) { 0 { 'read' } 1 { 'write' } 8 { 'execute (DEP)' } default { "op$operation" } }
        Write-Output ("  attempted {0} of 0x{1:X16}" -f $kind, $target)
    }
}

if ($moduleListRva -ne 0 -and $address) {
    $moduleCount = [BitConverter]::ToUInt32($bytes, $moduleListRva)
    $owner = $null
    for ($i = 0; $i -lt $moduleCount; $i++) {
        # MINIDUMP_MODULE is 108 bytes; the list starts 4 bytes in (after the count).
        $entry = $moduleListRva + 4 + ($i * 108)
        $base = [BitConverter]::ToUInt64($bytes, $entry)
        $size = [BitConverter]::ToUInt32($bytes, $entry + 8)
        if ($address -ge $base -and $address -lt ($base + $size)) {
            $nameRva = [BitConverter]::ToUInt32($bytes, $entry + 20)
            $nameLength = [BitConverter]::ToUInt32($bytes, $nameRva)
            $moduleName = [System.Text.Encoding]::Unicode.GetString($bytes, $nameRva + 4, $nameLength)
            $owner = [PSCustomObject]@{ Module = $moduleName; Base = $base; Offset = $address - $base }
            break
        }
    }
    if ($owner) {
        Write-Output ("  faulting module: {0}+0x{1:X}" -f (Split-Path $owner.Module -Leaf), $owner.Offset)
        Write-Output ("  full path: {0}" -f $owner.Module)
    } else {
        Write-Output "  faulting address is not inside any loaded module (bad function pointer / corrupted stack)"
    }
}
