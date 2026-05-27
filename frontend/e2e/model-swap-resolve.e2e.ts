/**
 * Verifies the renderer correctly clears the in-flight model-swap state
 * across both completion paths:
 *
 *   1. Hot-swap path  — server emits `model_swap_started` → `model_swap_completed`.
 *   2. Restart path   — server respawns after a STARTUP_ONLY key change
 *      (e.g. `model.onnxQuantization`) and the only "swap done" signal is
 *      a fresh `runtime_info` push from `server_ready`. NO
 *      `model_swap_completed` event fires here.
 *
 * The bug this guards against: the swap-store only used to clear
 * ``activeMain`` on the model-swap events, so the restart path left the
 * status-bar chip spinning on "Switching to <X>..." forever even though
 * the server had already loaded and announced the new model. The fix is
 * a third subscription on ``onRuntimeInfo`` in
 * ``entities/model-catalog/model/model-swap-store.ts`` that clears the
 * matching kind when ``info.model === activeMain``.
 *
 * The test mocks ``window.electronAPI`` via ``addInitScript`` so we can
 * dispatch IPC events deterministically from the test and observe the
 * UI react. It pre-seeds the persisted ``winstt-settings`` localStorage
 * blob with a non-empty model so the StatusBar's
 * ``{currentModel && (…)}`` guard renders the chip.
 */
import { expect, type Page, test } from "@playwright/test";

const TARGET_MODEL = "nemo-canary-180m-flash";

interface MockApiHandle {
	__fireIpc: (channel: string, data: unknown) => void;
	__listenerCount: (channel: string) => number;
}

declare global {
	interface Window {
		__mockApi: MockApiHandle;
	}
}

/**
 * Installs:
 *   - A minimal ``window.electronAPI`` polyfill the renderer's IPC layer
 *     reads via ``isElectron()`` (only ``on`` / ``send`` / ``invoke`` are
 *     consulted by the code paths under test).
 *   - A ``window.__mockApi`` test handle exposing ``__fireIpc`` so each
 *     assertion can dispatch arbitrary channels into the renderer.
 *   - Pre-seeded ``localStorage["winstt-settings"]`` so the StatusBar's
 *     ``currentModel`` guard succeeds without round-tripping a real
 *     settings IPC call (we'd otherwise see an empty chip area and miss
 *     the swap UI entirely).
 */
async function installIpcMock(page: Page): Promise<void> {
	await page.addInitScript(() => {
		// biome-ignore lint/suspicious/noExplicitAny: minimal test bridge — type elision keeps the shim small.
		type Listener = (data: any) => void;
		const listeners = new Map<string, Set<Listener>>();
		const fakeApi = {
			on(channel: string, cb: Listener) {
				if (!listeners.has(channel)) {
					listeners.set(channel, new Set());
				}
				listeners.get(channel)?.add(cb);
				return () => {
					listeners.get(channel)?.delete(cb);
				};
			},
			send(_channel: string, ..._args: unknown[]) {
				// Test boundary — renderer-initiated sends are observed only
				// indirectly via state changes; we don't need to act on them.
			},
			invoke(_channel: string, ..._args: unknown[]) {
				return Promise.resolve(undefined);
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: window.electronAPI shape is owned by the preload bridge; the test shim only fills the methods the renderer actually calls.
		(window as any).electronAPI = fakeApi;
		// biome-ignore lint/suspicious/noExplicitAny: test handle pinned on window; the global Window augmentation at module top declares the typed shape consumers see.
		(window as any).__mockApi = {
			__fireIpc(channel: string, data: unknown) {
				const set = listeners.get(channel);
				if (set === undefined) {
					return;
				}
				for (const cb of set) {
					cb(data);
				}
			},
			__listenerCount(channel: string) {
				return listeners.get(channel)?.size ?? 0;
			},
		};
		// Intentionally NO localStorage seed — letting the Zustand store
		// hydrate via ``appSettingsSchema.parse({})`` defaults populates every
		// nested object the renderer touches (integrations.openai, llm, tts,
		// …). A partial seed misses nested fields and trips a
		// "Cannot read properties of undefined" early-mount throw that
		// leaves ``#root`` empty. Schema-default ``settings.model.model`` is
		// ``"tiny"``, which is plenty to satisfy the StatusBar's
		// ``currentModel && (…)`` guard.
	});
}

async function fireIpc(page: Page, channel: string, data: unknown): Promise<void> {
	await page.evaluate(([ch, d]) => window.__mockApi.__fireIpc(ch as string, d), [
		channel,
		data,
	] as const);
}

test.describe("model swap resolution", () => {
	test.beforeEach(async ({ page }) => {
		await installIpcMock(page);
		await page.goto("/");
		// Wait for the renderer to have wired its IPC listeners (the
		// swap-store's `initModelSwapStore` runs at module load — we just
		// need to be confident hydration is done).
		await page.waitForFunction(
			() => window.__mockApi.__listenerCount("stt:model-swap-started") > 0,
			null,
			{ timeout: 10_000 }
		);
		await page.waitForFunction(
			() => window.__mockApi.__listenerCount("stt:runtime-info") > 0,
			null,
			{ timeout: 10_000 }
		);
	});

	test("clears 'Switching to ...' chip on model_swap_completed (hot-swap path)", async ({
		page,
	}) => {
		await fireIpc(page, "stt:model-swap-started", { kind: "main", name: TARGET_MODEL });
		const chip = page.getByText(`Switching to ${TARGET_MODEL}`, { exact: false });
		await expect(chip).toBeVisible({ timeout: 5000 });

		await fireIpc(page, "stt:model-swap-completed", { kind: "main", name: TARGET_MODEL });
		await expect(chip).toBeHidden({ timeout: 5000 });
	});

	test("clears 'Switching to ...' chip on model_swap_failed", async ({ page }) => {
		await fireIpc(page, "stt:model-swap-started", { kind: "main", name: TARGET_MODEL });
		const chip = page.getByText(`Switching to ${TARGET_MODEL}`, { exact: false });
		await expect(chip).toBeVisible({ timeout: 5000 });

		await fireIpc(page, "stt:model-swap-failed", {
			kind: "main",
			name: TARGET_MODEL,
			reason: "test",
			category: "unknown",
			detail: "",
		});
		await expect(chip).toBeHidden({ timeout: 5000 });
	});

	test("clears 'Switching to ...' chip on runtime_info (STARTUP_ONLY restart path)", async ({
		page,
	}) => {
		// Simulate the STARTUP_ONLY restart sequence: the renderer's
		// applyMainSwap called beginSwap (so activeMain is set), then the
		// onnxQuantization patch triggered a server restart. Only
		// `runtime_info` fires after server_ready — no model_swap_*
		// events. Pre-fix this left the spinner running forever.
		await fireIpc(page, "stt:model-swap-started", { kind: "main", name: TARGET_MODEL });
		const chip = page.getByText(`Switching to ${TARGET_MODEL}`, { exact: false });
		await expect(chip).toBeVisible({ timeout: 5000 });

		await fireIpc(page, "stt:runtime-info", {
			device: "auto",
			is_gpu: false,
			model: TARGET_MODEL,
			providers: ["CPUExecutionProvider"],
			realtime_model: null,
		});
		await expect(chip).toBeHidden({ timeout: 5000 });
	});

	test("does NOT clear chip when runtime_info reports a different model", async ({ page }) => {
		// Defensive: a `runtime_info` push that doesn't match `activeMain`
		// (e.g. stale snapshot delivered mid-swap) must NOT clear the
		// spinner — the swap is still genuinely in flight.
		await fireIpc(page, "stt:model-swap-started", { kind: "main", name: TARGET_MODEL });
		const chip = page.getByText(`Switching to ${TARGET_MODEL}`, { exact: false });
		await expect(chip).toBeVisible({ timeout: 5000 });

		await fireIpc(page, "stt:runtime-info", {
			device: "auto",
			is_gpu: false,
			model: "some-other-model",
			providers: ["CPUExecutionProvider"],
			realtime_model: null,
		});
		// Give the renderer a tick to (incorrectly) react, then assert the
		// chip is still up.
		await page.waitForTimeout(250);
		await expect(chip).toBeVisible();
	});
});
