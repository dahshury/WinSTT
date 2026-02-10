import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ipcMain } from "electron";

let isMuted = false;

/**
 * PowerShell script that mutes/unmutes the default Windows playback device
 * via Windows Core Audio COM API (IAudioEndpointVolume.SetMute).
 *
 * Written to a temp .ps1 file and executed to avoid quoting issues.
 * The `%MUTE_VALUE%` placeholder is replaced at call time.
 */
const PS_MUTE_SCRIPT = `
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

/** Temp directory for the mute script file */
const scriptDir = path.join(process.env.TEMP ?? process.env.TMP ?? ".", "winstt-mute.ps1");

/**
 * Mute or unmute the default Windows playback device.
 * Writes a temp .ps1 script and runs it to avoid EncodedCommand/quoting issues.
 */
function setSystemMute(muted: boolean) {
	if (process.platform !== "win32") {
		return;
	}

	const script = PS_MUTE_SCRIPT.replace("%MUTE_VALUE%", muted ? "$true" : "$false");

	try {
		fs.writeFileSync(scriptDir, script, "utf-8");
	} catch (err) {
		console.error("[audio-mute] Failed to write script:", err);
		return;
	}

	execFile(
		"powershell",
		["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptDir],
		{ windowsHide: true, timeout: 8000 },
		(err) => {
			if (err) {
				console.error("[audio-mute] Failed to set mute:", err.message);
			} else {
				isMuted = muted;
				console.log(`[audio-mute] System audio ${muted ? "muted" : "unmuted"}`);
			}
		}
	);
}

/** Mute system audio. Returns true if it actually muted. */
export function muteSystemAudio(): boolean {
	if (!isMuted) {
		setSystemMute(true);
		return true;
	}
	return false;
}

/** Unmute system audio if we previously muted it. */
export function unmuteSystemAudio() {
	if (isMuted) {
		setSystemMute(false);
	}
}

export function setupAudioMuteHandlers() {
	ipcMain.on("audio:set-mute", (_event, { muted }: { muted: boolean }) => {
		setSystemMute(muted);
	});
}
