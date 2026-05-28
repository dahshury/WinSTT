import { describe, expect, test } from "bun:test";
// The canonical store, imported directly (NOT through @x) so we can assert the
// @x surface re-exports the very same instance.
import { useSettingsStore as canonicalStore } from "../model/settings-store";
import { useSettingsStore as xStore } from "./cloud-stt-credential";

describe("cloud-stt-credential @x surface", () => {
	test("re-exports the SAME store instance as entities/setting/model", () => {
		// Re-exporting a *copy* (e.g. via a wrapper) would split-brain the
		// verification-status invalidation: the cloud-stt-credential entity
		// would subscribe to a different store than the one settings writes to.
		// Identity equality is the contract this @x module exists to guarantee.
		expect(xStore).toBe(canonicalStore);
	});

	test("the re-export is a usable Zustand store (getState/setState/subscribe)", () => {
		expect(typeof xStore.getState).toBe("function");
		expect(typeof xStore.setState).toBe("function");
		expect(typeof xStore.subscribe).toBe("function");
		// Callable as a hook selector function too (Zustand stores are callable).
		expect(typeof xStore).toBe("function");
	});

	test("getState exposes the settings slice the credential entity reads", () => {
		const state = xStore.getState();
		// The cloud-stt-credential entity subscribes to clear stale verification
		// status when an API key changes — it reaches into `settings`.
		expect(state.settings).toBeDefined();
		expect(typeof state.settings).toBe("object");
	});

	test("a subscription through the @x surface observes writes to the canonical store", () => {
		// Proves the two handles share one state container end-to-end.
		let observed = 0;
		const unsubscribe = xStore.subscribe(() => {
			observed += 1;
		});
		// Write through the canonical handle; the @x subscriber must fire.
		const before = canonicalStore.getState().settings;
		canonicalStore.setState({ settings: { ...before } });
		unsubscribe();
		expect(observed).toBeGreaterThan(0);
	});
});
