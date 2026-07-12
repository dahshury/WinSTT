import { beforeEach, describe, expect, test } from "bun:test";
import { useSettingsHydrationStore } from "./settings-hydration-store";

beforeEach(() => {
	useSettingsHydrationStore.getState().reset();
});

describe("settings hydration store", () => {
	test("reset restores the idle baseline", () => {
		const s = useSettingsHydrationStore.getState();
		s.setStatus("error", "boom");
		s.pushWarning("save-failed");
		s.bumpImportGeneration();
		s.requestRetry();

		s.reset();

		const after = useSettingsHydrationStore.getState();
		expect(after.status).toBe("idle");
		expect(after.error).toBeNull();
		expect(after.warnings).toEqual([]);
		expect(after.importGeneration).toBe(0);
		expect(after.retryToken).toBe(0);
	});

	// Audit #39: requestRetry advances a token the hydration effect watches so a
	// transient error no longer permanently disables persistence.
	test("requestRetry advances the retry token monotonically", () => {
		const before = useSettingsHydrationStore.getState().retryToken;
		useSettingsHydrationStore.getState().requestRetry();
		expect(useSettingsHydrationStore.getState().retryToken).toBe(before + 1);
	});

	// Audit #37: the import path bumps this generation; a stale queued save
	// captures the pre-bump value and aborts.
	test("bumpImportGeneration advances the generation", () => {
		const before = useSettingsHydrationStore.getState().importGeneration;
		useSettingsHydrationStore.getState().bumpImportGeneration();
		expect(useSettingsHydrationStore.getState().importGeneration).toBe(
			before + 1,
		);
	});

	// Audit #45/#26: warnings carry a kind + optional detail for the toast renderer.
	test("pushWarning appends a warning and collapses repeats of the same kind", () => {
		const { pushWarning } = useSettingsHydrationStore.getState();
		pushWarning("defaulted-sections", "integrations");
		pushWarning("hotkey-rewrite", "ttsHotkey");
		// A second warning of the same kind replaces the first (no stacking).
		pushWarning("defaulted-sections", "model");

		const { warnings } = useSettingsHydrationStore.getState();
		const kinds = warnings.map((w) => w.kind).sort();
		expect(kinds).toEqual(["defaulted-sections", "hotkey-rewrite"]);
		const defaulted = warnings.find((w) => w.kind === "defaulted-sections");
		expect(defaulted?.detail).toBe("model");
	});

	test("dismissWarning removes a single warning by id", () => {
		const { pushWarning } = useSettingsHydrationStore.getState();
		pushWarning("save-failed");
		const id = useSettingsHydrationStore.getState().warnings[0]?.id;
		expect(id).toBeDefined();
		useSettingsHydrationStore.getState().dismissWarning(id as number);
		expect(useSettingsHydrationStore.getState().warnings).toEqual([]);
	});
});
