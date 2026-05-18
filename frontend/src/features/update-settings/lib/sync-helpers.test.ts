import { describe, expect, mock, test } from "bun:test";
import {
	advanceSkipRefs,
	autoStartChanged,
	clearIfSet,
	computeSilenceEndpointEnabled,
	computeSilenceTiming,
	getManualToggleStop,
	getPrevManualToggleStop,
	getPrevSmartEndpoint,
	getRecordingMode,
	getSmartEndpoint,
	isModeChanged,
	scheduleSave,
	shouldSendInitial,
	shouldSendOnChange,
	shouldSyncOnConnect,
	silenceEndpointNeedsUpdate,
	silenceTimingNeedsUpdate,
} from "./sync-helpers";

describe("shouldSendInitial", () => {
	test("returns true for a non-null value", () => {
		expect(shouldSendInitial(0)).toBe(true);
		expect(shouldSendInitial("")).toBe(true);
		expect(shouldSendInitial(false)).toBe(true);
		expect(shouldSendInitial(42)).toBe(true);
	});

	test("returns false for null", () => {
		expect(shouldSendInitial(null)).toBe(false);
	});

	test("returns false for undefined", () => {
		expect(shouldSendInitial(undefined)).toBe(false);
	});
});

describe("shouldSendOnChange", () => {
	test("returns true when value changed", () => {
		expect(shouldSendOnChange(1, 2)).toBe(true);
		expect(shouldSendOnChange("a", "b")).toBe(true);
		expect(shouldSendOnChange(true, false)).toBe(true);
		expect(shouldSendOnChange(null, undefined)).toBe(true);
	});

	test("returns false when value is the same", () => {
		expect(shouldSendOnChange(1, 1)).toBe(false);
		expect(shouldSendOnChange("x", "x")).toBe(false);
		expect(shouldSendOnChange(null, null)).toBe(false);
		expect(shouldSendOnChange(undefined, undefined)).toBe(false);
	});
});

describe("computeSilenceTiming", () => {
	test("returns true for 'toggle' mode regardless of smartEndpoint", () => {
		expect(computeSilenceTiming(false, "toggle")).toBe(true);
	});

	test("returns true for 'listen' mode regardless of smartEndpoint", () => {
		expect(computeSilenceTiming(false, "listen")).toBe(true);
	});

	test("returns false for ptt mode with smartEndpoint off", () => {
		expect(computeSilenceTiming(false, "ptt")).toBe(false);
	});

	test("returns false for ptt mode even when smartEndpoint is on", () => {
		expect(computeSilenceTiming(true, "ptt")).toBe(false);
	});

	test("returns true when smartEndpoint and mode both active", () => {
		expect(computeSilenceTiming(true, "toggle")).toBe(true);
	});

	test("returns false for toggle + manualToggleStop", () => {
		expect(computeSilenceTiming(false, "toggle", true)).toBe(false);
	});

	test("manualToggleStop overrides smartEndpoint in toggle mode", () => {
		expect(computeSilenceTiming(true, "toggle", true)).toBe(false);
	});

	test("manualToggleStop has no effect on listen mode", () => {
		expect(computeSilenceTiming(false, "listen", true)).toBe(true);
	});
});

describe("computeSilenceEndpointEnabled", () => {
	test("returns false for ptt mode", () => {
		expect(computeSilenceEndpointEnabled("ptt")).toBe(false);
	});

	test("returns true for toggle mode by default", () => {
		expect(computeSilenceEndpointEnabled("toggle")).toBe(true);
	});

	test("returns true for listen mode by default", () => {
		expect(computeSilenceEndpointEnabled("listen")).toBe(true);
	});

	test("returns false for toggle + manualToggleStop", () => {
		expect(computeSilenceEndpointEnabled("toggle", true)).toBe(false);
	});

	test("manualToggleStop has no effect on listen mode", () => {
		expect(computeSilenceEndpointEnabled("listen", true)).toBe(true);
	});

	test("manualToggleStop has no effect on ptt mode", () => {
		expect(computeSilenceEndpointEnabled("ptt", true)).toBe(false);
	});
});

describe("silenceTimingNeedsUpdate", () => {
	test("returns true on initial connect regardless of changes", () => {
		expect(silenceTimingNeedsUpdate(false, false, "ptt", "ptt", true)).toBe(true);
	});

	test("returns true when recording mode changed", () => {
		expect(silenceTimingNeedsUpdate(false, false, "toggle", "ptt", false)).toBe(true);
	});

	test("returns true when smartEndpoint toggled", () => {
		expect(silenceTimingNeedsUpdate(true, false, "ptt", "ptt", false)).toBe(true);
	});

	test("returns false when nothing changed (incremental)", () => {
		expect(silenceTimingNeedsUpdate(false, false, "ptt", "ptt", false)).toBe(false);
	});

	test("returns true when both mode and smartEndpoint changed", () => {
		expect(silenceTimingNeedsUpdate(true, false, "listen", "ptt", false)).toBe(true);
	});

	test("returns true when manualToggleStop flipped", () => {
		expect(silenceTimingNeedsUpdate(false, false, "toggle", "toggle", false, true, false)).toBe(
			true
		);
	});

	test("returns false when manualToggleStop is unchanged and everything else stable", () => {
		expect(silenceTimingNeedsUpdate(false, false, "toggle", "toggle", false, true, true)).toBe(
			false
		);
	});
});

describe("silenceEndpointNeedsUpdate", () => {
	test("returns true on initial connect", () => {
		expect(silenceEndpointNeedsUpdate("toggle", "toggle", true)).toBe(true);
	});

	test("returns true when recording mode changed", () => {
		expect(silenceEndpointNeedsUpdate("toggle", "ptt", false)).toBe(true);
	});

	test("returns true when manualToggleStop flipped", () => {
		expect(silenceEndpointNeedsUpdate("toggle", "toggle", false, true, false)).toBe(true);
	});

	test("returns false when nothing relevant changed", () => {
		expect(silenceEndpointNeedsUpdate("toggle", "toggle", false, false, false)).toBe(false);
	});
});

describe("getManualToggleStop / getPrevManualToggleStop", () => {
	test("getManualToggleStop reads the flag when present", () => {
		expect(getManualToggleStop({ general: { manualToggleStop: true } } as never)).toBe(true);
		expect(getManualToggleStop({ general: { manualToggleStop: false } } as never)).toBe(false);
	});

	test("getManualToggleStop returns false when general is absent", () => {
		expect(getManualToggleStop({} as never)).toBe(false);
	});

	test("getPrevManualToggleStop returns false when prev is undefined", () => {
		expect(getPrevManualToggleStop(undefined)).toBe(false);
	});

	test("getPrevManualToggleStop returns false when prev has no general", () => {
		expect(getPrevManualToggleStop({} as never)).toBe(false);
	});

	test("getPrevManualToggleStop returns the flag when present", () => {
		expect(getPrevManualToggleStop({ general: { manualToggleStop: true } } as never)).toBe(true);
	});
});

describe("autoStartChanged", () => {
	test("returns true when autoStart changed from false to true", () => {
		const curr = { general: { autoStart: true } } as never;
		const prev = { general: { autoStart: false } } as never;
		expect(autoStartChanged(curr, prev)).toBe(true);
	});

	test("returns true when autoStart changed from true to false", () => {
		const curr = { general: { autoStart: false } } as never;
		const prev = { general: { autoStart: true } } as never;
		expect(autoStartChanged(curr, prev)).toBe(true);
	});

	test("returns false when autoStart is unchanged", () => {
		const curr = { general: { autoStart: true } } as never;
		const prev = { general: { autoStart: true } } as never;
		expect(autoStartChanged(curr, prev)).toBe(false);
	});

	test("returns false when new autoStart is null/undefined", () => {
		const curr = { general: {} } as never;
		const prev = { general: { autoStart: true } } as never;
		expect(autoStartChanged(curr, prev)).toBe(false);
	});

	test("returns false when general is missing", () => {
		const curr = {} as never;
		const prev = { general: { autoStart: true } } as never;
		expect(autoStartChanged(curr, prev)).toBe(false);
	});

	test("returns true when prev has no general (autoStart added from undefined)", () => {
		// Without optional chaining on prev.general, this would throw a TypeError.
		const curr = { general: { autoStart: true } } as never;
		const prev = {} as never;
		expect(autoStartChanged(curr, prev)).toBe(true);
	});
});

describe("clearIfSet", () => {
	test("returns true and clears ref when ref is set", () => {
		const ref = { current: true };
		expect(clearIfSet(ref)).toBe(true);
		expect(ref.current).toBe(false);
	});

	test("returns false and leaves ref unchanged when not set", () => {
		const ref = { current: false };
		expect(clearIfSet(ref)).toBe(false);
		expect(ref.current).toBe(false);
	});
});

describe("advanceSkipRefs", () => {
	function makeRefs(loaded: boolean, broadcast: boolean, ipcLoad: boolean) {
		return {
			loadedOnce: { current: loaded },
			fromBroadcast: { current: broadcast },
			fromIpcLoad: { current: ipcLoad },
		};
	}

	test("returns true and sets loadedOnce=true on first call", () => {
		const refs = makeRefs(false, false, false);
		const result = advanceSkipRefs(refs);
		expect(result).toBe(true);
		expect(refs.loadedOnce.current).toBe(true);
	});

	test("returns true and clears fromBroadcast when it is set", () => {
		const refs = makeRefs(true, true, false);
		const result = advanceSkipRefs(refs);
		expect(result).toBe(true);
		expect(refs.fromBroadcast.current).toBe(false);
	});

	test("returns true and clears fromIpcLoad when it is set", () => {
		const refs = makeRefs(true, false, true);
		const result = advanceSkipRefs(refs);
		expect(result).toBe(true);
		expect(refs.fromIpcLoad.current).toBe(false);
	});

	test("returns false when all skip conditions are cleared", () => {
		const refs = makeRefs(true, false, false);
		const result = advanceSkipRefs(refs);
		expect(result).toBe(false);
	});

	test("prioritizes loadedOnce over fromBroadcast", () => {
		const refs = makeRefs(false, true, false);
		const result = advanceSkipRefs(refs);
		expect(result).toBe(true);
		// loadedOnce was the trigger, fromBroadcast should still be true
		expect(refs.fromBroadcast.current).toBe(true);
		expect(refs.loadedOnce.current).toBe(true);
	});
});

describe("shouldSyncOnConnect", () => {
	test("returns true when server is running, loaded, and not yet synced", () => {
		expect(shouldSyncOnConnect("running", true, false)).toBe(true);
	});

	test("returns false when server is not running", () => {
		expect(shouldSyncOnConnect("idle", true, false)).toBe(false);
	});

	test("returns false when settings are not loaded", () => {
		expect(shouldSyncOnConnect("running", false, false)).toBe(false);
	});

	test("returns false when already synced", () => {
		expect(shouldSyncOnConnect("running", true, true)).toBe(false);
	});
});

describe("getSmartEndpoint", () => {
	test("returns the smartEndpoint value when present", () => {
		expect(getSmartEndpoint({ quality: { smartEndpoint: true } } as never)).toBe(true);
		expect(getSmartEndpoint({ quality: { smartEndpoint: false } } as never)).toBe(false);
	});

	test("returns false when quality is absent", () => {
		expect(getSmartEndpoint({} as never)).toBe(false);
	});

	test("returns false when smartEndpoint is undefined", () => {
		expect(getSmartEndpoint({ quality: {} } as never)).toBe(false);
	});
});

describe("getPrevSmartEndpoint", () => {
	test("returns the smartEndpoint value when prev is provided", () => {
		expect(getPrevSmartEndpoint({ quality: { smartEndpoint: true } } as never)).toBe(true);
	});

	test("returns false when prev is undefined", () => {
		expect(getPrevSmartEndpoint(undefined)).toBe(false);
	});

	test("returns false when prev has no quality", () => {
		expect(getPrevSmartEndpoint({} as never)).toBe(false);
	});
});

describe("getRecordingMode", () => {
	test("returns the recording mode when set", () => {
		expect(getRecordingMode({ general: { recordingMode: "toggle" } } as never)).toBe("toggle");
		expect(getRecordingMode({ general: { recordingMode: "listen" } } as never)).toBe("listen");
	});

	test("returns 'ptt' when general is absent", () => {
		expect(getRecordingMode({} as never)).toBe("ptt");
	});

	test("returns 'ptt' when recordingMode is undefined", () => {
		expect(getRecordingMode({ general: {} } as never)).toBe("ptt");
	});
});

describe("isModeChanged", () => {
	test("returns true when recording mode changed", () => {
		const curr = { general: { recordingMode: "toggle" } } as never;
		const prev = { general: { recordingMode: "ptt" } } as never;
		expect(isModeChanged(curr, prev)).toBe(true);
	});

	test("returns false when recording mode is unchanged", () => {
		const curr = { general: { recordingMode: "ptt" } } as never;
		const prev = { general: { recordingMode: "ptt" } } as never;
		expect(isModeChanged(curr, prev)).toBe(false);
	});

	test("returns false when both have no general settings", () => {
		const curr = {} as never;
		const prev = {} as never;
		expect(isModeChanged(curr, prev)).toBe(false);
	});

	test("returns true when mode changes from undefined to a value", () => {
		const curr = { general: { recordingMode: "ptt" } } as never;
		const prev = { general: {} } as never;
		expect(isModeChanged(curr, prev)).toBe(true);
	});
});

describe("scheduleSave", () => {
	const settings = {} as never;

	test("calls saveFn immediately when immediate=true", () => {
		const saveFn = mock(() => undefined);
		const debounceRef = { current: null };
		scheduleSave(settings, true, debounceRef, saveFn, 300);
		expect(saveFn).toHaveBeenCalledWith(settings);
		expect(debounceRef.current).toBeNull();
	});

	test("schedules a debounced call when immediate=false", async () => {
		const saveFn = mock(() => undefined);
		const debounceRef: { current: ReturnType<typeof setTimeout> | null } = { current: null };
		scheduleSave(settings, false, debounceRef, saveFn, 10);
		expect(saveFn).not.toHaveBeenCalled();
		expect(debounceRef.current).not.toBeNull();
		await new Promise((r) => setTimeout(r, 20));
		expect(saveFn).toHaveBeenCalledWith(settings);
		expect(debounceRef.current).toBeNull();
	});

	test("cancels a pending debounce before scheduling a new one", () => {
		const saveFn = mock(() => undefined);
		const prevTimer = setTimeout(() => undefined, 10_000);
		const debounceRef: { current: ReturnType<typeof setTimeout> | null } = { current: prevTimer };
		scheduleSave(settings, true, debounceRef, saveFn, 300);
		// prevTimer was cleared; immediate save ran
		expect(saveFn).toHaveBeenCalledTimes(1);
		expect(debounceRef.current).toBeNull();
	});
});
