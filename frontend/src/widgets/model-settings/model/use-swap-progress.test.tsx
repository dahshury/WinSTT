import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderHook } from "@testing-library/react";
import { useModelSwapStore } from "@/entities/model-catalog";
import { type QuantDownloadState, useDownloadStore } from "@/features/model-download";
import { useSwapProgress } from "./use-swap-progress";

// Both source stores are real Zustand stores (the established pattern — see
// use-sync-active-model.test.tsx / StatusBar.test.tsx). Capture their initial
// state and reset before each test so cases don't leak into each other.
const swapInitial = useModelSwapStore.getState();
const downloadInitial = useDownloadStore.getState();

function quantEntry(modelId: string, progress: number | null): QuantDownloadState {
	return {
		modelId,
		quantization: "",
		progress,
		downloadedBytes: 0,
		totalBytes: 0,
		speedBps: 0,
		paused: false,
	};
}

beforeEach(() => {
	useModelSwapStore.setState({
		activeMain: null,
		activeRealtime: null,
		fromMain: null,
		fromRealtime: null,
	});
	useDownloadStore.setState({
		isDownloading: false,
		modelName: null,
		progress: null,
		quantDownloads: {},
	});
});

afterEach(() => {
	useModelSwapStore.setState(swapInitial, true);
	useDownloadStore.setState(downloadInitial, true);
});

describe("useSwapProgress", () => {
	test("is fully idle when nothing is downloading or swapping", () => {
		const { result } = renderHook(() => useSwapProgress());
		expect(result.current.downloadProgress).toBeNull();
		expect(result.current.mainSwapping).toBe(false);
		expect(result.current.realtimeSwapping).toBe(false);
	});

	test("maps a single legacy singleton download into downloadProgress", () => {
		useDownloadStore.setState({
			isDownloading: true,
			modelName: "cohere",
			progress: 42,
		});
		const { result } = renderHook(() => useSwapProgress());
		const dp = result.current.downloadProgress;
		expect(dp).not.toBeNull();
		expect(dp?.count).toBe(1);
		expect(dp?.modelId).toBe("cohere");
		expect(dp?.percent).toBe(42);
		expect(dp?.averagePercent).toBe(42);
	});

	test("aggregates two concurrent quant downloads (count + average + highest primary)", () => {
		useDownloadStore.setState({
			quantDownloads: {
				"a@q4": quantEntry("model-a", 20),
				"b@q8": quantEntry("model-b", 80),
			},
		});
		const { result } = renderHook(() => useSwapProgress());
		const dp = result.current.downloadProgress;
		expect(dp?.count).toBe(2);
		// Primary = highest progress.
		expect(dp?.modelId).toBe("model-b");
		expect(dp?.percent).toBe(80);
		// Average of 20 and 80, rounded.
		expect(dp?.averagePercent).toBe(50);
	});

	test("reports null averagePercent while every download is still indeterminate", () => {
		useDownloadStore.setState({
			quantDownloads: { "a@q4": quantEntry("model-a", null) },
		});
		const { result } = renderHook(() => useSwapProgress());
		expect(result.current.downloadProgress?.count).toBe(1);
		expect(result.current.downloadProgress?.averagePercent).toBeNull();
		expect(result.current.downloadProgress?.percent).toBeNull();
	});

	test("flags mainSwapping when the server is loading weights with NO matching download", () => {
		useModelSwapStore.setState({ activeMain: "cohere" });
		const { result } = renderHook(() => useSwapProgress());
		// No bytes left to fetch → frozen picker.
		expect(result.current.mainSwapping).toBe(true);
		expect(result.current.realtimeSwapping).toBe(false);
		expect(result.current.downloadProgress).toBeNull();
	});

	test("does NOT flag mainSwapping while the swap target is still the primary download", () => {
		// Swapping to cohere AND cohere is the highest-progress download →
		// user is still fetching bytes, picker stays usable.
		useModelSwapStore.setState({ activeMain: "cohere" });
		useDownloadStore.setState({
			isDownloading: true,
			modelName: "cohere",
			progress: 30,
		});
		const { result } = renderHook(() => useSwapProgress());
		expect(result.current.mainSwapping).toBe(false);
		expect(result.current.downloadProgress?.modelId).toBe("cohere");
	});

	test("STILL flags mainSwapping when a DIFFERENT model is the primary download", () => {
		// Swapping to cohere, but a concurrent precache of "other" is the
		// highest-progress download. The swap-gate must read the PRIMARY
		// download's modelId — since primary != cohere, cohere counts as
		// loading-weights and freezes the picker.
		useModelSwapStore.setState({ activeMain: "cohere" });
		useDownloadStore.setState({
			quantDownloads: {
				cohere: quantEntry("cohere", 10),
				other: quantEntry("other", 90),
			},
		});
		const { result } = renderHook(() => useSwapProgress());
		expect(result.current.downloadProgress?.modelId).toBe("other");
		expect(result.current.mainSwapping).toBe(true);
	});

	test("flags realtimeSwapping independently of the main slot", () => {
		useModelSwapStore.setState({ activeRealtime: "tiny-rt" });
		const { result } = renderHook(() => useSwapProgress());
		expect(result.current.realtimeSwapping).toBe(true);
		expect(result.current.mainSwapping).toBe(false);
	});

	test("does NOT flag realtimeSwapping while its target is the primary download", () => {
		useModelSwapStore.setState({ activeRealtime: "tiny-rt" });
		useDownloadStore.setState({
			quantDownloads: { rt: quantEntry("tiny-rt", 55) },
		});
		const { result } = renderHook(() => useSwapProgress());
		expect(result.current.realtimeSwapping).toBe(false);
		expect(result.current.downloadProgress?.modelId).toBe("tiny-rt");
	});

	test("can flag both main and realtime swapping at once", () => {
		useModelSwapStore.setState({ activeMain: "cohere", activeRealtime: "tiny-rt" });
		const { result } = renderHook(() => useSwapProgress());
		expect(result.current.mainSwapping).toBe(true);
		expect(result.current.realtimeSwapping).toBe(true);
	});

	test("reacts to a store update while mounted (begin then resolve a main swap)", () => {
		const { result, rerender } = renderHook(() => useSwapProgress());
		expect(result.current.mainSwapping).toBe(false);

		useModelSwapStore.setState({ activeMain: "cohere" });
		rerender();
		expect(result.current.mainSwapping).toBe(true);

		useModelSwapStore.setState({ activeMain: null });
		rerender();
		expect(result.current.mainSwapping).toBe(false);
	});
});
