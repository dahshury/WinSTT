import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const storeData: Record<string, unknown> = {};
const storeChangeHandlers = new Map<string, Array<(value: unknown) => void>>();

import { storeMock } from "@test/mocks/store";

mock.module("../lib/store", () => {
	const base = storeMock();
	return {
		...base,
		store: {
			...base.store,
			onDidChange: (key: string, cb: (value: unknown) => void) => {
				const list = storeChangeHandlers.get(key) ?? [];
				list.push(cb);
				storeChangeHandlers.set(key, list);
				return () => {
					storeChangeHandlers.set(
						key,
						(storeChangeHandlers.get(key) ?? []).filter((x) => x !== cb)
					);
				};
			},
		},
		getStoreValue: (key: string) => {
			const [section, sub] = key.split(".");
			const top = section ? storeData[section] : undefined;
			if (top != null && typeof top === "object" && sub) {
				return (top as Record<string, unknown>)[sub];
			}
			return top;
		},
	};
});

import { electronMock } from "@test/mocks/electron";

mock.module("electron", () => ({
	...electronMock(),
	screen: {
		getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }),
	},
}));

const {
	setOverlayWindow,
	showOverlay,
	hideOverlay,
	setupOverlayHandlers,
	__resetOverlayForTesting__,
} = await import("./overlay");

interface MockWin {
	calls: string[];
	getSize: () => number[];
	hide: () => void;
	isVisible: () => boolean;
	positions: [number, number][];
	setOpacity: (v: number) => void;
	setPosition: (x: number, y: number) => void;
	showInactive: () => void;
	visible: boolean;
}

function makeWindow(): MockWin {
	const calls: string[] = [];
	const positions: [number, number][] = [];
	const win: MockWin = {
		getSize: () => [800, 120],
		setOpacity: (v: number) => {
			calls.push(`opacity:${v}`);
			win.visible = v > 0;
		},
		setPosition: (x: number, y: number) => {
			calls.push(`setPosition:${x},${y}`);
			positions.push([x, y]);
		},
		showInactive: () => {
			calls.push("show");
			win.visible = true;
		},
		hide: () => {
			calls.push("hide");
			win.visible = false;
		},
		isVisible: () => win.visible,
		visible: false,
		positions,
		calls,
	};
	return win;
}

beforeEach(() => {
	for (const k of Object.keys(storeData)) {
		delete storeData[k];
	}
	storeChangeHandlers.clear();
	storeData.general = {
		showRecordingOverlay: true,
		recordingMode: "ptt",
	};
	__resetOverlayForTesting__();
});

afterEach(() => {
	for (const k of Object.keys(storeData)) {
		delete storeData[k];
	}
	storeChangeHandlers.clear();
	__resetOverlayForTesting__();
});

describe("overlay handlers", () => {
	test("showOverlay is a no-op when no window has been registered", () => {
		// (no setOverlayWindow called)
		expect(() => showOverlay()).not.toThrow();
	});

	test("showOverlay reveals the window at opacity 0 first, then ramps to 1 after a frame", async () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		showOverlay();
		// Synchronously: position → opacity 0 → show. We open invisible so
		// DWM's cached composited surface from the *previous* session can't
		// flash through before the renderer paints its post-`recording_start`
		// state. Position math: width=1920, winWidth=800, x=(1920-800)/2=560;
		// height=1080, winHeight=120, y=1080-120-60=900.
		expect(win.calls).toEqual(["setPosition:560,900", "opacity:0", "show"]);
		// After the ramp delay, opacity flips to 1.
		await new Promise<void>((r) => setTimeout(r, 120));
		expect(win.calls).toEqual(["setPosition:560,900", "opacity:0", "show", "opacity:1"]);
	});

	test("showOverlay on an ALREADY-visible window keeps opacity 1 (no fade-out for LLM-thinking re-shows)", () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		// Make the window already visible BEFORE the showOverlay call —
		// matches the `maybeRunLlm` re-show path where the pill must stay
		// continuously visible.
		win.visible = true;
		showOverlay();
		// No opacity-0 step — we never dim a visible pill.
		expect(win.calls).toEqual(["setPosition:560,900", "opacity:1", "show"]);
	});

	test("hide that lands inside the opacity-ramp window cancels the pending opacity:1", async () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		showOverlay();
		// Mid-ramp: hide. The pending setTimeout that would have flipped
		// opacity to 1 must be a no-op (defended by both clearPendingTimers
		// and the desired-state recheck inside the timer).
		hideOverlay();
		await new Promise<void>((r) => setTimeout(r, 150));
		// The synchronous opacity:1 that would otherwise reveal DWM's stale
		// cached frame on the next physical show must not appear after the
		// hide. (The hide itself adds an opacity:0; we tolerate it here.)
		const opacityOnes = win.calls.filter((c) => c === "opacity:1");
		expect(opacityOnes).toHaveLength(0);
	});

	test("showOverlay centers horizontally using (workWidth - winWidth) / 2 (kills * 2 / + mutants)", () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		showOverlay();
		// Confirm the exact x coordinate. Mutating - to + would yield 2720;
		// mutating / 2 to * 2 would yield 2240.
		expect(win.positions[0]?.[0]).toBe(560);
	});

	test("showOverlay positions y as (workHeight - winHeight - 60) (kills + 60 / + height mutants)", () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		showOverlay();
		// 1080 - 120 - 60 = 900. Mutating - 60 to + 60 → 1020;
		// mutating - winHeight to + winHeight → 1140.
		expect(win.positions[0]?.[1]).toBe(900);
	});

	test("showOverlay does NOT show when overlay is disabled in settings", () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		(storeData.general as Record<string, unknown>).showRecordingOverlay = false;
		showOverlay();
		expect(win.calls).toEqual([]);
	});

	test("showOverlay does NOT show in listen recording mode", () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		(storeData.general as Record<string, unknown>).recordingMode = "listen";
		showOverlay();
		expect(win.calls).toEqual([]);
	});

	test("hideOverlay applies all three hide mechanisms synchronously", () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		hideOverlay();
		// Immediate — no debounce. All three mechanisms fire so the pill
		// can't get stuck visible under DWM compositing edge cases.
		expect(win.calls).toEqual(["opacity:0", "setPosition:-10000,-10000", "hide"]);
	});

	test("applyHide moves window to NEGATIVE offscreen coordinates (kills + sign mutant on -10_000)", () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		hideOverlay();
		// Offscreen coordinates must be negative — a mutant that flips the sign
		// would move to (10000, 10000) which is within work area on a wide multi-monitor
		// setup and still visible.
		expect(win.positions[0]?.[0]).toBeLessThan(0);
		expect(win.positions[0]?.[1]).toBeLessThan(0);
		expect(win.positions[0]?.[0]).toBe(-10_000);
		expect(win.positions[0]?.[1]).toBe(-10_000);
	});

	test("rapid stop → start sequence: pill ends up visible (show after hide)", async () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		hideOverlay();
		showOverlay();
		// opacity:1 now lands AFTER the ramp delay rather than synchronously
		// alongside `show`, so wait past it before checking the terminal state.
		await new Promise<void>((r) => setTimeout(r, 120));
		// At the end of a stop → start cycle: the final visible state must
		// be "visible at the right position with full opacity", regardless
		// of the intermediate opacity-0 reveal step.
		const lastOpacity1 = win.calls.lastIndexOf("opacity:1");
		const lastOpacity0 = win.calls.lastIndexOf("opacity:0");
		const lastShow = win.calls.lastIndexOf("show");
		const lastHide = win.calls.lastIndexOf("hide");
		expect(lastOpacity1).toBeGreaterThan(lastOpacity0);
		expect(lastShow).toBeGreaterThan(lastHide);
	});

	test("setupOverlayHandlers wires store change listeners and returns a disposer", () => {
		const dispose = setupOverlayHandlers();
		expect(storeChangeHandlers.has("general.showRecordingOverlay")).toBe(true);
		expect(storeChangeHandlers.has("general.recordingMode")).toBe(true);
		dispose();
		expect(storeChangeHandlers.get("general.showRecordingOverlay")?.length ?? 0).toBe(0);
		expect(storeChangeHandlers.get("general.recordingMode")?.length ?? 0).toBe(0);
	});

	test("disabling the overlay setting hides the window via the change handler", () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		setupOverlayHandlers();
		const handler = storeChangeHandlers.get("general.showRecordingOverlay")?.[0];
		expect(handler).toBeDefined();
		handler!(false);
		// Settings-change disposers route through hideOverlayImmediate — hide
		// should fire synchronously, not after the debounce.
		expect(win.calls).toContain("hide");
	});

	test("switching to listen recording mode hides the window immediately", () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		setupOverlayHandlers();
		const handler = storeChangeHandlers.get("general.recordingMode")?.[0];
		expect(handler).toBeDefined();
		handler!("listen");
		expect(win.calls).toContain("hide");
	});

	test("hideOverlay re-applies hide passes to defeat DWM compositor caching", async () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		hideOverlay();
		const initialHideCount = win.calls.filter((c) => c === "hide").length;
		expect(initialHideCount).toBe(1);
		// Wait past the longest re-apply delay (400ms) plus some headroom.
		await new Promise<void>((r) => setTimeout(r, 500));
		const finalHideCount = win.calls.filter((c) => c === "hide").length;
		// First pass + 3 reapply passes = 4 total. Allow 4+ in case the
		// reconciler also fired (it would be idempotent).
		expect(finalHideCount).toBeGreaterThanOrEqual(4);
	});

	test("a show during the hide-reapply window cancels the pending re-applies", async () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		hideOverlay();
		// Capture hide count immediately after the synchronous first pass.
		const hideAfterImmediate = win.calls.filter((c) => c === "hide").length;
		// Show before any reapply timer can fire.
		showOverlay();
		// Wait past all reapply delays + reconciler.
		await new Promise<void>((r) => setTimeout(r, 600));
		const finalHideCount = win.calls.filter((c) => c === "hide").length;
		// Hide count should be unchanged from the initial — the show
		// cancelled the re-applies. (The reconciler would normally fire
		// while hidden, but we transitioned to shown so it stops.)
		expect(finalHideCount).toBe(hideAfterImmediate);
		// The pill is currently visible.
		expect(win.isVisible()).toBe(true);
	});

	test("reconciler re-hides the window if it sneaks visible after hideOverlay", async () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		hideOverlay();
		// Wait until past the static re-applies (400ms) so we know the
		// reconciler is the one running.
		await new Promise<void>((r) => setTimeout(r, 450));
		// Simulate a stray paint or DWM ghost making the window visible
		// without going through showOverlay (no `desired = "shown"`).
		win.visible = true;
		// Wait for the reconciler tick.
		await new Promise<void>((r) => setTimeout(r, 250));
		// Reconciler should have noticed and re-hidden.
		expect(win.isVisible()).toBe(false);
	});

	test("reconciler stops once desired transitions to 'shown' (kills `desired !== \"hidden\"` mutant)", async () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		hideOverlay();
		// Reconciler is now ticking. Switch to shown.
		showOverlay();
		// Drain the synchronous calls record after the show.
		const hideCountAfterShow = win.calls.filter((c) => c === "hide").length;
		// Now simulate stray visibility — without the reconciler stopping,
		// it would fire applyHide. But desired is "shown" so it must be a no-op.
		win.visible = true;
		await new Promise<void>((r) => setTimeout(r, 250));
		expect(win.calls.filter((c) => c === "hide").length).toBe(hideCountAfterShow);
		// The window remains visible — reconciler did NOT touch it.
		expect(win.isVisible()).toBe(true);
	});

	test("reconciler stops after RECONCILE_MAX_DURATION_MS (~2s) elapses", async () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		hideOverlay();
		// Wait past 2 seconds + reconciler tick interval (~200ms).
		await new Promise<void>((r) => setTimeout(r, 2300));
		// Now sneak visible — the reconciler is no longer running so it
		// should NOT re-hide. (A mutant that used >= or false here would
		// either still hide or never hide; this asserts the time check is real.)
		win.visible = true;
		const hideCountBefore = win.calls.filter((c) => c === "hide").length;
		await new Promise<void>((r) => setTimeout(r, 300));
		const hideCountAfter = win.calls.filter((c) => c === "hide").length;
		expect(hideCountAfter).toBe(hideCountBefore);
		// Still visible because reconciler stopped.
		expect(win.isVisible()).toBe(true);
	}, 5000);

	test("reconciler skips applyHide when window is NOT visible (kills `?.isVisible` truthy mutant)", async () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		hideOverlay();
		// At this point window is not visible. Wait through several reconciler ticks.
		const hidesAfterFirstPass = win.calls.filter((c) => c === "hide").length;
		// Wait through a couple of reconciler ticks (200ms each) BEFORE the static re-applies.
		// Static re-apply schedule: 50ms, 150ms, 400ms.
		// We want to look at hides between t=200ms (1st reconciler tick) and t=400ms
		// (before the 400ms static re-apply). At t=200ms the static at 50/150ms have
		// already fired, so we count the increase due to the reconciler tick alone.
		await new Promise<void>((r) => setTimeout(r, 220));
		// At t=220, static re-applies at 50ms and 150ms have fired (+2 hides).
		// The reconciler tick at t=200ms saw window NOT visible → skipped applyHide.
		const hides = win.calls.filter((c) => c === "hide").length;
		// 1 (initial) + 2 (static at 50,150) = 3. Mutant `?.isVisible → true`
		// would add an extra +1 hide for the t=200 reconciler tick.
		expect(hides).toBe(hidesAfterFirstPass + 2);
	});

	test("static re-apply skips when desired switched to 'shown' before timer fires (kills L163 desired check)", async () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		hideOverlay();
		// First synchronous hide is in. Show before any timer.
		showOverlay();
		// Capture the hide count after the show.
		const hidesAfterShow = win.calls.filter((c) => c === "hide").length;
		// Important: `clearPendingTimers` cancels static timers, but the test
		// also confirms that even if a stale timer ran, `desired === "hidden"`
		// would gate it. After 500ms, no further hide should be added.
		await new Promise<void>((r) => setTimeout(r, 500));
		const finalHides = win.calls.filter((c) => c === "hide").length;
		expect(finalHides).toBe(hidesAfterShow);
	});

	test("__resetOverlayForTesting__ clears desired state to 'hidden' so subsequent reconciler ticks treat it as hidden", async () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		showOverlay();
		// Reset module state.
		__resetOverlayForTesting__();
		// Window ref was cleared too — calling hide should be a no-op (no overlayWindow).
		hideOverlay();
		// `setOverlayWindow(null)` happened inside reset; calling hide should not touch the prior win.
		const callsBefore = win.calls.length;
		await new Promise<void>((r) => setTimeout(r, 50));
		expect(win.calls.length).toBe(callsBefore);
	});

	test("setupOverlayHandlers ignores newValue=true on showRecordingOverlay (kills `if (!newValue)` true-branch mutant)", () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		setupOverlayHandlers();
		const handler = storeChangeHandlers.get("general.showRecordingOverlay")?.[0];
		// Firing with truthy value → should NOT hide.
		handler!(true);
		expect(win.calls).not.toContain("hide");
	});

	test('setupOverlayHandlers ignores recordingMode change to non-listen mode (kills `=== "listen"` strict equality mutants)', () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		setupOverlayHandlers();
		const handler = storeChangeHandlers.get("general.recordingMode")?.[0];
		// Switching to ptt or toggle should NOT hide (only "listen" hides).
		handler!("ptt");
		expect(win.calls).not.toContain("hide");
		handler!("toggle");
		expect(win.calls).not.toContain("hide");
	});

	test("setupOverlayHandlers cleanup also clears pending timers and stops reconciler", async () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		const dispose = setupOverlayHandlers();
		hideOverlay();
		const hidesAfterFirstPass = win.calls.filter((c) => c === "hide").length;
		// Disposer should clear pending timers and the reconciler.
		dispose();
		// After dispose, no further hide passes should land — sneak visible to
		// confirm the reconciler is gone.
		win.visible = true;
		await new Promise<void>((r) => setTimeout(r, 500));
		expect(win.calls.filter((c) => c === "hide").length).toBe(hidesAfterFirstPass);
	});

	test("showOverlay is gated by both `enabled` AND `recordingMode` (covers the `||` short-circuit branches in isOverlaySuppressedBySettings)", () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		// Branch A: enabled=false → left of `||` is true, right not evaluated.
		(storeData.general as Record<string, unknown>).showRecordingOverlay = false;
		(storeData.general as Record<string, unknown>).recordingMode = "ptt";
		showOverlay();
		expect(win.calls).toEqual([]);
		// Branch B: enabled=true, recordingMode=listen → left false, right true.
		(storeData.general as Record<string, unknown>).showRecordingOverlay = true;
		(storeData.general as Record<string, unknown>).recordingMode = "listen";
		showOverlay();
		expect(win.calls).toEqual([]);
		// Branch C: enabled=true, recordingMode=ptt → both false → show fires.
		(storeData.general as Record<string, unknown>).recordingMode = "ptt";
		showOverlay();
		expect(win.calls).toContain("show");
	});

	test("reconciler tick re-hides sneak-visible window while still in the hidden + time-budget window (kills both `||` branches of shouldStopReconciler)", async () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		hideOverlay();
		// Wait past the static re-applies (50, 150, 400ms) so any later hide
		// can only come from the reconciler. Window is not visible at this point.
		await new Promise<void>((r) => setTimeout(r, 500));
		const hidesAfterReconcilerWindow = win.calls.filter((c) => c === "hide").length;
		// Make the window sneakily visible WITHIN the reconciler's 2s window.
		win.visible = true;
		// Wait for one more reconciler tick (200ms) — desired still "hidden"
		// and time-budget still in window → shouldStopReconciler is false →
		// reconciler proceeds to applyHide.
		await new Promise<void>((r) => setTimeout(r, 250));
		const hidesAfter = win.calls.filter((c) => c === "hide").length;
		// Reconciler caught the sneak-visible and re-hid → +1 hide.
		expect(hidesAfter).toBe(hidesAfterReconcilerWindow + 1);
	});
});
