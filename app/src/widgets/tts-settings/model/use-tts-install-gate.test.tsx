import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
	TtsDownloadEstimatePayload,
	TtsInstallFailedPayload,
	TtsInstallPhase,
	TtsInstallStatusPayload,
} from "@/shared/api/ipc-client";

function makeEstimate(
	partial: Partial<TtsDownloadEstimatePayload> = {}
): TtsDownloadEstimatePayload {
	return {
		alreadyInstalled: partial.alreadyInstalled ?? false,
		components: partial.components ?? [],
		totalBytes: partial.totalBytes ?? 0,
		// `unavailable` is optional — only spread when explicitly provided so the
		// "missing" case stays representable.
		...(partial.unavailable === undefined ? {} : { unavailable: partial.unavailable }),
	};
}

// ── ipc-client mock surface ────────────────────────────────────────────────
// The hook calls FIVE ipc-client exports directly. We control each one so the
// effect subscriptions + the probe round-trip are observable:
//   - ttsDownloadEstimate(): the size-probe round-trip. We resolve it with a
//     test-controlled payload (or a rejecting promise to exercise `finally`).
//   - initTts(): the retry re-trigger. We count calls.
//   - onTtsInstallStatus / onTtsInstallFailed / onTtsModelDownloadComplete:
//     the three useEffect subscriptions. We capture their callbacks so the
//     test can synthesise server pings, and hand back spy unsubscribers to
//     assert cleanup on unmount.
let estimateImpl: () => Promise<TtsDownloadEstimatePayload> = async () => makeEstimate();
let initTtsCalls = 0;
let statusCb: ((payload: TtsInstallStatusPayload) => void) | null = null;
let failedCb: ((payload: TtsInstallFailedPayload) => void) | null = null;
let completeCb: ((payload: { cancelled: boolean }) => void) | null = null;
let statusUnsub = 0;
let failedUnsub = 0;
let completeUnsub = 0;

const ttsDownloadEstimateSpy = (): Promise<TtsDownloadEstimatePayload> => estimateImpl();
const initTtsSpy = (): Promise<{ ready: boolean }> => {
	initTtsCalls += 1;
	return Promise.resolve({ ready: false });
};
const onTtsInstallStatusSpy = (cb: (payload: TtsInstallStatusPayload) => void): (() => void) => {
	statusCb = cb;
	return () => {
		statusUnsub += 1;
		statusCb = null;
	};
};
const onTtsInstallFailedSpy = (cb: (payload: TtsInstallFailedPayload) => void): (() => void) => {
	failedCb = cb;
	return () => {
		failedUnsub += 1;
		failedCb = null;
	};
};
const onTtsModelDownloadCompleteSpy = (
	cb: (payload: { cancelled: boolean }) => void
): (() => void) => {
	completeCb = cb;
	return () => {
		completeUnsub += 1;
		completeCb = null;
	};
};

mock.module("@/shared/api/ipc-client", () => ({
	...ipcClientMock(),
	ttsDownloadEstimate: ttsDownloadEstimateSpy,
	initTts: initTtsSpy,
	onTtsInstallStatus: onTtsInstallStatusSpy,
	onTtsInstallFailed: onTtsInstallFailedSpy,
	onTtsModelDownloadComplete: onTtsModelDownloadCompleteSpy,
}));

const { DEFAULT_SETTINGS, useSettingsStore } = await import("@/entities/setting");
const {
	buildTtsEnablePatch,
	projectInstallPhase,
	resolveConfirmAction,
	resolveProbeAction,
	resolveToggleAction,
	useTtsInstallGate,
} = await import("./use-tts-install-gate");

function setTtsHotkey(hotkey: string | undefined): void {
	useSettingsStore.setState({
		settings: {
			...DEFAULT_SETTINGS,
			tts: hotkey === undefined ? ({} as never) : { ...DEFAULT_SETTINGS.tts, hotkey },
		},
		isLoaded: true,
	});
}

function currentTts(): { enabled?: boolean; hotkey?: string } {
	return useSettingsStore.getState().settings.tts as { enabled?: boolean; hotkey?: string };
}

beforeEach(() => {
	estimateImpl = async () => makeEstimate();
	initTtsCalls = 0;
	statusCb = null;
	failedCb = null;
	completeCb = null;
	statusUnsub = 0;
	failedUnsub = 0;
	completeUnsub = 0;
	// Start each test from the schema defaults (enabled: false, default hotkey).
	useSettingsStore.setState({
		settings: { ...DEFAULT_SETTINGS, tts: { ...DEFAULT_SETTINGS.tts } },
		isLoaded: true,
	});
});

afterEach(() => {
	cleanup();
});

// ── Pure helpers (kept from the original .test.ts; the .tsx file is now the
// single colocated test for this slice) ─────────────────────────────────────
describe("projectInstallPhase", () => {
	test("'ready' collapses to null (idle)", () => {
		expect(projectInstallPhase("ready")).toBeNull();
	});

	test("'engine' / 'model' / 'unknown' pass through unchanged", () => {
		expect(projectInstallPhase("engine")).toBe("engine");
		expect(projectInstallPhase("model")).toBe("model");
		expect(projectInstallPhase("unknown")).toBe("unknown");
	});
});

describe("resolveProbeAction", () => {
	test("alreadyInstalled + reachable → 'enable' (skip the dialog)", () => {
		expect(resolveProbeAction(makeEstimate({ alreadyInstalled: true, unavailable: false }))).toBe(
			"enable"
		);
	});

	test("alreadyInstalled but unavailable → 'confirm' (show the dialog)", () => {
		expect(resolveProbeAction(makeEstimate({ alreadyInstalled: true, unavailable: true }))).toBe(
			"confirm"
		);
	});

	test("not installed + reachable → 'confirm' (size the download first)", () => {
		expect(resolveProbeAction(makeEstimate({ alreadyInstalled: false, unavailable: false }))).toBe(
			"confirm"
		);
	});

	test("not installed + unavailable → 'confirm' (offline-aware dialog)", () => {
		expect(resolveProbeAction(makeEstimate({ alreadyInstalled: false, unavailable: true }))).toBe(
			"confirm"
		);
	});

	test("treats missing unavailable as 'reachable' (the install-pack default)", () => {
		expect(resolveProbeAction(makeEstimate({ alreadyInstalled: true }))).toBe("enable");
	});
});

describe("resolveConfirmAction", () => {
	test("offline estimate → 'retry' (button becomes a re-probe)", () => {
		expect(resolveConfirmAction(makeEstimate({ unavailable: true }))).toBe("retry");
	});

	test("reachable estimate → 'enable' (commit the toggle)", () => {
		expect(resolveConfirmAction(makeEstimate({ unavailable: false }))).toBe("enable");
	});

	test("missing estimate (pre-probe) → 'enable'", () => {
		expect(resolveConfirmAction(null)).toBe("enable");
	});
});

describe("resolveToggleAction", () => {
	test("true → 'enable'", () => {
		expect(resolveToggleAction(true)).toBe("enable");
	});

	test("false → 'disable'", () => {
		expect(resolveToggleAction(false)).toBe("disable");
	});
});

describe("buildTtsEnablePatch", () => {
	test("non-empty current hotkey → only flips enabled (preserves user binding)", () => {
		expect(buildTtsEnablePatch("LCtrl+S", "LWin+R")).toEqual({ enabled: true });
	});

	test("empty current hotkey → folds in the default binding", () => {
		expect(buildTtsEnablePatch("", "LWin+R")).toEqual({
			enabled: true,
			hotkey: "LWin+R",
		});
	});

	test("whitespace-only hotkey is treated as empty (folds default)", () => {
		expect(buildTtsEnablePatch("   ", "LWin+R")).toEqual({
			enabled: true,
			hotkey: "LWin+R",
		});
	});
});

// ── The hook itself ─────────────────────────────────────────────────────────
describe("useTtsInstallGate (initial state + subscriptions)", () => {
	test("starts idle: no dialog, no estimate, not probing, no phase/error", () => {
		const { result } = renderHook(() => useTtsInstallGate());
		expect(result.current.confirmOpen).toBe(false);
		expect(result.current.estimate).toBeNull();
		expect(result.current.probing).toBe(false);
		expect(result.current.installPhase).toBeNull();
		expect(result.current.installError).toBeNull();
	});

	test("subscribes to all three install feeds on mount", () => {
		renderHook(() => useTtsInstallGate());
		expect(statusCb).not.toBeNull();
		expect(failedCb).not.toBeNull();
		expect(completeCb).not.toBeNull();
	});

	test("unsubscribes from all three feeds on unmount", () => {
		const { unmount } = renderHook(() => useTtsInstallGate());
		unmount();
		expect(statusUnsub).toBe(1);
		expect(failedUnsub).toBe(1);
		expect(completeUnsub).toBe(1);
	});
});

describe("useTtsInstallGate — install-status ping effect", () => {
	test("projects a non-ready phase and clears any stale error banner", () => {
		const { result } = renderHook(() => useTtsInstallGate());
		// Seed an error first via the failed feed.
		act(() => failedCb?.({ category: "network", reason: "Offline" }));
		expect(result.current.installError).toBe("Offline");

		act(() => statusCb?.({ phase: "model" }));
		expect(result.current.installPhase).toBe("model");
		// Any phase ping proves a fresh attempt is in flight → error cleared.
		expect(result.current.installError).toBeNull();
	});

	test("'ready' phase collapses to null (idle) via projectInstallPhase", () => {
		const { result } = renderHook(() => useTtsInstallGate());
		act(() => statusCb?.({ phase: "engine" }));
		expect(result.current.installPhase).toBe("engine");
		act(() => statusCb?.({ phase: "ready" as TtsInstallPhase }));
		expect(result.current.installPhase).toBeNull();
	});
});

describe("useTtsInstallGate — download-complete effect", () => {
	test("CANCELLED completion clears the phase (install over)", () => {
		const { result } = renderHook(() => useTtsInstallGate());
		act(() => statusCb?.({ phase: "model" }));
		expect(result.current.installPhase).toBe("model");
		act(() => completeCb?.({ cancelled: true }));
		expect(result.current.installPhase).toBeNull();
	});

	test("SUCCESSFUL completion does NOT clear the phase (avoids the re-enable flash)", () => {
		const { result } = renderHook(() => useTtsInstallGate());
		act(() => statusCb?.({ phase: "model" }));
		expect(result.current.installPhase).toBe("model");
		act(() => completeCb?.({ cancelled: false }));
		// Phase is preserved; only the `ready` status ping marks the install done.
		expect(result.current.installPhase).toBe("model");
	});
});

describe("useTtsInstallGate — install-failed effect", () => {
	test("surfaces the classified reason and clears the progress phase", () => {
		const { result } = renderHook(() => useTtsInstallGate());
		act(() => statusCb?.({ phase: "engine" }));
		act(() => failedCb?.({ category: "model-not-found", reason: "Model missing" }));
		expect(result.current.installPhase).toBeNull();
		expect(result.current.installError).toBe("Model missing");
	});
});

describe("useTtsInstallGate — handleEnabledToggle OFF (disable)", () => {
	test("turning OFF is immediate: flips enabled:false, clears phase + dialog, no probe", async () => {
		// Pre-seed an open dialog and a phase to prove disable resets them.
		const { result } = renderHook(() => useTtsInstallGate());
		act(() => statusCb?.({ phase: "model" }));
		act(() => result.current.handleEnabledToggle(true)); // open the dialog path first
		await waitFor(() => expect(result.current.confirmOpen).toBe(true));

		act(() => result.current.handleEnabledToggle(false));
		expect(currentTts().enabled).toBe(false);
		expect(result.current.installPhase).toBeNull();
		expect(result.current.confirmOpen).toBe(false);
	});
});

describe("useTtsInstallGate — handleEnabledToggle ON (probe → enable)", () => {
	test("everything on disk + reachable → enables straight away, no dialog", async () => {
		estimateImpl = async () => makeEstimate({ alreadyInstalled: true, unavailable: false });
		const { result } = renderHook(() => useTtsInstallGate());

		act(() => result.current.handleEnabledToggle(true));
		// `probing` flips true synchronously inside runProbe before the await.
		await waitFor(() => expect(result.current.probing).toBe(false));
		await waitFor(() => expect(currentTts().enabled).toBe(true));
		expect(result.current.confirmOpen).toBe(false);
		// Estimate is recorded from the probe.
		expect(result.current.estimate?.alreadyInstalled).toBe(true);
	});

	test("enable path with empty persisted hotkey folds the default binding in", async () => {
		setTtsHotkey("");
		estimateImpl = async () => makeEstimate({ alreadyInstalled: true, unavailable: false });
		const { result } = renderHook(() => useTtsInstallGate());

		act(() => result.current.handleEnabledToggle(true));
		await waitFor(() => expect(currentTts().enabled).toBe(true));
		expect(currentTts().hotkey).toBe(DEFAULT_SETTINGS.tts.hotkey);
	});

	test("enable path with a user hotkey preserves it (only flips enabled)", async () => {
		setTtsHotkey("LCtrl+Alt+T");
		estimateImpl = async () => makeEstimate({ alreadyInstalled: true, unavailable: false });
		const { result } = renderHook(() => useTtsInstallGate());

		act(() => result.current.handleEnabledToggle(true));
		await waitFor(() => expect(currentTts().enabled).toBe(true));
		expect(currentTts().hotkey).toBe("LCtrl+Alt+T");
	});
});

describe("useTtsInstallGate — handleEnabledToggle ON (probe → confirm)", () => {
	test("not installed → opens the dialog, leaves enabled untouched", async () => {
		estimateImpl = async () => makeEstimate({ alreadyInstalled: false, unavailable: false });
		const { result } = renderHook(() => useTtsInstallGate());

		act(() => result.current.handleEnabledToggle(true));
		await waitFor(() => expect(result.current.confirmOpen).toBe(true));
		expect(currentTts().enabled).toBe(false);
		expect(result.current.estimate?.alreadyInstalled).toBe(false);
		expect(result.current.probing).toBe(false);
	});

	test("probing toggles true→false across the probe round-trip (finally clause)", async () => {
		// Hold the probe open with a deferred promise so the in-flight
		// `probing === true` state is observable before it resets in `finally`.
		// (A rejecting probe would also exercise `finally`, but the hook's
		// `runProbe().then(handleProbeResult)` has no `.catch` — see the
		// reported unhandled-rejection bug — so bun would flag the dangling
		// rejection. The success-resolve path proves the same `finally` line.)
		let resolveProbe: ((est: TtsDownloadEstimatePayload) => void) | null = null;
		estimateImpl = () =>
			new Promise<TtsDownloadEstimatePayload>((resolve) => {
				resolveProbe = resolve;
			});
		const { result } = renderHook(() => useTtsInstallGate());

		act(() => {
			result.current.handleEnabledToggle(true);
		});
		// Probe is in flight → probing is true and no decision has been made yet.
		await waitFor(() => expect(result.current.probing).toBe(true));
		expect(result.current.confirmOpen).toBe(false);
		expect(currentTts().enabled).toBe(false);

		// Release the probe with a "not installed" estimate → finally resets
		// probing, then the dialog opens.
		await act(async () => {
			resolveProbe?.(makeEstimate({ alreadyInstalled: false }));
			await Promise.resolve();
		});
		await waitFor(() => expect(result.current.probing).toBe(false));
		expect(result.current.confirmOpen).toBe(true);
	});
});

describe("useTtsInstallGate — probe rejection is absorbed (no unhandled rejection)", () => {
	// Regression: `toggleActions.enable` did `runProbe().then(handleProbeResult)`
	// and `confirmActions.retry` did a bare `runProbe()` — neither had a `.catch`.
	// A rejecting size-probe IPC (server/WS down) became an unhandled rejection
	// and left the UI hung with no signal. Both paths now `.catch` and log.
	function captureConsoleError(): { errors: unknown[][]; restore: () => void } {
		const original = console.error;
		const errors: unknown[][] = [];
		console.error = (...args: unknown[]) => {
			errors.push(args);
		};
		const restore = (): void => {
			console.error = original;
		};
		return { errors, restore };
	}

	test("toggle ON with a rejecting probe logs and resets probing (no throw)", async () => {
		const cap = captureConsoleError();
		try {
			estimateImpl = () => Promise.reject(new Error("probe down"));
			const { result } = renderHook(() => useTtsInstallGate());

			act(() => result.current.handleEnabledToggle(true));
			// `finally` clears probing even on rejection; the `.catch` absorbs it.
			await waitFor(() => expect(result.current.probing).toBe(false));
			// Stayed disabled, no dialog flashed open, and the rejection was logged.
			expect(currentTts().enabled).toBe(false);
			expect(result.current.confirmOpen).toBe(false);
			await waitFor(() =>
				expect(cap.errors.some((e) => String(e[0]).includes("TTS install probe failed"))).toBe(true)
			);
		} finally {
			cap.restore();
		}
	});

	test("retry (offline confirm) with a rejecting re-probe is caught and logged", async () => {
		const cap = captureConsoleError();
		try {
			// First probe is offline → dialog opens with the retry button.
			estimateImpl = async () => makeEstimate({ alreadyInstalled: false, unavailable: true });
			const { result } = renderHook(() => useTtsInstallGate());
			act(() => result.current.handleEnabledToggle(true));
			await waitFor(() => expect(result.current.confirmOpen).toBe(true));

			// The retry re-probe rejects — `confirmActions.retry`'s `.catch` must
			// absorb it (no unhandled rejection) and reset probing.
			estimateImpl = () => Promise.reject(new Error("still down"));
			act(() => result.current.handleInstallConfirm());
			await waitFor(() => expect(result.current.probing).toBe(false));
			await waitFor(() =>
				expect(cap.errors.some((e) => String(e[0]).includes("TTS install probe failed"))).toBe(true)
			);
			// Retry never enables on its own; the toggle stays off.
			expect(currentTts().enabled).toBe(false);
		} finally {
			cap.restore();
		}
	});
});

describe("useTtsInstallGate — handleInstallConfirm", () => {
	test("reachable estimate → closes dialog and enables (commit)", async () => {
		estimateImpl = async () => makeEstimate({ alreadyInstalled: false, unavailable: false });
		const { result } = renderHook(() => useTtsInstallGate());
		act(() => result.current.handleEnabledToggle(true));
		await waitFor(() => expect(result.current.confirmOpen).toBe(true));

		act(() => result.current.handleInstallConfirm());
		expect(result.current.confirmOpen).toBe(false);
		expect(currentTts().enabled).toBe(true);
	});

	test("offline estimate → re-probes (retry) instead of committing", async () => {
		estimateImpl = async () => makeEstimate({ alreadyInstalled: false, unavailable: true });
		const { result } = renderHook(() => useTtsInstallGate());
		act(() => result.current.handleEnabledToggle(true));
		await waitFor(() => expect(result.current.confirmOpen).toBe(true));

		// Next probe comes back reachable — retry should record it without enabling here.
		let probeCount = 0;
		estimateImpl = async () => {
			probeCount += 1;
			return makeEstimate({ alreadyInstalled: false, unavailable: false });
		};
		act(() => {
			result.current.handleInstallConfirm();
		});
		await waitFor(() => expect(probeCount).toBe(1));
		// Retry runs runProbe() (records the fresh reachable estimate) but does
		// NOT enable on its own — the user must press Confirm again.
		await waitFor(() => expect(result.current.estimate?.unavailable).toBe(false));
		expect(currentTts().enabled).toBe(false);
	});

	test("pre-probe (null estimate) → enable branch (commit)", () => {
		const { result } = renderHook(() => useTtsInstallGate());
		// No probe yet → estimate is null → resolveConfirmAction returns "enable".
		act(() => result.current.handleInstallConfirm());
		expect(result.current.confirmOpen).toBe(false);
		expect(currentTts().enabled).toBe(true);
	});
});

describe("useTtsInstallGate — handleInstallCancel / closeConfirm", () => {
	test("handleInstallCancel closes the dialog and keeps disabled", async () => {
		estimateImpl = async () => makeEstimate({ alreadyInstalled: false });
		const { result } = renderHook(() => useTtsInstallGate());
		act(() => result.current.handleEnabledToggle(true));
		await waitFor(() => expect(result.current.confirmOpen).toBe(true));

		act(() => result.current.handleInstallCancel());
		expect(result.current.confirmOpen).toBe(false);
		expect(currentTts().enabled).toBe(false);
	});

	test("closeConfirm (backdrop/Escape) closes the dialog", async () => {
		estimateImpl = async () => makeEstimate({ alreadyInstalled: false });
		const { result } = renderHook(() => useTtsInstallGate());
		act(() => result.current.handleEnabledToggle(true));
		await waitFor(() => expect(result.current.confirmOpen).toBe(true));

		act(() => result.current.closeConfirm());
		expect(result.current.confirmOpen).toBe(false);
	});
});

describe("useTtsInstallGate — retryInstall", () => {
	test("clears the error, sets phase to 'engine', and re-dispatches init_tts", () => {
		const { result } = renderHook(() => useTtsInstallGate());
		act(() => failedCb?.({ category: "network", reason: "Boom" }));
		expect(result.current.installError).toBe("Boom");

		act(() => result.current.retryInstall());
		expect(result.current.installError).toBeNull();
		expect(result.current.installPhase).toBe("engine");
		expect(initTtsCalls).toBe(1);
	});
});

describe("useTtsInstallGate — selectTtsHotkey fallback", () => {
	test("missing tts.hotkey falls back to '' → empty path folds the default in on enable", async () => {
		// tts object with NO hotkey key exercises the `?? ""` fallback in selectTtsHotkey.
		setTtsHotkey(undefined);
		estimateImpl = async () => makeEstimate({ alreadyInstalled: true, unavailable: false });
		const { result } = renderHook(() => useTtsInstallGate());

		act(() => result.current.handleEnabledToggle(true));
		await waitFor(() => expect(currentTts().enabled).toBe(true));
		// Empty/absent hotkey → default folded in.
		expect(currentTts().hotkey).toBe(DEFAULT_SETTINGS.tts.hotkey);
	});
});
