import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import {
	useTtsCatalogStore,
	useTtsModelStateStore,
} from "@/entities/tts-catalog";
import { useTtsModelPickerStore } from "@/features/tts-model-picker";
import type { TtsModelStateEntry } from "@/shared/api/ipc-client";
import {
	type TtsEnabledReconcilerInputs,
	useTtsEnabledReconciler,
} from "./use-tts-enabled-reconciler";

const MODEL = "kokoro-82m";

function cachedEntry(id: string): TtsModelStateEntry {
	return {
		id,
		effectiveQuantization: "fp16",
		estimatedBytes: 1,
		cacheByQuantization: { fp16: { state: "cached" } as never },
	};
}

function missingEntry(id: string): TtsModelStateEntry {
	return {
		id,
		effectiveQuantization: "fp16",
		estimatedBytes: 1,
		cacheByQuantization: { fp16: { state: "not_downloaded" } as never },
	};
}

const originalRefresh = useTtsModelStateStore.getState().refresh;

function setTtsSettings(patch: Partial<typeof DEFAULT_SETTINGS.tts>): void {
	useSettingsStore.setState({
		settings: {
			...DEFAULT_SETTINGS,
			tts: { ...DEFAULT_SETTINGS.tts, ...patch },
		},
	});
}

function baseInputs(
	update: TtsEnabledReconcilerInputs["update"],
): TtsEnabledReconcilerInputs {
	const states = useTtsModelStateStore.getState();
	return {
		cloudAllowed: false,
		enabled: true,
		installPhase: null,
		isCloud: false,
		model: MODEL,
		models: useTtsCatalogStore.getState().models,
		statesById: states.statesById,
		statesLoaded: states.isLoaded,
		update,
	};
}

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

beforeEach(() => {
	setTtsSettings({ enabled: true, model: MODEL });
	useTtsCatalogStore.setState({ models: [], isLoaded: true });
	useTtsModelPickerStore.setState({ open: false });
});

afterEach(() => {
	useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
	useTtsModelStateStore.setState({
		statesById: {},
		isLoaded: false,
		refresh: originalRefresh,
	});
	useTtsCatalogStore.setState({ models: [], isLoaded: false });
	useTtsModelPickerStore.setState({ open: false });
});

describe("useTtsEnabledReconciler", () => {
	test("does NOT force-disable when a fresh refresh proves the model just landed (flicker regression)", async () => {
		// Stale snapshot: the picker's enable-commit raced the async state
		// refetch, so statesById still says "not cached" although the files are
		// on disk. The old inline effect wrote `enabled: false` here — the
		// visible on→off→on toggle flicker after a successful install.
		useTtsModelStateStore.setState({
			statesById: { [MODEL]: missingEntry(MODEL) },
			isLoaded: true,
			refresh: mock(async () => {
				useTtsModelStateStore.setState({
					statesById: { [MODEL]: cachedEntry(MODEL) },
					isLoaded: true,
				});
			}),
		});
		const update = mock(() => undefined);

		renderHook(() => useTtsEnabledReconciler(baseInputs(update)));
		await flush();

		expect(update).not.toHaveBeenCalled();
	});

	test("force-disables only after TWO refreshes confirm the model is really gone", async () => {
		const refresh = mock(async () => undefined);
		useTtsModelStateStore.setState({
			statesById: { [MODEL]: missingEntry(MODEL) },
			isLoaded: true,
			refresh,
		});
		const update = mock(() => undefined);

		renderHook(() => useTtsEnabledReconciler(baseInputs(update)));
		await flush();

		// The store's refresh coalesces in-flight fetches, so the first await
		// may join a stale fetch — the second is guaranteed post-trigger.
		expect(refresh).toHaveBeenCalledTimes(2);
		expect(update).toHaveBeenCalledWith({ enabled: false });
	});

	test("falls back to another cached model instead of disabling", async () => {
		useTtsCatalogStore.setState({
			models: [{ id: MODEL } as never, { id: "piper-medium" } as never],
			isLoaded: true,
		});
		useTtsModelStateStore.setState({
			statesById: {
				[MODEL]: missingEntry(MODEL),
				"piper-medium": cachedEntry("piper-medium"),
			},
			isLoaded: true,
			refresh: mock(async () => undefined),
		});
		const update = mock(() => undefined);

		renderHook(() => useTtsEnabledReconciler(baseInputs(update)));
		await flush();

		expect(update).toHaveBeenCalledWith({ model: "piper-medium" });
	});

	test("stays quiet while the model picker is open", async () => {
		useTtsModelPickerStore.setState({ open: true });
		const refresh = mock(async () => undefined);
		useTtsModelStateStore.setState({
			statesById: { [MODEL]: missingEntry(MODEL) },
			isLoaded: true,
			refresh,
		});
		const update = mock(() => undefined);

		renderHook(() => useTtsEnabledReconciler(baseInputs(update)));
		await flush();

		expect(refresh).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});

	test("stays quiet while an install/warm-up is in flight", async () => {
		const refresh = mock(async () => undefined);
		useTtsModelStateStore.setState({
			statesById: { [MODEL]: missingEntry(MODEL) },
			isLoaded: true,
			refresh,
		});
		const update = mock(() => undefined);

		renderHook(() =>
			useTtsEnabledReconciler({
				...baseInputs(update),
				installPhase: "model",
			}),
		);
		await flush();

		expect(refresh).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});

	test("does nothing when the selected model is already cached", async () => {
		const refresh = mock(async () => undefined);
		useTtsModelStateStore.setState({
			statesById: { [MODEL]: cachedEntry(MODEL) },
			isLoaded: true,
			refresh,
		});
		const update = mock(() => undefined);

		renderHook(() => useTtsEnabledReconciler(baseInputs(update)));
		await flush();

		expect(refresh).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});

	test("respects a user disable that lands mid-verification", async () => {
		// The user toggles TTS off while the confirm chain is refreshing — the
		// final decision must read the NEWEST settings and stand down.
		useTtsModelStateStore.setState({
			statesById: { [MODEL]: missingEntry(MODEL) },
			isLoaded: true,
			refresh: mock(async () => {
				setTtsSettings({ enabled: false, model: MODEL });
			}),
		});
		const update = mock(() => undefined);

		renderHook(() => useTtsEnabledReconciler(baseInputs(update)));
		await flush();

		expect(update).not.toHaveBeenCalled();
	});
});
