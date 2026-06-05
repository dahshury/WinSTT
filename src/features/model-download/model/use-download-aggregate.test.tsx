import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";
import { act, renderHook } from "@testing-library/react";

// download-store imports ipc-client at module-eval time (for its action
// implementations). Install the complete, behavior-faithful fake so the
// import chain resolves cleanly and never leaks an incomplete stub into
// sibling suites. The aggregate hook itself only READS selectors, so no IPC
// call is exercised here.
mock.module("@/shared/api/ipc-client", () => ipcClientMock());

const { useDownloadStore } = await import("./download-store");
const { useDownloadAggregate } = await import("./use-download-aggregate");

import type { QuantDownloadState } from "./download-store";

// The pristine factory state, captured before any setState mutates the live
// singleton. download-store has no `reset` action, so each test rebuilds the
// fields it cares about from this snapshot.
const INITIAL_STATE = useDownloadStore.getInitialState();

function makeQuantEntry(
	modelId: string,
	quantization: string,
	progress: number | null,
	paused = false
): QuantDownloadState {
	return {
		modelId,
		quantization,
		progress,
		downloadedBytes: 0,
		totalBytes: 0,
		speedBps: 0,
		paused,
	};
}

beforeEach(() => {
	// Reset only the fields the aggregate reads back to their documented
	// defaults so each test starts from a clean slate.
	useDownloadStore.setState({
		isDownloading: false,
		modelName: null,
		progress: null,
		quantDownloads: {},
	});
});

afterEach(() => {
	useDownloadStore.setState({
		isDownloading: INITIAL_STATE.isDownloading,
		modelName: INITIAL_STATE.modelName,
		progress: INITIAL_STATE.progress,
		quantDownloads: INITIAL_STATE.quantDownloads,
	});
});

describe("useDownloadAggregate", () => {
	test("returns null when no download is active", () => {
		const { result } = renderHook(() => useDownloadAggregate());
		expect(result.current).toBeNull();
	});

	test("ignores the legacy singleton when isDownloading is false", () => {
		// modelName/progress are set but the singleton is not flagged active —
		// it must NOT be counted as an in-flight download.
		useDownloadStore.setState({
			isDownloading: false,
			modelName: "whisper-tiny",
			progress: 42,
		});
		const { result } = renderHook(() => useDownloadAggregate());
		expect(result.current).toBeNull();
	});

	test("ignores the legacy singleton when modelName is null even if active", () => {
		// Guard the `singletonName !== null` branch: active flag alone is not
		// enough — without a name there is nothing to render.
		useDownloadStore.setState({
			isDownloading: true,
			modelName: null,
			progress: 10,
		});
		const { result } = renderHook(() => useDownloadAggregate());
		expect(result.current).toBeNull();
	});

	test("aggregates the legacy singleton alone", () => {
		useDownloadStore.setState({
			isDownloading: true,
			modelName: "whisper-tiny",
			progress: 60,
		});
		const { result } = renderHook(() => useDownloadAggregate());
		expect(result.current).toEqual({
			count: 1,
			averagePercent: 60,
			primary: { modelId: "whisper-tiny", percent: 60 },
		});
	});

	test("singleton with null progress yields null averagePercent (indeterminate)", () => {
		useDownloadStore.setState({
			isDownloading: true,
			modelName: "whisper-tiny",
			progress: null,
		});
		const { result } = renderHook(() => useDownloadAggregate());
		expect(result.current).toEqual({
			count: 1,
			averagePercent: null,
			primary: { modelId: "whisper-tiny", percent: null },
		});
	});

	test("aggregates per-quant entries from quantDownloads", () => {
		useDownloadStore.setState({
			quantDownloads: {
				"whisper-base@q4": makeQuantEntry("whisper-base", "q4", 30),
				"whisper-base@fp16": makeQuantEntry("whisper-base", "fp16", 70),
			},
		});
		const { result } = renderHook(() => useDownloadAggregate());
		expect(result.current?.count).toBe(2);
		// mean(30, 70) = 50
		expect(result.current?.averagePercent).toBe(50);
		// highest percent wins primary
		expect(result.current?.primary).toEqual({ modelId: "whisper-base", percent: 70 });
	});

	test("excludes paused per-quant entries from the outside aggregate", () => {
		useDownloadStore.setState({
			quantDownloads: {
				"whisper-base@q4": makeQuantEntry("whisper-base", "q4", 30, true),
			},
		});
		const { result } = renderHook(() => useDownloadAggregate());
		expect(result.current).toBeNull();
	});

	test("aggregates active per-quant entries while ignoring paused siblings", () => {
		useDownloadStore.setState({
			quantDownloads: {
				"whisper-base@q4": makeQuantEntry("whisper-base", "q4", 30, true),
				"whisper-base@fp16": makeQuantEntry("whisper-base", "fp16", 70),
			},
		});
		const { result } = renderHook(() => useDownloadAggregate());
		expect(result.current).toEqual({
			count: 1,
			averagePercent: 70,
			primary: { modelId: "whisper-base", percent: 70 },
		});
	});

	test("combines the legacy singleton AND per-quant entries", () => {
		useDownloadStore.setState({
			isDownloading: true,
			modelName: "singleton-model",
			progress: 20,
			quantDownloads: {
				"whisper-base@q4": makeQuantEntry("whisper-base", "q4", 80),
			},
		});
		const { result } = renderHook(() => useDownloadAggregate());
		expect(result.current?.count).toBe(2);
		// mean(20, 80) = 50
		expect(result.current?.averagePercent).toBe(50);
		expect(result.current?.primary).toEqual({ modelId: "whisper-base", percent: 80 });
	});

	test("averagePercent skips indeterminate (null) entries and rounds the mean", () => {
		useDownloadStore.setState({
			quantDownloads: {
				"a@q4": makeQuantEntry("a", "q4", 33),
				"b@q4": makeQuantEntry("b", "q4", 34),
				// null is excluded from the mean entirely.
				"c@q4": makeQuantEntry("c", "q4", null),
			},
		});
		const { result } = renderHook(() => useDownloadAggregate());
		expect(result.current?.count).toBe(3);
		// mean(33, 34) = 33.5 → Math.round → 34 (the null entry does NOT pull
		// the average down).
		expect(result.current?.averagePercent).toBe(34);
	});

	test("averagePercent is null when every active download is indeterminate", () => {
		useDownloadStore.setState({
			quantDownloads: {
				"a@q4": makeQuantEntry("a", "q4", null),
				"b@q4": makeQuantEntry("b", "q4", null),
			},
		});
		const { result } = renderHook(() => useDownloadAggregate());
		expect(result.current?.count).toBe(2);
		expect(result.current?.averagePercent).toBeNull();
	});

	test("primary prefers any numeric percent over a null (indeterminate) entry", () => {
		// pickPrimary ranks null below any number (null → -1). The first entry
		// here is indeterminate; the numeric one must still win primary.
		useDownloadStore.setState({
			quantDownloads: {
				"indeterminate@q4": makeQuantEntry("indeterminate", "q4", null),
				"numeric@q4": makeQuantEntry("numeric", "q4", 5),
			},
		});
		const { result } = renderHook(() => useDownloadAggregate());
		expect(result.current?.primary).toEqual({ modelId: "numeric", percent: 5 });
	});

	test("primary breaks ties on first iteration order (no flicker)", () => {
		// Equal percents → the FIRST-iterated entry stays primary. The legacy
		// singleton is pushed first, so it wins a tie against a quant entry.
		useDownloadStore.setState({
			isDownloading: true,
			modelName: "first-singleton",
			progress: 50,
			quantDownloads: {
				"second@q4": makeQuantEntry("second", "q4", 50),
			},
		});
		const { result } = renderHook(() => useDownloadAggregate());
		expect(result.current?.primary).toEqual({ modelId: "first-singleton", percent: 50 });
	});

	test("primary is the only-null entry when all are indeterminate", () => {
		// Exercises pickPrimary's loop where neither candidate beats best
		// (both -1), so `best` stays the first entry.
		useDownloadStore.setState({
			quantDownloads: {
				"first@q4": makeQuantEntry("first", "q4", null),
				"second@q4": makeQuantEntry("second", "q4", null),
			},
		});
		const { result } = renderHook(() => useDownloadAggregate());
		expect(result.current?.primary).toEqual({ modelId: "first", percent: null });
	});

	test("re-renders when the store updates", () => {
		const { result, rerender } = renderHook(() => useDownloadAggregate());
		expect(result.current).toBeNull();
		act(() => {
			useDownloadStore.setState({
				isDownloading: true,
				modelName: "late-arrival",
				progress: 12,
			});
		});
		rerender();
		expect(result.current?.count).toBe(1);
		expect(result.current?.primary).toEqual({ modelId: "late-arrival", percent: 12 });
	});
});
