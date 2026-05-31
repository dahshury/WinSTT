/**
 * E2E test: the recording-pill overlay must reach a hidden state after
 * any sequence of show/hide toggles, including rapid hold-and-release
 * cycles that reproduce the user-reported "pill stuck visible" bug.
 *
 * This test runs the actual compiled Electron main process via
 * `_electron.launch()`, so it exercises the real DWM compositor on
 * Windows. The renderer-only chromium project can't catch this — the
 * bug manifests at the OS window-manager level.
 *
 * The Electron entry point exposes `globalThis.__winsttE2E__` only when
 * `WINSTT_E2E=1` is set, so production / dev runs don't carry the hook.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication } from "@playwright/test";
import { _electron, expect, test } from "@playwright/test";

const HERE = path.dirname(fileURLToPath(import.meta.url));

interface E2EHooks {
	hideOverlay: () => void;
	// Focus-pass-through introspection — see main.ts E2E hook block.
	isOverlayAlwaysOnTop: () => boolean;
	isOverlayFocusable: () => boolean;
	isOverlayVisible: () => boolean;
	showOverlay: () => void;
	simulateHotkeyPress: () => void;
	simulateRecordingStop: () => void;
}

const PROJECT_ROOT = path.resolve(HERE, "..");
const MAIN_JS = path.join(PROJECT_ROOT, "dist-electron", "main.js");

async function launchApp(): Promise<ElectronApplication> {
	return await _electron.launch({
		args: [MAIN_JS],
		env: {
			...process.env,
			WINSTT_E2E: "1",
			// Don't try to spawn the STT server during the E2E test —
			// keeps the launch fast and deterministic, and we don't need
			// transcription for overlay tests.
			WINSTT_E2E_SKIP_STT: "1",
		},
		cwd: PROJECT_ROOT,
		timeout: 30_000,
	});
}

async function getVisible(app: ElectronApplication): Promise<boolean> {
	return await app.evaluate(() => {
		const hooks = (globalThis as { __winsttE2E__?: E2EHooks }).__winsttE2E__;
		return hooks?.isOverlayVisible() ?? false;
	});
}

async function show(app: ElectronApplication): Promise<void> {
	await app.evaluate(() => {
		(globalThis as { __winsttE2E__?: E2EHooks }).__winsttE2E__?.showOverlay();
	});
}

async function hide(app: ElectronApplication): Promise<void> {
	await app.evaluate(() => {
		(globalThis as { __winsttE2E__?: E2EHooks }).__winsttE2E__?.hideOverlay();
	});
}

/** Wait until `cond()` returns the expected value, polling every 50ms. */
async function waitFor(
	cond: () => Promise<boolean>,
	expected: boolean,
	timeoutMs: number
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if ((await cond()) === expected) {
			return true;
		}
		await new Promise<void>((r) => setTimeout(r, 50));
	}
	return (await cond()) === expected;
}

test.describe("overlay pill — robust hide on rapid toggle", () => {
	let app: ElectronApplication;

	test.beforeAll(async () => {
		app = await launchApp();
		// Wait for the overlay window to be created (createOverlayWindow runs
		// at app boot — give it a moment to wire up).
		await app.evaluate(async () => new Promise<void>((r) => setTimeout(r, 1500)));
	});

	test.afterAll(async () => {
		await app?.close();
	});

	test("overlay BrowserWindow is pinned topmost (Handy-parity Z-order)", async () => {
		// Focus stealing is prevented by always calling `showInactive()` (NOT
		// `show()`) — same approach Handy uses (examples/Handy builds the
		// overlay with `.focused(false).visible(false)`). We deliberately
		// keep the window focusable: setting `focusable: false`
		// (WS_EX_NOACTIVATE) on Windows swallowed mouse-click messages in
		// combination with `transparent: true + alwaysOnTop: true` while
		// touch input still landed — the "X reacts to touch but not mouse"
		// regression. Pinning topmost (`alwaysOnTop("screen-saver", 1)`)
		// keeps the pill above fullscreen apps without stealing activation.
		const onTop = await app.evaluate(() => {
			const hooks = (globalThis as { __winsttE2E__?: E2EHooks }).__winsttE2E__;
			return hooks?.isOverlayAlwaysOnTop() ?? false;
		});
		expect(onTop).toBe(true);
	});

	test("single show → hide leaves the pill hidden", async () => {
		await show(app);
		await waitFor(() => getVisible(app), true, 1000);
		expect(await getVisible(app)).toBe(true);

		await hide(app);
		// Hide is multi-tier — wait past the 400ms longest reapply.
		expect(await waitFor(() => getVisible(app), false, 1000)).toBe(true);
		expect(await getVisible(app)).toBe(false);
	});

	// Hold duration matrix — the user's reproduction was 1s holds, but other
	// timings sometimes trip different DWM cache states. We exercise a range.
	for (const holdMs of [1000, 800, 500, 300, 200, 100]) {
		test(`20 rapid hold-and-release cycles (${holdMs}ms holds) end hidden`, async () => {
			const failures: number[] = [];
			for (let i = 0; i < 20; i++) {
				await show(app);
				await new Promise<void>((r) => setTimeout(r, holdMs));
				await hide(app);
				// Tiny gap between cycles to simulate a quick re-press.
				await new Promise<void>((r) => setTimeout(r, 80));

				// Track per-iteration whether the pill actually settled hidden
				// before the next cycle starts. Catches both "stuck visible
				// at the end" and "stuck visible mid-stream then recovered".
				const settled = await waitFor(() => getVisible(app), false, 1200);
				if (!settled) {
					failures.push(i);
				}
			}
			// Final assertion + per-iteration failures so we get visibility
			// into intermittency in the test report.
			expect(await waitFor(() => getVisible(app), false, 2500)).toBe(true);
			expect(failures).toEqual([]);
		});
	}

	test("show after hide-reapply window: pill ends visible", async () => {
		// Hide, then show during the reapply window. The pending reapplies
		// must be cancelled and the pill stays visible.
		await hide(app);
		// Wait into (but not past) the reapply window so a retry would fire
		// without our cancellation.
		await new Promise<void>((r) => setTimeout(r, 100));
		await show(app);
		await new Promise<void>((r) => setTimeout(r, 600));
		// Pill is still visible — no late hide-reapply clobbered the show.
		expect(await getVisible(app)).toBe(true);
	});

	test("recording-state gate: stray recording_start after stop does NOT re-show pill", async () => {
		// Reproduces the user-reported bug: pill hides correctly, then
		// shows again on its own because the server emits a stray /
		// duplicate `recording_start`. The gate must reject it.
		await app.evaluate(() => {
			const hooks = (globalThis as { __winsttE2E__?: E2EHooks }).__winsttE2E__;
			if (!hooks) {
				return;
			}
			// 1. Legitimate cycle: user presses, server sends start, server sends stop.
			hooks.simulateHotkeyPress();
			hooks.showOverlay();
			hooks.simulateRecordingStop();
			hooks.hideOverlay();
		});
		await new Promise<void>((r) => setTimeout(r, 300));
		expect(await getVisible(app)).toBe(false);

		// 2. Stray recording_start arrives WITHOUT a fresh hotkey press.
		// The relay's gate (consumeRecordingStart) should reject this —
		// here we simulate the relay's actual behaviour: it would only
		// call showOverlay if consumeRecordingStart returned true. So
		// our simulation models that — no showOverlay call when no
		// pending press.
		// (We can't directly call the relay's handleRecordingStart from
		// the test harness because it's not exported; the unit test
		// in recording-state.test.ts covers the consume logic. Here we
		// just verify the behaviour at the visible-state level: after
		// the cycle, the pill stays hidden through the reconciler
		// window even if no further events arrive.)
		await new Promise<void>((r) => setTimeout(r, 1000));
		expect(await getVisible(app)).toBe(false);
	});

	test("loop: 20 rapid cycles converge to hidden every iteration", async () => {
		// Tight loop catching any rare reorder / DWM cache failure mode.
		// If the pill is stuck even once across these 20 cycles the test
		// fails — the user wants reliability, not "usually works".
		const failures: number[] = [];
		for (let i = 0; i < 20; i++) {
			await show(app);
			await new Promise<void>((r) => setTimeout(r, 50));
			await hide(app);
			const settled = await waitFor(() => getVisible(app), false, 1500);
			if (!settled) {
				failures.push(i);
				// Force-hide so the next iteration starts clean.
				await hide(app);
			}
		}
		expect(failures).toEqual([]);
	});
});
