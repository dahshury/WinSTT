/**
 * Renderer-side host-OS signal, sourced from `@tauri-apps/plugin-os`.
 *
 * `platform()` / `version()` are SYNCHRONOUS in Tauri v2 — the values are
 * injected into `window.__TAURI_OS_PLUGIN_INTERNALS__` at window creation, so
 * there's no IPC round trip. They throw in a non-Tauri context (the Bun test
 * runner, a bare browser), so every read is wrapped and degrades to
 * `"unknown"` — consumers then fall back to their own safe default rather than
 * crashing the render.
 *
 * This is the app's canonical OS gate. Prefer it over `navigator.userAgent`
 * sniffing: inside a WebView the UA string is the embedder's, not always the
 * host's, whereas the plugin reads the value the native side compiled in.
 */
import { platform, version } from "@tauri-apps/plugin-os";

type HostPlatform =
	| "windows"
	| "macos"
	| "linux"
	| "ios"
	| "android"
	| "unknown";

/** The host OS, or `"unknown"` outside a Tauri runtime. Module-internal — the
 *  exported capability helpers below are the public surface. */
function hostPlatform(): HostPlatform {
	try {
		const p = platform();
		// `platform()` can report the BSD family too; collapse everything we
		// don't special-case into `"linux"` (unix-like) so gating stays binary.
		switch (p) {
			case "windows":
			case "macos":
			case "linux":
			case "ios":
			case "android":
				return p;
			default:
				return "linux";
		}
	} catch {
		return "unknown";
	}
}

/** True for the three desktop OSes WinSTT actually ships on. */
function isDesktopHost(): boolean {
	const p = hostPlatform();
	return p === "windows" || p === "macos" || p === "linux";
}

/**
 * Display label for the platform's "Meta"/"Super" modifier key. macOS calls it
 * Command (⌘), most Linux desktops call it Super, Windows calls it the Windows
 * key. Falls back to "Win" for `unknown` since WinSTT is Windows-first.
 */
export function metaKeyLabel(): string {
	switch (hostPlatform()) {
		case "macos":
			return "⌘";
		case "linux":
			return "Super";
		default:
			return "Win";
	}
}

/**
 * Parse the OS major version as an integer. Returns `null` when the runtime
 * doesn't expose it (non-Tauri) or the string can't be read — callers MUST
 * treat `null` as "unknown, assume capable" so a parse miss never disables a
 * feature that actually works.
 */
function osMajorVersion(): number | null {
	try {
		const raw = version();
		const major = Number.parseInt(raw.split(".")[0] ?? "", 10);
		return Number.isFinite(major) ? major : null;
	} catch {
		return null;
	}
}

interface CapabilityReport {
	/** Short reason shown in a tooltip when `supported` is false. */
	reason?: string;
	supported: boolean;
}

/**
 * Whether this host can capture other apps' UI text for context awareness
 * (UIA on Windows, AX on macOS, AT-SPI on Linux). All three desktop OSes are
 * wired; only non-desktop / non-Tauri hosts report unsupported. Kept as a
 * capability report (not a bare bool) so the single call site can surface an
 * explanatory tooltip instead of an always-empty toggle.
 */
export function contextAwarenessSupport(): CapabilityReport {
	if (isDesktopHost()) {
		return { supported: true };
	}
	return {
		supported: false,
		reason: "Context awareness needs a desktop operating system.",
	};
}

/**
 * Whether this host can capture speaker/system audio for Listen mode
 * (WASAPI loopback on Windows, ScreenCaptureKit on macOS ≥ 13, PipeWire /
 * PulseAudio monitors on Linux). Older macOS lacks the ScreenCaptureKit audio
 * path, so it reports unsupported; an unparseable version is treated as
 * capable so a version-read miss never falsely disables the mode.
 */
export function listenModeSupport(): CapabilityReport {
	const p = hostPlatform();
	if (p === "windows" || p === "linux") {
		return { supported: true };
	}
	if (p === "macos") {
		const major = osMajorVersion();
		// macOS 13 (Ventura) is Darwin-reported as "13.x" by Tauri's `version()`.
		if (major !== null && major < 13) {
			return {
				supported: false,
				reason: "Listen mode needs macOS 13 (Ventura) or newer.",
			};
		}
		return { supported: true };
	}
	return {
		supported: false,
		reason: "Listen mode needs a desktop operating system.",
	};
}
