import { type ChildProcess, spawn } from "node:child_process";
import { dbg } from "./debug-log";

/**
 * Long-running PowerShell host process used by paste and audio-volume.
 *
 * Why this exists: spawning `powershell.exe` per call routinely takes 5–8s
 * under Defender scanning, and writing a fresh `.ps1` to %TEMP% triggers
 * another scan. With many rapid PTT cycles those costs stack and freeze the
 * whole machine. By keeping one PowerShell alive with the P/Invoke wrappers
 * already JIT-compiled, every subsequent command is just a `stdin.write`.
 *
 * Lifecycle: lazy-spawned on first use; respawned automatically if it exits
 * (set null on close); shutdown via `shutdownPsHost()` on app quit.
 */

const READY_MARKER = "__WINSTT_PS_READY__";
const DONE_MARKER_PREFIX = "__WINSTT_PS_DONE__:";
const VALUE_MARKER_PREFIX = "__WINSTT_PS_VAL__:";

const SPAWN_TIMEOUT_MS = 15_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 5000;

/**
 * One-time setup: a single Add-Type compiles a C# class with both
 * Core Audio COM-interop (silent volume control via
 * IAudioEndpointVolume.SetMasterVolumeLevelScalar — no OSD) and a
 * SendInput-based paste primitive.
 *
 * SendInput vs keybd_event: SendInput delivers an *atomic* batch of
 * INPUT events to the system input queue. keybd_event posts events one
 * at a time and they can be interleaved with real keyboard input,
 * which is the source of intermittent paste failures (a real keypress
 * lands between Ctrl-down and V-down and Ctrl gets eaten). The whole
 * sequence — release-modifiers, Ctrl-down, V-down, V-up, Ctrl-up — is
 * a single SendInput call.
 */
const SETUP_SCRIPT = `
$ErrorActionPreference = 'Continue'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
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
    static IAudioEndpointVolume GetEndpoint() {
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice device;
        enumerator.GetDefaultAudioEndpoint(0, 1, out device);
        Guid iid = typeof(IAudioEndpointVolume).GUID;
        object o;
        device.Activate(ref iid, 23, IntPtr.Zero, out o);
        return (IAudioEndpointVolume)o;
    }
    public static float GetVolume() {
        float v;
        GetEndpoint().GetMasterVolumeLevelScalar(out v);
        return v;
    }
    public static void SetVolume(float level) {
        if (level < 0f) level = 0f;
        if (level > 1f) level = 1f;
        Guid empty = Guid.Empty;
        GetEndpoint().SetMasterVolumeLevelScalar(level, ref empty);
    }
}

public static class Pasta {
    const uint INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_KEYUP = 0x0002;

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }
    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public InputUnion U;
    }

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    static INPUT Key(ushort vk, bool up) {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.U.ki.wVk = vk;
        i.U.ki.wScan = 0;
        i.U.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0u;
        i.U.ki.time = 0;
        i.U.ki.dwExtraInfo = IntPtr.Zero;
        return i;
    }

    /**
     * Release every modifier (so the user holding Win+Ctrl as a PTT
     * combo doesn't combine with Ctrl+V), then press Ctrl+V, then
     * release. Submitted as one atomic SendInput call so other input
     * can't interleave between events.
     *
     * Returns the number of events the OS injected (== nInputs on success).
     */
    public static uint Paste() {
        ushort[] mods = new ushort[] { 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C };
        List<INPUT> list = new List<INPUT>();
        for (int i = 0; i < mods.Length; i++) list.Add(Key(mods[i], true));
        list.Add(Key(0x11, false)); // VK_CONTROL down
        list.Add(Key(0x56, false)); // VK_V down
        list.Add(Key(0x56, true));  // VK_V up
        list.Add(Key(0x11, true));  // VK_CONTROL up
        INPUT[] arr = list.ToArray();
        return SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
    }

    const uint KEYEVENTF_UNICODE = 0x0004;

    static INPUT UnicodeKey(char c, bool up) {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.U.ki.wVk = 0;
        i.U.ki.wScan = c;
        i.U.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0u);
        i.U.ki.time = 0;
        i.U.ki.dwExtraInfo = IntPtr.Zero;
        return i;
    }

    /**
     * Type a UTF-8 string directly into the focused window via Unicode
     * SendInput events. Avoids the clipboard + Ctrl+V dance entirely:
     * no AV "paste detection" hook can fire because there's no Ctrl+V,
     * and no special key combinations need to be released first.
     *
     * Each char becomes a (down, up) pair of KEYEVENTF_UNICODE events.
     * Surrogate pairs are sent as separate events; the OS recomposes
     * them into the original codepoint on the receiving end.
     *
     * Also releases any held modifiers first so the synthetic chars
     * don't combine with a held PTT hotkey (e.g. Win+Ctrl + 'A' would
     * become Win+Ctrl+A).
     *
     * The b64 argument is base64-encoded UTF-8 of the source text —
     * safer than embedding the text in a PowerShell string literal
     * where quoting / escaping is a permanent hazard.
     *
     * Returns the number of input events accepted by the OS.
     */
    public static uint TypeBase64(string b64) {
        byte[] bytes = Convert.FromBase64String(b64);
        string text = System.Text.Encoding.UTF8.GetString(bytes);
        ushort[] mods = new ushort[] { 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C };
        List<INPUT> list = new List<INPUT>();
        for (int i = 0; i < mods.Length; i++) list.Add(Key(mods[i], true));
        for (int i = 0; i < text.Length; i++) {
            list.Add(UnicodeKey(text[i], false));
            list.Add(UnicodeKey(text[i], true));
        }
        INPUT[] arr = list.ToArray();
        return SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
    }
}
'@ -Language CSharp

[Console]::Out.WriteLine('${READY_MARKER}')
[Console]::Out.Flush()
`.trim();

interface PendingCommand {
	resolve: (result: { ok: boolean; value: string | null }) => void;
	timer: ReturnType<typeof setTimeout>;
	value: string | null;
}

let psProcess: ChildProcess | null = null;
let psSetupPromise: Promise<boolean> | null = null;
let nextId = 1;
const pending = new Map<number, PendingCommand>();
let stdoutBuffer = "";

function failAllPending(): void {
	for (const req of pending.values()) {
		clearTimeout(req.timer);
		req.resolve({ ok: false, value: null });
	}
	pending.clear();
}

function processStdoutLine(line: string): void {
	if (line.startsWith(VALUE_MARKER_PREFIX)) {
		// Format: __WINSTT_PS_VAL__:<id>:<value>
		const rest = line.slice(VALUE_MARKER_PREFIX.length);
		const colon = rest.indexOf(":");
		if (colon < 0) {
			return;
		}
		const id = Number.parseInt(rest.slice(0, colon), 10);
		const value = rest.slice(colon + 1);
		const req = pending.get(id);
		if (req) {
			req.value = value;
		}
		return;
	}
	if (line.startsWith(DONE_MARKER_PREFIX)) {
		const id = Number.parseInt(line.slice(DONE_MARKER_PREFIX.length), 10);
		const req = pending.get(id);
		if (req) {
			pending.delete(id);
			clearTimeout(req.timer);
			req.resolve({ ok: true, value: req.value });
		}
	}
}

function processStdoutLines(): void {
	// react-doctor-disable-next-line js-set-map-lookups
	let idx = stdoutBuffer.indexOf("\n");
	while (idx >= 0) {
		const line = stdoutBuffer.slice(0, idx).trim();
		stdoutBuffer = stdoutBuffer.slice(idx + 1);
		if (line) {
			processStdoutLine(line);
		}
		// react-doctor-disable-next-line js-set-map-lookups
		idx = stdoutBuffer.indexOf("\n");
	}
}

function startPs(): Promise<boolean> {
	if (process.platform !== "win32") {
		return Promise.resolve(false);
	}
	const promise = new Promise<boolean>((resolveSetup) => {
		let setupResolved = false;
		stdoutBuffer = "";
		failAllPending();

		const ps = spawn(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"],
			{ windowsHide: true }
		);
		psProcess = ps;

		const finishSetup = (ok: boolean): void => {
			if (setupResolved) {
				return;
			}
			setupResolved = true;
			clearTimeout(setupTimer);
			resolveSetup(ok);
		};

		const setupTimer = setTimeout(() => {
			dbg("ps-host", `setup timeout (>${SPAWN_TIMEOUT_MS}ms)`);
			try {
				ps.kill();
			} catch {
				// best-effort
			}
			finishSetup(false);
		}, SPAWN_TIMEOUT_MS);

		const onData = (chunk: Buffer): void => {
			const text = chunk.toString();
			if (!setupResolved && text.includes(READY_MARKER)) {
				stdoutBuffer = "";
				finishSetup(true);
				return;
			}
			stdoutBuffer += text;
			processStdoutLines();
		};

		ps.stdout?.on("data", onData);
		ps.stderr?.on("data", (chunk: Buffer) => {
			const msg = chunk.toString().trim();
			if (msg) {
				dbg("ps-host", `stderr: ${msg.slice(0, 200)}`);
			}
		});
		ps.on("error", (err) => {
			dbg("ps-host", `spawn error: ${err.message}`);
			finishSetup(false);
		});
		ps.on("exit", (code, signal) => {
			dbg("ps-host", `exited code=${code} signal=${signal ?? "none"}`);
			if (psProcess === ps) {
				psProcess = null;
				psSetupPromise = null;
			}
			failAllPending();
			finishSetup(false);
		});

		try {
			ps.stdin?.write(`${SETUP_SCRIPT}\n`);
		} catch (err) {
			dbg("ps-host", `setup stdin write failed: ${(err as Error).message}`);
			finishSetup(false);
		}
	});
	psSetupPromise = promise;
	return promise;
}

function isPsAlive(): boolean {
	return psProcess !== null && !psProcess.killed && psProcess.exitCode === null;
}

function ensurePs(): Promise<boolean> {
	if (isPsAlive() && psSetupPromise) {
		return psSetupPromise;
	}
	return startPs();
}

interface RunOptions {
	/** When true, the command is expected to emit a single value via `Write-Output`. */
	expectValue?: boolean;
	timeoutMs?: number;
}

interface RunResult {
	ok: boolean;
	value: string | null;
}

/**
 * Send a command to the PS host and await completion.
 *
 * Each invocation appends a sentinel `Write-Output '__WINSTT_PS_DONE__:N'`
 * the host parses to match request → response. When `expectValue` is true,
 * the command should emit a single line via `Write-Output` BEFORE the
 * sentinel; that line is captured and returned in `value`.
 */
export async function runPsCommand(command: string, opts: RunOptions = {}): Promise<RunResult> {
	if (process.platform !== "win32") {
		return { ok: false, value: null };
	}
	const ready = await ensurePs();
	if (!ready) {
		return { ok: false, value: null };
	}
	const ps = psProcess;
	if (!(ps && isPsAlive() && ps.stdin)) {
		return { ok: false, value: null };
	}

	const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

	return new Promise<RunResult>((resolve) => {
		const id = nextId;
		nextId += 1;
		const timer = setTimeout(() => {
			if (pending.has(id)) {
				pending.delete(id);
				dbg("ps-host", `command timed out (id=${id}, >${timeoutMs}ms) — killing PS to recover`);
				resolve({ ok: false, value: null });
				// PS is wedged (typically a security hook intercepting SendInput).
				// Kill it so the next runPsCommand respawns a fresh process —
				// otherwise every subsequent command queues behind the hang and
				// the app appears permanently frozen.
				shutdownPsHost();
			}
		}, timeoutMs);

		pending.set(id, { resolve, timer, value: null });

		// When expecting a value, wrap the command so its single-line output is
		// prefixed with a value marker (so we can demux concurrent commands by id).
		const wrapped = opts.expectValue
			? `[Console]::Out.WriteLine('${VALUE_MARKER_PREFIX}${id}:' + (${command}))`
			: command;

		// `[Console]::Out.WriteLine` writes directly to the underlying stdout
		// stream and avoids PowerShell's pipeline buffering, which we've seen
		// hold the DONE marker for seconds when paired with Write-Output.
		try {
			ps.stdin?.write(
				`${wrapped}\n[Console]::Out.WriteLine('${DONE_MARKER_PREFIX}${id}')\n[Console]::Out.Flush()\n`
			);
		} catch (err) {
			pending.delete(id);
			clearTimeout(timer);
			dbg("ps-host", `stdin write failed: ${(err as Error).message}`);
			resolve({ ok: false, value: null });
		}
	});
}

/** Tear down the PS host. Safe to call multiple times. */
export function shutdownPsHost(): void {
	const ps = psProcess;
	psProcess = null;
	psSetupPromise = null;
	failAllPending();
	if (ps && !ps.killed) {
		try {
			ps.stdin?.end();
		} catch {
			// best-effort
		}
		try {
			ps.kill();
		} catch {
			// best-effort
		}
	}
}

/** Test hook: reset module state. */
export function __resetPsHostForTesting__(): void {
	shutdownPsHost();
	nextId = 1;
	stdoutBuffer = "";
}
