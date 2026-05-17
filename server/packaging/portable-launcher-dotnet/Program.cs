// Portable single-file launcher for the WinSTT STT server bundle.
//
// The wrapper exe is built with build-portable.ps1, which appends a 7z
// archive (the entire PyInstaller onedir bundle) and a 24-byte footer:
//
//   [ launcher PE ............... ][ 7z archive ............ ][ footer (24B) ]
//                                  ^                          ^
//                                  archive offset             magic + offset + length
//
// Footer layout (last 24 bytes of the produced exe):
//   bytes  0..7   ASCII "WINSTT01"   magic so the launcher can self-validate
//   bytes  8..15  Int64 LE           absolute file offset of the 7z archive
//   bytes 16..23  Int64 LE           length of the 7z archive
//
// Behaviour:
//   1. Read the marker file next to the wrapper exe (".winstt-runtime").
//      If it points to a folder containing stt-server.exe, exec that and
//      forward all CLI args + stdio + exit code.
//   2. Otherwise show a native FolderBrowserDialog (via PowerShell shell-out
//      to avoid pulling in WinForms/WPF dependencies), extract the appended
//      7z archive there, write the marker, and exec.
//
// Why this exists: PyInstaller --onefile re-extracts ~3.8 GB to %TEMP% on
// every launch (~30s cold start). NSIS has a 2 GB compiler input cap. This
// launcher gives a true single-file portable with one-time extraction.

using System.Diagnostics;
using System.Text;
using SharpCompress.Archives;
using SharpCompress.Archives.SevenZip;
using SharpCompress.Common;

namespace WinSTT.PortableLauncher;

internal static class Program
{
    private const string TargetExe    = "stt-server.exe";
    private const string MarkerName   = ".winstt-runtime";
    private const string DefaultSub   = "WinSTT-STT-Server-GPU";
    private const string Flavor       = "GPU";
    private const int    FooterSize   = 24;
    private static readonly byte[] Magic = Encoding.ASCII.GetBytes("WINSTT01");

    private static int Main(string[] args)
    {
        try
        {
            var exePath = Environment.ProcessPath
                ?? throw new InvalidOperationException("Cannot determine own exe path");
            var exeDir  = Path.GetDirectoryName(exePath)!;
            var marker  = Path.Combine(exeDir, MarkerName);

            var runtimeDir = TryReadMarker(marker);
            if (runtimeDir is null || !File.Exists(Path.Combine(runtimeDir, TargetExe)))
            {
                runtimeDir = FirstRunSetup(exePath, exeDir);
                if (runtimeDir is null)
                {
                    Console.Error.WriteLine("Setup cancelled.");
                    return 1;
                }
            }

            return RunInnerExe(runtimeDir, args);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[WinSTT portable launcher] {ex.GetType().Name}: {ex.Message}");
            return 2;
        }
    }

    private static string? TryReadMarker(string markerPath)
    {
        if (!File.Exists(markerPath)) return null;
        try
        {
            var line = File.ReadAllText(markerPath).Trim();
            return string.IsNullOrEmpty(line) ? null : line;
        }
        catch
        {
            return null;
        }
    }

    private static string? FirstRunSetup(string exePath, string exeDir)
    {
        var defaultDir = Path.Combine(exeDir, DefaultSub);
        var chosen = PromptFolder(defaultDir);
        if (chosen is null) return null;

        Console.WriteLine();
        Console.WriteLine($"Extracting WinSTT {Flavor} runtime →");
        Console.WriteLine($"  {chosen}");
        Console.WriteLine("(one-time first-launch step; subsequent runs go straight to the server)");
        Console.WriteLine();

        Directory.CreateDirectory(chosen);
        ExtractArchive(exePath, chosen);

        var target = Path.Combine(chosen, TargetExe);
        if (!File.Exists(target))
        {
            throw new InvalidOperationException(
                $"Extraction completed but {TargetExe} is not at {chosen}. Bundle may be corrupted.");
        }

        File.WriteAllText(Path.Combine(exeDir, MarkerName), chosen);
        Console.WriteLine();
        Console.WriteLine($"Marker saved: {Path.Combine(exeDir, MarkerName)}");
        Console.WriteLine($"Delete it (or the runtime folder) to re-prompt on next launch.");
        Console.WriteLine();
        return chosen;
    }

    private static string? PromptFolder(string defaultDir)
    {
        // PowerShell shell-out keeps WinForms out of the launcher's compiled
        // surface area. ~300 ms one-time cost on first launch.
        var safeDefault = defaultDir.Replace("'", "''");
        var psScript = $$"""
            $ErrorActionPreference = 'Stop'
            Add-Type -AssemblyName System.Windows.Forms
            $d = New-Object System.Windows.Forms.FolderBrowserDialog
            $d.Description = 'Choose where to extract the WinSTT {{Flavor}} runtime (~3.8 GB). The wrapper exe will remember this location next to itself; future launches skip extraction.'
            $d.SelectedPath = '{{safeDefault}}'
            $d.UseDescriptionForTitle = $true
            $d.ShowNewFolderButton = $true
            if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }
            """;

        var psi = new ProcessStartInfo("powershell")
        {
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        psi.ArgumentList.Add("-NoProfile");
        psi.ArgumentList.Add("-ExecutionPolicy");
        psi.ArgumentList.Add("Bypass");
        psi.ArgumentList.Add("-Command");
        psi.ArgumentList.Add(psScript);

        using var ps = Process.Start(psi)
            ?? throw new InvalidOperationException("Failed to start PowerShell for folder picker");
        var output = ps.StandardOutput.ReadToEnd().Trim();
        ps.WaitForExit();
        return string.IsNullOrEmpty(output) ? null : output;
    }

    private static void ExtractArchive(string exePath, string targetDir)
    {
        var (offset, length) = ReadFooter(exePath);

        using var fs = new FileStream(exePath, FileMode.Open, FileAccess.Read, FileShare.Read);
        fs.Seek(offset, SeekOrigin.Begin);
        using var slice = new SliceStream(fs, offset, length);

        using var archive = SevenZipArchive.Open(slice);
        var totalBytes = archive.TotalUncompressSize;
        long extracted = 0;
        var sw = Stopwatch.StartNew();
        var lastReport = -1000L;
        var options = new ExtractionOptions
        {
            ExtractFullPath = true,
            Overwrite = true,
            PreserveFileTime = false,
        };

        foreach (var entry in archive.Entries)
        {
            if (entry.IsDirectory) continue;
            entry.WriteToDirectory(targetDir, options);
            extracted += entry.Size;
            var now = sw.ElapsedMilliseconds;
            if (now - lastReport > 250)
            {
                ReportProgress(extracted, totalBytes, sw.Elapsed);
                lastReport = now;
            }
        }
        ReportProgress(extracted, totalBytes, sw.Elapsed);
        Console.WriteLine();
    }

    private static void ReportProgress(long extracted, long total, TimeSpan elapsed)
    {
        var mibDone = extracted / 1024.0 / 1024.0;
        if (total > 0)
        {
            var mibTotal = total / 1024.0 / 1024.0;
            var pct = (double)extracted / total * 100.0;
            Console.Write($"\r  {mibDone,8:F1} / {mibTotal,8:F1} MiB  ({pct,5:F1}%)  elapsed {elapsed.TotalSeconds,6:F1}s");
        }
        else
        {
            Console.Write($"\r  {mibDone,8:F1} MiB  elapsed {elapsed.TotalSeconds,6:F1}s");
        }
    }

    private static (long offset, long length) ReadFooter(string exePath)
    {
        using var fs = new FileStream(exePath, FileMode.Open, FileAccess.Read, FileShare.Read);
        fs.Seek(-FooterSize, SeekOrigin.End);
        Span<byte> footer = stackalloc byte[FooterSize];
        fs.ReadExactly(footer);
        if (!footer[..8].SequenceEqual(Magic))
        {
            throw new InvalidOperationException(
                "Footer magic missing — this exe was not produced by build-portable.ps1, or the appended payload was stripped.");
        }
        var offset = BitConverter.ToInt64(footer[8..16]);
        var length = BitConverter.ToInt64(footer[16..24]);
        if (offset <= 0 || length <= 0 || offset + length + FooterSize > fs.Length)
        {
            throw new InvalidOperationException(
                $"Footer values out of range (offset={offset}, length={length}, file={fs.Length}).");
        }
        return (offset, length);
    }

    private static int RunInnerExe(string runtimeDir, string[] args)
    {
        var target = Path.Combine(runtimeDir, TargetExe);
        var psi = new ProcessStartInfo(target)
        {
            UseShellExecute = false,
            WorkingDirectory = runtimeDir,
            // Inherit stdin/stdout/stderr by leaving Redirect* at their defaults
            // (false) AND UseShellExecute=false. CreateProcess inherits the
            // parent's handles, so anything piped into the wrapper reaches
            // stt-server.exe unchanged (Electron's child_process.spawn, cmd
            // redirection, etc.).
        };
        foreach (var a in args) psi.ArgumentList.Add(a);

        using var p = Process.Start(psi)
            ?? throw new InvalidOperationException($"Failed to start {target}");
        p.WaitForExit();
        return p.ExitCode;
    }

    // Read-only seekable slice of a FileStream, scoped to [origin, origin+length).
    // SharpCompress's 7z reader requires random access; we hand it this slice
    // instead of the raw FileStream so it can't seek past the archive end.
    private sealed class SliceStream : Stream
    {
        private readonly FileStream _inner;
        private readonly long _origin;
        private readonly long _length;
        private long _pos;

        public SliceStream(FileStream inner, long origin, long length)
        {
            _inner  = inner;
            _origin = origin;
            _length = length;
        }

        public override bool CanRead  => true;
        public override bool CanSeek  => true;
        public override bool CanWrite => false;
        public override long Length   => _length;
        public override long Position
        {
            get => _pos;
            set
            {
                if (value < 0 || value > _length)
                    throw new ArgumentOutOfRangeException(nameof(value));
                _pos = value;
            }
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            var remaining = _length - _pos;
            if (remaining <= 0) return 0;
            if (count > remaining) count = (int)remaining;
            _inner.Position = _origin + _pos;
            var n = _inner.Read(buffer, offset, count);
            _pos += n;
            return n;
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            var target = origin switch
            {
                SeekOrigin.Begin   => offset,
                SeekOrigin.Current => _pos + offset,
                SeekOrigin.End     => _length + offset,
                _ => throw new ArgumentOutOfRangeException(nameof(origin)),
            };
            Position = target;
            return _pos;
        }

        public override void Flush() { }
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
