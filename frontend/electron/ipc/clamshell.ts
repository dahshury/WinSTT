/**
 * Clamshell-mic switching.
 *
 * When the user closes the laptop lid (the "clamshell" state), swap the
 * active microphone to a user-configured alternate (typically an external
 * USB mic plugged into a dock). When the lid reopens, swap back to the
 * previously-selected primary mic. The detector is OFF by default and
 * only spins up when `audio.clamshellMicrophone` is non-null — there is
 * no value in polling the OS every five seconds for users who don't
 * docked-clamshell.
 *
 * Detection strategy (no native modules — shell-outs + file reads only):
 *   - macOS:   `ioreg -r -k AppleClamshellState -d 4` snapshots the
 *              IORegistry; the literal substring `"AppleClamshellState" = Yes`
 *              indicates the lid is closed.
 *   - Linux:   /proc/acpi/button/lid/LID*\/state (legacy) or
 *              /proc/acpi/button/lid/LID0/state is a small text file that
 *              reads "closed" or "open". Some distros also expose it under
 *              `/sys/class/power_supply/` but the proc path is universal
 *              when present.
 *   - Windows: deferred to v1.1. Win32 has no zero-cost equivalent probe
 *              (the OS sends a WM_POWERBROADCAST notification but capturing
 *              that needs a native module). Clamshell-with-dock setups are
 *              uncommon on Windows laptops anyway — users typically dock
 *              with the lid open.
 *
 * Debounce: events only fire on STATE TRANSITIONS (open→closed,
 * closed→open). Re-polling the same closed state every 5s does not
 * re-emit. The first poll-after-start does NOT emit either — the initial
 * state is captured silently so a user who launches WinSTT with the lid
 * already closed doesn't get an unsolicited swap.
 */

import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { BrowserWindow } from "electron";
import { IPC } from "../../src/shared/api/ipc-channels";
import { dbg } from "../lib/debug-log";
import { store } from "../lib/store";
import type { SttClient } from "../ws/stt-client";

/** Default poll interval for the clamshell lid-state probe. */
export const CLAMSHELL_POLL_INTERVAL_MS = 5000;

/** Tag for promise-rejection swallowers attached to fire-and-forget calls. */
const noop = (): void => undefined;

/**
 * Three-state lid model. `unknown` is the bootstrap state before the first
 * successful probe; transitions out of `unknown` do NOT fire events (we
 * don't know what the previous state was, so any "change" is fictional).
 */
export type LidState = "open" | "closed" | "unknown";

/**
 * Abstraction over the OS-side probe so tests can inject canned outputs
 * without monkey-patching `child_process` / `fs`. The probe returns
 * `unknown` whenever it can't determine the state (file missing, command
 * failed, output unparsable) — never throws, never blocks.
 */
export type LidProbe = () => Promise<LidState>;

// ── macOS probe ─────────────────────────────────────────────────────

/**
 * Parse `ioreg -r -k AppleClamshellState -d 4` output. The relevant line
 * looks like `"AppleClamshellState" = Yes` (closed) or `... = No` (open).
 * If neither substring is present, the machine is likely a desktop Mac
 * (no clamshell sensor) — we return `unknown` so the detector stays inert.
 */
export function parseIoregClamshell(stdout: string): LidState {
	if (stdout.includes('"AppleClamshellState" = Yes')) {
		return "closed";
	}
	if (stdout.includes('"AppleClamshellState" = No')) {
		return "open";
	}
	return "unknown";
}

function probeMacOs(): Promise<LidState> {
	return new Promise<LidState>((resolve) => {
		execFile(
			"ioreg",
			["-r", "-k", "AppleClamshellState", "-d", "4"],
			// `-d 4` snapshots four levels of the IORegistry; on some Macs that
			// payload exceeds Node's default 1 MB stdout cap and execFile would
			// error with ERR_CHILD_PROCESS_STDIO_MAXBUFFER (probe → "unknown",
			// detector goes inert). Bump to 8 MB so a verbose registry still
			// parses.
			{ timeout: 2000, maxBuffer: 8 * 1024 * 1024 },
			(err, stdout) => {
				if (err) {
					dbg("clamshell", `ioreg failed: ${err.message}`);
					resolve("unknown");
					return;
				}
				resolve(parseIoregClamshell(String(stdout)));
			}
		);
	});
}

// ── Linux probe ─────────────────────────────────────────────────────

/**
 * Map the contents of a /proc/acpi/button/lid/LIDx/state file to a
 * `LidState`. The file reads e.g. `state:      closed\n` — we take the
 * last token of the last non-empty line for tolerance against future
 * format drift. Returns `unknown` for any output that doesn't include
 * the literal `closed` or `open` substrings.
 */
export function parseLinuxLidState(text: string): LidState {
	const trimmed = text.toLowerCase();
	if (trimmed.includes("closed")) {
		return "closed";
	}
	if (trimmed.includes("open")) {
		return "open";
	}
	return "unknown";
}

async function findLinuxLidPath(): Promise<string | null> {
	try {
		const entries = await readdir("/proc/acpi/button/lid");
		// Sort so the pick is deterministic when a machine exposes more than
		// one LID node (e.g. LID0 + LID1) — readdir order is filesystem-
		// dependent, so without sorting we could bind to a different lid
		// across reboots. LID0 (the lowest-numbered) is the conventional
		// primary lid.
		const lidDir = entries
			.filter((e) => e.toUpperCase().startsWith("LID"))
			.sort((a, b) => a.localeCompare(b))[0];
		return lidDir ? `/proc/acpi/button/lid/${lidDir}/state` : null;
	} catch {
		return null;
	}
}

async function probeLinux(): Promise<LidState> {
	const path = await findLinuxLidPath();
	if (!path) {
		return "unknown";
	}
	try {
		const text = await readFile(path, "utf-8");
		return parseLinuxLidState(text);
	} catch (err) {
		dbg("clamshell", `lid file read failed: ${String(err)}`);
		return "unknown";
	}
}

// ── Windows probe (deferred) ─────────────────────────────────────────

/**
 * Windows has no zero-cost lid probe — capturing WM_POWERBROADCAST
 * needs a native module, which is explicitly off the table for this
 * feature. We always return `unknown` so the detector stays dormant on
 * Windows; the setting itself is still persisted so a user who migrates
 * a settings file from macOS/Linux to Windows doesn't lose their
 * configured clamshell mic.
 */
function probeWindows(): Promise<LidState> {
	return Promise.resolve("unknown");
}

/**
 * Select the right probe for the current host. `process.platform` is a
 * compile-time constant under Node, so test code can inject a custom
 * probe via the detector constructor rather than monkey-patching the
 * global.
 */
export function defaultProbeForPlatform(platform: NodeJS.Platform): LidProbe {
	if (platform === "darwin") {
		return probeMacOs;
	}
	if (platform === "linux") {
		return probeLinux;
	}
	return probeWindows;
}

// ── Mic-swap glue ───────────────────────────────────────────────────

/**
 * Ports the detector calls into the rest of the app. Pulled into an
 * interface so tests can drive the state machine without booting the
 * real `SttClient`, electron-store, or BrowserWindow stack.
 */
export interface ClamshellSwapDeps {
	/** Broadcast a renderer event so the UI can show a toast or chip. */
	broadcastLidEvent(channel: typeof IPC.LID_CLOSED | typeof IPC.LID_OPENED): void;
	/** Push the index to the live STT server via `set_parameter`. */
	pushDeviceToServer(value: number | null): void;
	/** Read the current `audio.inputDeviceIndex` from the store. */
	readInputDeviceIndex(): number | null;
	/** Persist `audio.inputDeviceIndex` so the renderer also stays in sync. */
	saveInputDeviceIndex(value: number | null): void;
}

/**
 * The transition table. Pure function — given a previous + next lid
 * state and the current settings, return what swap (if any) to apply.
 *
 * `previousInputDeviceIndex` is the mic the user had selected the LAST
 * time the lid was open (or at app start, if the lid started open). It
 * is what we restore to when the lid reopens. `null` means "system
 * default" and is a valid value.
 *
 * The function never throws and never mutates inputs — callers apply
 * the returned action.
 */
export interface SwapDecision {
	kind: "swap-to-clamshell" | "restore-primary" | "no-op";
	target: number | null;
}

export function decideSwap(
	previous: LidState,
	next: LidState,
	clamshellMicrophone: number | null,
	previousInputDeviceIndex: number | null
): SwapDecision {
	// Bootstrap transitions (unknown → anything) never trigger a swap.
	// We don't know what the user "would have wanted" before we knew the
	// lid state, so the first poll captures state silently.
	if (previous === "unknown") {
		return { kind: "no-op", target: null };
	}
	// Feature disabled — nothing to do.
	if (clamshellMicrophone == null) {
		return { kind: "no-op", target: null };
	}
	if (previous === "open" && next === "closed") {
		return { kind: "swap-to-clamshell", target: clamshellMicrophone };
	}
	if (previous === "closed" && next === "open") {
		return { kind: "restore-primary", target: previousInputDeviceIndex };
	}
	return { kind: "no-op", target: null };
}

// ── Detector ────────────────────────────────────────────────────────

export interface ClamshellDetectorOptions {
	/** Injected swap deps. Real wiring is in `setupClamshellHandlers`. */
	deps: ClamshellSwapDeps;
	/** Override the platform — primarily for tests. */
	platform?: NodeJS.Platform;
	/** Override the poll interval — primarily for tests. */
	pollIntervalMs?: number;
	/** Override the OS probe — primarily for tests. */
	probe?: LidProbe;
	/** Read the configured clamshell mic index (live, every poll). */
	readClamshellMicrophone: () => number | null;
}

/**
 * State machine driving the OS lid probe + mic swap. Owns:
 *   - the `setInterval` timer (cleared on stop / app quit)
 *   - the last-known lid state (so transitions are computed deterministically)
 *   - the "saved primary mic" snapshot, captured when the lid first closes
 *     so a restore returns to exactly what the user had picked (and not
 *     the clamshell mic itself, which IS the value of `inputDeviceIndex`
 *     while the lid is closed).
 *
 * Construction is cheap; `start()` schedules the first poll on next-tick.
 * `stop()` is idempotent and safe to call from any point in the lifecycle.
 */
export class ClamshellDetector {
	private readonly probe: LidProbe;
	private readonly pollIntervalMs: number;
	private readonly deps: ClamshellSwapDeps;
	private readonly readClamshellMicrophone: () => number | null;

	private timer: ReturnType<typeof setInterval> | null = null;
	private lastState: LidState = "unknown";
	/**
	 * Cached primary mic — captured on the open→closed transition so the
	 * matching closed→open transition can restore it. Without this, a
	 * naive "read current inputDeviceIndex on restore" would read back
	 * the clamshell mic itself.
	 */
	private cachedPrimary: number | null = null;
	private polling = false;

	constructor(options: ClamshellDetectorOptions) {
		this.probe = options.probe ?? defaultProbeForPlatform(options.platform ?? process.platform);
		this.pollIntervalMs = options.pollIntervalMs ?? CLAMSHELL_POLL_INTERVAL_MS;
		this.deps = options.deps;
		this.readClamshellMicrophone = options.readClamshellMicrophone;
	}

	/**
	 * Begin polling. Idempotent — calling `start()` while already running
	 * is a no-op; calling `start()` after `stop()` resumes from scratch
	 * (the `lastState` is preserved across stop/start so a settings-driven
	 * restart doesn't lose track of the lid).
	 */
	start(): void {
		if (this.timer) {
			return;
		}
		dbg("clamshell", `starting detector (poll=${this.pollIntervalMs}ms)`);
		// Poll immediately so we capture the initial lid state without
		// waiting a full interval. The first call still emits no events
		// because `lastState` is `unknown`. `.catch(noop)` because the
		// probe itself swallows errors and returns `unknown` on failure;
		// nothing in `tick()` should reject, but Biome bans bare `void`
		// on a Promise so we attach a defensive no-op handler.
		this.tick().catch(noop);
		this.timer = setInterval(() => {
			this.tick().catch(noop);
		}, this.pollIntervalMs);
	}

	/**
	 * Stop polling. Idempotent. Does NOT reset `lastState` / `cachedPrimary`
	 * so a restart picks up where it left off — a user who toggles
	 * `clamshellMicrophone` from null → some-index → null → some-index
	 * doesn't get a phantom swap on each transition.
	 */
	stop(): void {
		if (!this.timer) {
			return;
		}
		dbg("clamshell", "stopping detector");
		clearInterval(this.timer);
		this.timer = null;
	}

	/** Whether the detector is currently polling. Test surface only. */
	get isRunning(): boolean {
		return this.timer !== null;
	}

	/** Last lid state observed by the probe. Test surface only. */
	get lastLidState(): LidState {
		return this.lastState;
	}

	/**
	 * Single poll cycle. Pure-ish: reads the OS, then applies the swap
	 * decision through the injected deps. Re-entrant calls (timer fires
	 * while a previous tick is still awaiting `probe()`) are coalesced
	 * via `polling`.
	 */
	async tick(): Promise<void> {
		if (this.polling) {
			return;
		}
		this.polling = true;
		try {
			const next = await this.probe();
			this.applyTransition(this.lastState, next);
			this.lastState = next;
		} finally {
			this.polling = false;
		}
	}

	private applyTransition(previous: LidState, next: LidState): void {
		const decision = decideSwap(previous, next, this.readClamshellMicrophone(), this.cachedPrimary);
		if (decision.kind === "no-op") {
			return;
		}
		if (decision.kind === "swap-to-clamshell") {
			// Snapshot the current primary BEFORE we overwrite it, so the
			// matching restore lands on the right device.
			this.cachedPrimary = this.deps.readInputDeviceIndex();
			dbg(
				"clamshell",
				`lid closed → swap to clamshell mic (${String(decision.target)}); cached primary=${String(this.cachedPrimary)}`
			);
			this.deps.pushDeviceToServer(decision.target);
			this.deps.saveInputDeviceIndex(decision.target);
			this.deps.broadcastLidEvent(IPC.LID_CLOSED);
			return;
		}
		// restore-primary
		dbg("clamshell", `lid opened → restore primary mic (${String(decision.target)})`);
		this.deps.pushDeviceToServer(decision.target);
		this.deps.saveInputDeviceIndex(decision.target);
		this.deps.broadcastLidEvent(IPC.LID_OPENED);
		// Clear the cached primary so a subsequent open→closed transition
		// re-snapshots fresh. Stale values would otherwise restore to a
		// mic the user has since unplugged.
		this.cachedPrimary = null;
	}
}

// ── Bootstrap glue ──────────────────────────────────────────────────

/**
 * The store key reads the section, not the leaf, so we narrow with a
 * runtime guard. Defensive: a corrupt section value yields `null`
 * (feature disabled) rather than throwing.
 */
function readClamshellMicrophoneFromStore(): number | null {
	const audio = store.get("audio") as unknown;
	if (!(audio && typeof audio === "object")) {
		return null;
	}
	const value = (audio as Record<string, unknown>).clamshellMicrophone;
	return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function readInputDeviceIndexFromStore(): number | null {
	const audio = store.get("audio") as unknown;
	if (!(audio && typeof audio === "object")) {
		return null;
	}
	const value = (audio as Record<string, unknown>).inputDeviceIndex;
	return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function saveInputDeviceIndexToStore(value: number | null): void {
	store.set("audio.inputDeviceIndex", value);
}

function broadcastLidEventToAllWindows(
	channel: typeof IPC.LID_CLOSED | typeof IPC.LID_OPENED
): void {
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) {
			win.webContents.send(channel, {});
		}
	}
}

function pushDeviceToSttServer(sttClient: SttClient, value: number | null): void {
	if (!sttClient.isConnected) {
		return;
	}
	sttClient.setParameter("input_device_index", value);
}

/**
 * Wire the detector to the live electron-store + SttClient + windows.
 * Returns a teardown function that stops the detector and removes the
 * settings watcher. Safe to call before `app.whenReady()` resolves —
 * polling itself only kicks in once we observe a non-null
 * `audio.clamshellMicrophone`.
 *
 * The settings watcher (`store.onDidChange("audio", ...)`) toggles the
 * detector on / off in response to live config changes, so a user who
 * sets the alternate mic from the Settings panel doesn't need to relaunch
 * the app for the polling to begin.
 */
export function setupClamshellHandlers(sttClient: SttClient): () => void {
	const deps: ClamshellSwapDeps = {
		saveInputDeviceIndex: saveInputDeviceIndexToStore,
		readInputDeviceIndex: readInputDeviceIndexFromStore,
		pushDeviceToServer: (value) => pushDeviceToSttServer(sttClient, value),
		broadcastLidEvent: broadcastLidEventToAllWindows,
	};

	const detector = new ClamshellDetector({
		deps,
		readClamshellMicrophone: readClamshellMicrophoneFromStore,
	});

	const refresh = (): void => {
		const configured = readClamshellMicrophoneFromStore();
		if (configured != null && !detector.isRunning) {
			detector.start();
		} else if (configured == null && detector.isRunning) {
			detector.stop();
		}
	};

	refresh();
	const dispose = store.onDidChange("audio", refresh);

	return () => {
		dispose();
		detector.stop();
	};
}
