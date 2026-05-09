import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ipcMain } from "electron";
import { dbg } from "../lib/debug-log";

let isMuted = false;
let inFlight: Promise<void> | null = null;

/**
 * PowerShell script that mutes/unmutes the default Windows playback device
 * via Windows Core Audio COM API (IAudioEndpointVolume.SetMute).
 *
 * Written to a temp .ps1 file and executed to avoid quoting issues.
 * The `%MUTE_VALUE%` placeholder is replaced at call time.
 */
const PS_MUTE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr pNotify);
    int UnregisterControlChangeNotify(IntPtr pNotify);
    int GetChannelCount(out int pnChannelCount);
    int SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);
    int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);
    int GetMasterVolumeLevel(out float pfLevelDB);
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int SetChannelVolumeLevel(int nChannel, float fLevelDB, ref Guid pguidEventContext);
    int SetChannelVolumeLevelScalar(int nChannel, float fLevel, ref Guid pguidEventContext);
    int GetChannelVolumeLevel(int nChannel, out float pfLevelDB);
    int GetChannelVolumeLevelScalar(int nChannel, out float pfLevel);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid pguidEventContext);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr ppDevices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
public static class Audio {
    public static void SetMute(bool mute) {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice device;
        enumerator.GetDefaultAudioEndpoint(0, 1, out device);
        Guid iid = typeof(IAudioEndpointVolume).GUID;
        object o;
        device.Activate(ref iid, 23, IntPtr.Zero, out o);
        var vol = (IAudioEndpointVolume)o;
        Guid empty = Guid.Empty;
        vol.SetMute(mute, ref empty);
    }
}
'@ -Language CSharp
[Audio]::SetMute(%MUTE_VALUE%)
`.trim();

/**
 * Toggle the system mute via VK_VOLUME_MUTE keypress.
 * Used as a fallback when the COM-interop SetMute path fails (e.g. AV blocking inline C# compile).
 */
const PS_TOGGLE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$sig = '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, uint dwExtraInfo);'
$kb = Add-Type -MemberDefinition $sig -Name 'WinSttKb' -Namespace 'WinStt' -PassThru
$kb::keybd_event(0xAD, 0, 0, 0)
$kb::keybd_event(0xAD, 0, 2, 0)
`.trim();

const tempDir = process.env.TEMP ?? process.env.TMP ?? ".";
const setMuteScriptPath = path.join(tempDir, "winstt-mute.ps1");
const toggleScriptPath = path.join(tempDir, "winstt-mute-toggle.ps1");

interface RunResult {
	code: number | null;
	error?: string;
	ok: boolean;
	stderr: string;
	stdout: string;
}

function runPowerShell(scriptPath: string): Promise<RunResult> {
	return new Promise((resolve) => {
		execFile(
			"powershell",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
			{ windowsHide: true, timeout: 8000 },
			(err, stdout, stderr) => {
				const stderrText = (stderr ?? "").toString().trim();
				const stdoutText = (stdout ?? "").toString().trim();
				if (err) {
					const exitCode =
						typeof (err as NodeJS.ErrnoException & { code?: number | string }).code === "number"
							? ((err as { code: number }).code ?? null)
							: null;
					resolve({
						ok: false,
						code: exitCode,
						stderr: stderrText,
						stdout: stdoutText,
						error: err.message,
					});
				} else {
					resolve({ ok: true, code: 0, stderr: stderrText, stdout: stdoutText });
				}
			}
		);
	});
}

let toggleFallbackEnabled = true;
// Latches off after first failure: Add-Type -TypeDefinition COM-interop compile
// is slow and Defender-scanned, so it routinely times out. Once it fails this
// session, skip straight to the keypress toggle to avoid log spam and 8s stalls.
let setMutePrimaryEnabled = true;

function formatRunErr(r: RunResult): string {
	return r.stderr || r.error || "no stderr";
}

async function writeAndRun(
	scriptPath: string,
	script: string,
	writeErrLabel: string
): Promise<RunResult | null> {
	try {
		await fs.promises.writeFile(scriptPath, script, "utf-8");
	} catch (err) {
		dbg("audio-mute", writeErrLabel, (err as Error).message);
		return null;
	}
	return runPowerShell(scriptPath);
}

function processPrimaryResult(result: RunResult | null): boolean {
	if (result?.ok) {
		return true;
	}
	if (result) {
		dbg(
			"audio-mute",
			`SetMute failed (exit=${result.code}): ${formatRunErr(result)} — disabling primary path for this session`
		);
	}
	setMutePrimaryEnabled = false;
	return false;
}

function processFallbackResult(result: RunResult | null): boolean {
	if (result?.ok) {
		return true;
	}
	if (result) {
		dbg("audio-mute", `Toggle fallback failed (exit=${result.code}): ${formatRunErr(result)}`);
	}
	// Stop trying to avoid log spam — first failure tells us PowerShell + Add-Type is unavailable.
	toggleFallbackEnabled = false;
	return false;
}

async function tryPrimaryPath(targetMuted: boolean): Promise<boolean> {
	if (!setMutePrimaryEnabled) {
		return false;
	}
	const script = PS_MUTE_SCRIPT.replace("%MUTE_VALUE%", targetMuted ? "$true" : "$false");
	return processPrimaryResult(
		await writeAndRun(setMuteScriptPath, script, "Failed to write mute script:")
	);
}

async function tryFallbackPath(): Promise<boolean> {
	if (!toggleFallbackEnabled) {
		return false;
	}
	return processFallbackResult(
		await writeAndRun(toggleScriptPath, PS_TOGGLE_SCRIPT, "Failed to write toggle script:")
	);
}

async function runMuteWithFallback(targetMuted: boolean): Promise<string | null> {
	if (await tryPrimaryPath(targetMuted)) {
		return "";
	}
	if (await tryFallbackPath()) {
		return " (via VK_VOLUME_MUTE)";
	}
	return null;
}

function shouldSkipMute(targetMuted: boolean): boolean {
	return process.platform !== "win32" || isMuted === targetMuted;
}

function commitMutedState(target: boolean, suffix: string): void {
	isMuted = target;
	dbg("audio-mute", `System audio ${target ? "muted" : "unmuted"}${suffix}`);
}

async function applyMute(targetMuted: boolean): Promise<void> {
	if (shouldSkipMute(targetMuted)) {
		return;
	}
	const successSuffix = await runMuteWithFallback(targetMuted);
	if (successSuffix !== null) {
		commitMutedState(targetMuted, successSuffix);
	}
}

function setSystemMute(targetMuted: boolean): void {
	// Serialize calls so back-to-back mute/unmute don't race on the temp script file.
	const next = (inFlight ?? Promise.resolve()).then(() => applyMute(targetMuted));
	inFlight = next.catch(() => {
		// errors already logged inside applyMute
	});
}

/** Test hook: await any pending mute work. */
export function flushMutePending(): Promise<void> {
	return inFlight ?? Promise.resolve();
}

/** Test hook: reset module-level latches so each test starts from a known state. */
export function __resetAudioMuteForTesting__(): void {
	isMuted = false;
	inFlight = null;
	setMutePrimaryEnabled = true;
	toggleFallbackEnabled = true;
}

/** Mute system audio. Returns true if it actually issued a mute. */
export function muteSystemAudio(): boolean {
	if (!isMuted) {
		setSystemMute(true);
		return true;
	}
	return false;
}

/** Unmute system audio if we previously muted it. */
export function unmuteSystemAudio(): void {
	if (isMuted) {
		setSystemMute(false);
	}
}

export function setupAudioMuteHandlers(): void {
	ipcMain.on("audio:set-mute", (_event, payload: { muted: boolean }) => {
		if (!payload || typeof payload.muted !== "boolean") {
			return;
		}
		setSystemMute(payload.muted);
	});
}
