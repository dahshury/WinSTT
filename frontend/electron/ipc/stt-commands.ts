import { ipcMain } from "electron";
import { dbg, dbgVerbose } from "../lib/debug-log";
import type { SttClient } from "../ws/stt-client";

/**
 * Allowlists for STT parameters and methods that the renderer may invoke.
 * Must stay in sync with the OpenAPI spec (AllowedParameter / AllowedMethod).
 */
const ALLOWED_PARAMETERS = new Set([
	"model",
	"language",
	"silero_sensitivity",
	"wake_word_activation_delay",
	"post_speech_silence_duration",
	"listen_start",
	"recording_stop_time",
	"last_transcription_bytes",
	"last_transcription_bytes_b64",
	"speech_end_silence_start",
	"is_recording",
	"use_wake_words",
	"silence_timing",
	"silence_endpoint_enabled",
	"smart_endpoint_enabled",
	"detection_speed",
]);

const ALLOWED_METHODS = new Set([
	"set_microphone",
	"abort",
	"stop",
	"clear_audio_queue",
	"wakeup",
	"shutdown",
	"text",
]);

export function setupSttCommandHandlers(sttClient: SttClient): void {
	ipcMain.on("stt:set-parameter", (_event, payload: { parameter: string; value: unknown }) => {
		if (!payload || typeof payload.parameter !== "string") {
			dbg("stt-cmd", "set-parameter REJECTED (invalid payload)");
			return;
		}
		if (!ALLOWED_PARAMETERS.has(payload.parameter)) {
			dbg("stt-cmd", "set-parameter REJECTED (disallowed):", payload.parameter);
			return;
		}
		if (!sttClient.isConnected) {
			dbg("stt-cmd", "set-parameter DROPPED (not connected):", payload.parameter);
			return;
		}
		dbgVerbose("stt-cmd", "set-parameter:", payload.parameter, "=", JSON.stringify(payload.value));
		sttClient.setParameter(payload.parameter, payload.value);
	});

	ipcMain.handle("stt:is-connected", () => sttClient.isConnected);

	ipcMain.handle("stt:get-parameter", (_event, payload: { parameter: string }) => {
		if (!payload || typeof payload.parameter !== "string") {
			return Promise.reject(new Error("Invalid payload: parameter must be a string"));
		}
		if (!ALLOWED_PARAMETERS.has(payload.parameter)) {
			return Promise.reject(new Error(`Disallowed parameter: ${payload.parameter}`));
		}
		if (!sttClient.isConnected) {
			return Promise.reject(new Error("STT client is not connected"));
		}
		return sttClient.getParameter(payload.parameter);
	});

	ipcMain.on("stt:call-method", (_event, payload: { method: string; args?: unknown[] }) => {
		if (!payload || typeof payload.method !== "string") {
			dbg("stt-cmd", "call-method REJECTED (invalid payload)");
			return;
		}
		if (!ALLOWED_METHODS.has(payload.method)) {
			dbg("stt-cmd", "call-method REJECTED (disallowed):", payload.method);
			return;
		}
		if (payload.args !== undefined && !Array.isArray(payload.args)) {
			dbg("stt-cmd", "call-method REJECTED (args must be array):", payload.method);
			return;
		}
		if (!sttClient.isConnected) {
			dbg("stt-cmd", "call-method DROPPED (not connected):", payload.method);
			return;
		}
		dbgVerbose("stt-cmd", "call-method:", payload.method, JSON.stringify(payload.args ?? []));
		sttClient.callMethod(payload.method, payload.args);
	});

	ipcMain.handle("gpu:get-info", async () => {
		try {
			const { execFile } = await import("node:child_process");
			const { promisify } = await import("node:util");
			const execFileAsync = promisify(execFile);
			const { stdout } = await execFileAsync(
				"nvidia-smi",
				["--query-gpu=name", "--format=csv,noheader,nounits"],
				{ windowsHide: true, timeout: 5000 }
			);
			const output = stdout.trim();
			const name = output.split("\n")[0]?.trim() ?? "NVIDIA GPU";
			return { name, available: true };
		} catch {
			return { name: "No NVIDIA GPU", available: false };
		}
	});

	ipcMain.handle("audio:get-devices", async () => {
		if (process.platform !== "win32") {
			return [];
		}
		try {
			const { execFile } = await import("node:child_process");
			const { promisify } = await import("node:util");
			const execFileAsync = promisify(execFile);

			// Use PowerShell + MMDevice COM to enumerate audio capture endpoints
			const ps = `
Add-Type -AssemblyName System.Runtime.InteropServices
$code = @'
using System;
using System.Runtime.InteropServices;

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection ppDevices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
}

[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection {
    int GetCount(out int pcDevices);
    int Item(int nDevice, out IMMDevice ppDevice);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    int OpenPropertyStore(int stgmAccess, out IPropertyStore ppProperties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
    int GetState(out int pdwState);
}

[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore {
    int GetCount(out int cProps);
    int GetAt(int iProp, out PROPERTYKEY pkey);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
}

[StructLayout(LayoutKind.Sequential)]
struct PROPERTYKEY {
    public Guid fmtid;
    public int pid;
}

[StructLayout(LayoutKind.Sequential)]
struct PROPVARIANT {
    public ushort vt;
    public ushort wReserved1, wReserved2, wReserved3;
    public IntPtr val;
    public IntPtr val2;
}

public static class AudioDeviceLister {
    public static string List() {
        var CLSID = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
        var t = Type.GetTypeFromCLSID(CLSID);
        var enumerator = (IMMDeviceEnumerator)Activator.CreateInstance(t);

        // Get default capture device ID
        string defaultId = "";
        IMMDevice defDev;
        if (enumerator.GetDefaultAudioEndpoint(1, 0, out defDev) == 0) {
            defDev.GetId(out defaultId);
        }

        // Enumerate capture devices (dataFlow=1=eCapture, stateMask=1=ACTIVE)
        IMMDeviceCollection col;
        enumerator.EnumAudioEndpoints(1, 1, out col);
        int count;
        col.GetCount(out count);

        var PKEY_Name = new PROPERTYKEY {
            fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"),
            pid = 14
        };

        var sb = new System.Text.StringBuilder();
        for (int i = 0; i < count; i++) {
            IMMDevice dev;
            col.Item(i, out dev);
            string id;
            dev.GetId(out id);
            IPropertyStore props;
            dev.OpenPropertyStore(0, out props);
            PROPVARIANT pv;
            props.GetValue(ref PKEY_Name, out pv);
            string name = Marshal.PtrToStringUni(pv.val) ?? "Unknown";
            bool isDef = id == defaultId;
            sb.AppendLine(i + "|" + name + "|" + (isDef ? "1" : "0"));
        }
        return sb.ToString().TrimEnd();
    }
}
'@
Add-Type -TypeDefinition $code -Language CSharp
[AudioDeviceLister]::List()
`;
			const { stdout } = await execFileAsync(
				"powershell",
				["-NoProfile", "-NonInteractive", "-Command", ps],
				{ windowsHide: true, timeout: 10_000 }
			);

			const devices: Array<{ index: number; name: string; isDefault: boolean }> = [];
			for (const line of stdout.trim().split("\n")) {
				const parts = line.trim().split("|");
				const indexStr = parts[0];
				const nameStr = parts[1];
				const defaultStr = parts[2];
				if (indexStr !== undefined && nameStr !== undefined && defaultStr !== undefined) {
					devices.push({
						index: Number.parseInt(indexStr, 10),
						name: nameStr.trim(),
						isDefault: defaultStr === "1",
					});
				}
			}
			return devices;
		} catch (err) {
			console.warn("[audio] Failed to enumerate devices:", err);
			return [];
		}
	});
}
