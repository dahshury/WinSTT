import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { IPC } from "@/shared/api/ipc-channels";
import {
	buildPhaseLabel,
	buildProgressLabel,
	composeBarLabel,
	firstString,
	useTtsDownloadProgress,
} from "./use-tts-download-progress";

// Minimal translator stub: every helper consumes a `next-intl` translator,
// but the helpers only call it with stable keys. A keyed lookup table is
// enough — and keeps the tests free of an i18n provider.
function makeTranslator(): ReturnType<typeof translatorFactory> {
	return translatorFactory();
}

// The local keyed-lookup `t` only implements the (key, values) overload the
// helpers exercise; this contains the single boundary cast to the real
// translator type — the returned function is the exact `t` passed in.
type StubTranslator = (key: string, values?: Record<string, string>) => string;
const asTranslator = (fn: StubTranslator) => fn as unknown as Parameters<typeof buildPhaseLabel>[0];

function translatorFactory() {
	const phrases: Record<string, string> = {
		installPhaseEngine: "Installing TTS engine",
		installPhaseModel: "Downloading voice model",
		downloading: "Downloading…",
		downloadingProgress: "PROGRESS",
	};
	function t(key: string, values?: Record<string, string>): string {
		const base = phrases[key] ?? `[[${key}]]`;
		if (!values) {
			return base;
		}
		return Object.entries(values).reduce((acc, [k, v]) => `${acc}|${k}=${v}`, base);
	}
	// Mirrors the next-intl Translator overloads enough for the helpers we test.
	return asTranslator(t);
}

describe("buildPhaseLabel", () => {
	test("'engine' phase maps to the engine label", () => {
		expect(buildPhaseLabel(makeTranslator(), "engine")).toBe("Installing TTS engine");
	});

	test("'model' phase maps to the voice-model label", () => {
		expect(buildPhaseLabel(makeTranslator(), "model")).toBe("Downloading voice model");
	});

	test("'ready' phase resolves to empty (no prefix)", () => {
		expect(buildPhaseLabel(makeTranslator(), "ready")).toBe("");
	});

	test("'unknown' phase resolves to empty", () => {
		expect(buildPhaseLabel(makeTranslator(), "unknown")).toBe("");
	});

	test("null phase resolves to empty", () => {
		expect(buildPhaseLabel(makeTranslator(), null)).toBe("");
	});
});

describe("firstString", () => {
	test("returns the first non-null/undefined string", () => {
		expect(firstString(null, undefined, "a", "b")).toBe("a");
	});

	test("falls through nulls to the fallback", () => {
		expect(firstString(null, "fallback")).toBe("fallback");
	});

	test("empty string still counts as a string", () => {
		expect(firstString("", "fallback")).toBe("");
	});

	test("returns '' (honest), not undefined, when no candidate is a string", () => {
		// Regression: the old impl `as string`-cast a missing `find()` result,
		// so this path returned `undefined` typed as `string` — a lie. The fix
		// coalesces onto "" so the value is genuinely a string at runtime.
		const out = firstString(null, undefined);
		expect(out).toBe("");
		expect(typeof out).toBe("string");
	});
});

describe("buildProgressLabel", () => {
	test("falls back to the bare 'downloading' label when totalBytes is 0", () => {
		const t = makeTranslator();
		expect(
			buildProgressLabel(t, {
				active: true,
				progress: 0,
				downloadedBytes: 0,
				totalBytes: 0,
				paused: false,
			})
		).toBe("Downloading…");
	});

	test("emits a full progress payload (percent + downloaded + total) when sized", () => {
		const t = makeTranslator();
		// 25% of 1 MiB downloaded.
		const out = buildProgressLabel(t, {
			active: true,
			progress: 0.25,
			downloadedBytes: 262_144,
			totalBytes: 1_048_576,
			paused: false,
		});
		expect(out.startsWith("PROGRESS")).toBe(true);
		expect(out).toContain("percent=25");
		expect(out).toContain("downloaded=");
		expect(out).toContain("total=");
	});
});

describe("composeBarLabel", () => {
	test("prefixes the phase label with ' · ' when present", () => {
		expect(composeBarLabel("Installing TTS engine", "Downloading…")).toBe(
			"Installing TTS engine · Downloading…"
		);
	});

	test("returns just the progress label when phase is empty", () => {
		expect(composeBarLabel("", "Downloading…")).toBe("Downloading…");
	});

	test("returns just the phase label when progress is empty (defensive)", () => {
		expect(composeBarLabel("Phase", "")).toBe("Phase");
	});

	test("returns empty string when both inputs are empty", () => {
		expect(composeBarLabel("", "")).toBe("");
	});
});

// ── Hook integration ────────────────────────────────────────────────────
// The hook subscribes to five IPC channels through the REAL ipc-client, which
// reads `window.electronAPI.on` at call time. We swap in a listener registry
// so each `on*` subscription lands in `listeners` and we can drive the real
// `applyProgressEvent` + functional state updaters by firing payloads.
const originalApi = window.electronAPI;
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
const unsubscribed: string[] = [];

beforeEach(() => {
	listeners.clear();
	unsubscribed.length = 0;
	window.electronAPI = {
		...originalApi,
		on: (channel: string, cb: (...args: unknown[]) => void) => {
			const list = listeners.get(channel) ?? [];
			list.push(cb);
			listeners.set(channel, list);
			return () => {
				unsubscribed.push(channel);
				listeners.set(
					channel,
					(listeners.get(channel) ?? []).filter((x) => x !== cb)
				);
			};
		},
	};
});

afterEach(() => {
	window.electronAPI = originalApi;
});

function fire(channel: string, ...args: unknown[]): void {
	for (const cb of [...(listeners.get(channel) ?? [])]) {
		cb(...args);
	}
}

function renderProgress(installPhase: Parameters<typeof useTtsDownloadProgress>[0] = null) {
	return renderHook(({ phase }) => useTtsDownloadProgress(phase), {
		initialProps: { phase: installPhase },
		wrapper: ({ children }) => <IntlProvider>{children}</IntlProvider>,
	});
}

describe("useTtsDownloadProgress", () => {
	test("subscribes to all five install/download channels on mount", () => {
		renderProgress();
		expect(listeners.has(IPC.TTS_MODEL_DOWNLOAD_START)).toBe(true);
		expect(listeners.has(IPC.TTS_MODEL_DOWNLOAD_PROGRESS)).toBe(true);
		expect(listeners.has(IPC.TTS_MODEL_DOWNLOAD_COMPLETE)).toBe(true);
		expect(listeners.has(IPC.TTS_INSTALL_PAUSED)).toBe(true);
		expect(listeners.has(IPC.TTS_INSTALL_RESUMED)).toBe(true);
	});

	test("starts inactive at 0% with no label segments", () => {
		const { result } = renderProgress();
		expect(result.current.active).toBe(false);
		expect(result.current.paused).toBe(false);
		expect(result.current.percent).toBe(0);
		// No phase (null) + totalBytes 0 → just the bare "downloading" line.
		expect(result.current.label).toBe("Downloading model…");
	});

	test("download-start flips active true and resets to a fresh state", () => {
		const { result } = renderProgress();
		act(() => fire(IPC.TTS_MODEL_DOWNLOAD_START));
		expect(result.current.active).toBe(true);
		expect(result.current.paused).toBe(false);
		expect(result.current.percent).toBe(0);
	});

	test("a progress event applies bytes + percent and stays active (applyProgressEvent)", () => {
		const { result } = renderProgress();
		act(() =>
			fire(IPC.TTS_MODEL_DOWNLOAD_PROGRESS, {
				downloadedBytes: 262_144,
				progress: 0.25,
				totalBytes: 1_048_576,
			})
		);
		expect(result.current.active).toBe(true);
		expect(result.current.paused).toBe(false);
		expect(result.current.percent).toBe(25);
		// totalBytes > 0 → full progress line, not the bare placeholder.
		expect(result.current.label).toContain("25%");
	});

	test("a sub-1 MB progress event renders KB, not '0 MB' (minUnit: 'B')", () => {
		// Regression: `formatBytes` defaults to `minUnit: "MB"`, which floors any
		// value under 1 MB to "0 MB". The download progress line must pass
		// `minUnit: "B"` so the early bytes read as real sizes (256 KB / 512 KB)
		// instead of a stuck "0 MB of 0 MB".
		const { result } = renderProgress();
		act(() =>
			fire(IPC.TTS_MODEL_DOWNLOAD_PROGRESS, {
				downloadedBytes: 262_144, // 256 KB
				progress: 0.5,
				totalBytes: 524_288, // 512 KB
			})
		);
		expect(result.current.label).toContain("KB");
		expect(result.current.label).not.toContain("0 MB");
		expect(result.current.label).toContain("256.0 KB");
		expect(result.current.label).toContain("512.0 KB");
	});

	test("a progress event arriving while paused clears the paused flag (resume round-trip)", () => {
		const { result } = renderProgress();
		// Enter paused via the server-confirmed pause event …
		act(() => fire(IPC.TTS_INSTALL_PAUSED));
		expect(result.current.paused).toBe(true);
		// … then a chunk lands: applyProgressEvent forces paused:false.
		act(() =>
			fire(IPC.TTS_MODEL_DOWNLOAD_PROGRESS, {
				downloadedBytes: 10,
				progress: 0.5,
				totalBytes: 20,
			})
		);
		expect(result.current.paused).toBe(false);
		expect(result.current.percent).toBe(50);
	});

	test("install-paused flips paused true and the label switches to the paused string", () => {
		const { result } = renderProgress();
		act(() =>
			fire(IPC.TTS_MODEL_DOWNLOAD_PROGRESS, {
				downloadedBytes: 5,
				progress: 0.1,
				totalBytes: 50,
			})
		);
		act(() => fire(IPC.TTS_INSTALL_PAUSED));
		expect(result.current.paused).toBe(true);
		// download.paused ? t("paused") : buildProgressLabel(...) — paused branch.
		expect(result.current.label).toBe("Paused");
		// Percent is preserved across the pause.
		expect(result.current.percent).toBe(10);
	});

	test("install-resumed flips paused back to false", () => {
		const { result } = renderProgress();
		act(() => fire(IPC.TTS_INSTALL_PAUSED));
		expect(result.current.paused).toBe(true);
		act(() => fire(IPC.TTS_INSTALL_RESUMED));
		expect(result.current.paused).toBe(false);
	});

	test("download-complete resets the descriptor back to inactive INITIAL", () => {
		const { result } = renderProgress();
		act(() =>
			fire(IPC.TTS_MODEL_DOWNLOAD_PROGRESS, {
				downloadedBytes: 9,
				progress: 0.9,
				totalBytes: 10,
			})
		);
		expect(result.current.active).toBe(true);
		act(() => fire(IPC.TTS_MODEL_DOWNLOAD_COMPLETE, { cancelled: false }));
		expect(result.current.active).toBe(false);
		expect(result.current.percent).toBe(0);
		expect(result.current.paused).toBe(false);
	});

	test("the install phase is prefixed onto the bar label (composeBarLabel)", () => {
		const { result } = renderProgress("engine");
		// Phase prefix ("Installing engine") joined with the bare progress line.
		expect(result.current.label).toBe("Installing engine · Downloading model…");
	});

	test("'model' phase prefix combined with a sized progress line", () => {
		const { result } = renderProgress("model");
		act(() =>
			fire(IPC.TTS_MODEL_DOWNLOAD_PROGRESS, {
				downloadedBytes: 50,
				progress: 0.5,
				totalBytes: 100,
			})
		);
		expect(result.current.label.startsWith("Installing voice model · ")).toBe(true);
		expect(result.current.label).toContain("50%");
	});

	test("a changed installPhase prop re-derives the label without re-subscribing", () => {
		const { result, rerender } = renderProgress("engine");
		expect(result.current.label.startsWith("Installing engine")).toBe(true);
		rerender({ phase: "model" });
		expect(result.current.label.startsWith("Installing voice model")).toBe(true);
		// Effects have empty deps → exactly one subscription per channel, no churn.
		expect((listeners.get(IPC.TTS_MODEL_DOWNLOAD_PROGRESS) ?? []).length).toBe(1);
	});

	test("unmount tears down every channel subscription (no listener leak)", () => {
		const { unmount } = renderProgress();
		unmount();
		expect(unsubscribed).toContain(IPC.TTS_MODEL_DOWNLOAD_START);
		expect(unsubscribed).toContain(IPC.TTS_MODEL_DOWNLOAD_PROGRESS);
		expect(unsubscribed).toContain(IPC.TTS_MODEL_DOWNLOAD_COMPLETE);
		expect(unsubscribed).toContain(IPC.TTS_INSTALL_PAUSED);
		expect(unsubscribed).toContain(IPC.TTS_INSTALL_RESUMED);
		// All five channel listener-lists are empty after unmount.
		for (const channel of [
			IPC.TTS_MODEL_DOWNLOAD_START,
			IPC.TTS_MODEL_DOWNLOAD_PROGRESS,
			IPC.TTS_MODEL_DOWNLOAD_COMPLETE,
			IPC.TTS_INSTALL_PAUSED,
			IPC.TTS_INSTALL_RESUMED,
		]) {
			expect((listeners.get(channel) ?? []).length).toBe(0);
		}
	});
});
