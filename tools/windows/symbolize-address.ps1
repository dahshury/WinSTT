# Resolve a module-relative address to a function name (and source line) using dbghelp.
#
# Pairs with read-minidump.ps1: that prints "faulting module: WinSTT.exe+0x2E92F74", this turns
# the RVA into a symbol. dbghelp.dll ships with Windows, so no debugger install is needed. The
# PDB must match the binary -- point -SymbolPath at the build's target\release directory.
#
#     .\tools\windows\symbolize-address.ps1 -Image 'path\to\WinSTT.exe' -Rva 0x2E92F74 `
#         -SymbolPath 'E:\DL\Projects\WinSTT\src-tauri\target\release'

param(
    [Parameter(Mandatory = $true)][string]$Image,
    [Parameter(Mandatory = $true)][uint64]$Rva,
    [string]$SymbolPath
)

$ErrorActionPreference = 'Stop'
if (-not $SymbolPath) { $SymbolPath = Split-Path $Image -Parent }

Add-Type -Namespace WinSttDbg -Name Sym -MemberDefinition @'
[DllImport("dbghelp.dll", SetLastError=true, CharSet=CharSet.Ansi)]
public static extern bool SymInitialize(IntPtr hProcess, string UserSearchPath, bool fInvadeProcess);
[DllImport("dbghelp.dll", SetLastError=true)]
public static extern uint SymSetOptions(uint SymOptions);
[DllImport("dbghelp.dll", SetLastError=true, CharSet=CharSet.Ansi)]
public static extern ulong SymLoadModuleEx(IntPtr hProcess, IntPtr hFile, string ImageName,
    string ModuleName, ulong BaseOfDll, uint DllSize, IntPtr Data, uint Flags);
[DllImport("dbghelp.dll", SetLastError=true)]
public static extern bool SymFromAddr(IntPtr hProcess, ulong Address, out ulong Displacement, IntPtr Symbol);
[DllImport("dbghelp.dll", SetLastError=true)]
public static extern bool SymGetLineFromAddr64(IntPtr hProcess, ulong dwAddr, out uint pdwDisplacement, IntPtr Line);
[DllImport("kernel32.dll")]
public static extern IntPtr GetCurrentProcess();
'@

$process = [WinSttDbg.Sym]::GetCurrentProcess()
# UNDNAME | DEFERRED_LOADS | LOAD_LINES
[void][WinSttDbg.Sym]::SymSetOptions(0x00000002 -bor 0x00000004 -bor 0x00000010)
if (-not [WinSttDbg.Sym]::SymInitialize($process, $SymbolPath, $false)) {
    throw "SymInitialize failed: $([ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()).Message)"
}

$base = [uint64]0x10000000
$loaded = [WinSttDbg.Sym]::SymLoadModuleEx($process, [IntPtr]::Zero, $Image, $null, $base, 0, [IntPtr]::Zero, 0)
if ($loaded -eq 0) {
    throw "SymLoadModuleEx failed: $([ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()).Message)"
}

$address = $base + $Rva
$maxName = 1024
$size = 88 + $maxName            # sizeof(SYMBOL_INFO) + name buffer
$buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
try {
    [Runtime.InteropServices.Marshal]::WriteInt32($buffer, 0, 88)          # SizeOfStruct
    [Runtime.InteropServices.Marshal]::WriteInt32($buffer, 84, $maxName)   # MaxNameLen
    $displacement = [uint64]0
    if ([WinSttDbg.Sym]::SymFromAddr($process, $address, [ref]$displacement, $buffer)) {
        $nameLen = [Runtime.InteropServices.Marshal]::ReadInt32($buffer, 80)
        $name = [Runtime.InteropServices.Marshal]::PtrToStringAnsi([IntPtr]::Add($buffer, 88), $nameLen)
        Write-Output ("symbol: {0}+0x{1:X}" -f $name, $displacement)
    } else {
        Write-Output "symbol: <not found> (does the PDB match this binary?)"
    }
} finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
}

# IMAGEHLP_LINE64: DWORD SizeOfStruct; PVOID Key; DWORD LineNumber; PCHAR FileName; DWORD64 Address;
$lineSize = 40
$lineBuffer = [Runtime.InteropServices.Marshal]::AllocHGlobal($lineSize)
try {
    [Runtime.InteropServices.Marshal]::WriteInt32($lineBuffer, 0, $lineSize)
    $lineDisplacement = [uint32]0
    if ([WinSttDbg.Sym]::SymGetLineFromAddr64($process, $address, [ref]$lineDisplacement, $lineBuffer)) {
        $lineNumber = [Runtime.InteropServices.Marshal]::ReadInt32($lineBuffer, 16)
        $filePtr = [Runtime.InteropServices.Marshal]::ReadIntPtr($lineBuffer, 24)
        $file = [Runtime.InteropServices.Marshal]::PtrToStringAnsi($filePtr)
        Write-Output ("source: {0}:{1}" -f $file, $lineNumber)
    } else {
        Write-Output "source: <no line info>"
    }
} finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($lineBuffer)
}
