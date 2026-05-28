import { describe, expect, mock, test } from "bun:test";
import {
	advanceSkipRefs,
	autoStartChanged,
	clearIfSet,
	computeSilenceEndpointEnabled,
	computeSilenceTiming,
	deriveBroadcastUpdate,
	getManualToggleStop,
	getPrevManualToggleStop,
	getPrevSmartEndpoint,
	getRecordingMode,
	getSmartEndpoint,
	isModeChanged,
	mergeBroadcastPreservingUserDirty,
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
	test("returns true when server running, loaded, IPC-load complete, not yet synced", () => {
		expect(shouldSyncOnConnect("running", true, false, true)).toBe(true);
	});

	test("returns false when server is not running", () => {
		expect(shouldSyncOnConnect("idle", true, false, true)).toBe(false);
	});

	test("returns false when settings are not loaded", () => {
		expect(shouldSyncOnConnect("running", false, false, true)).toBe(false);
	});

	test("returns false when already synced", () => {
		expect(shouldSyncOnConnect("running", true, true, true)).toBe(false);
	});

	test("returns false when only localStorage hydrated (IPC load not yet complete)", () => {
		// The bug we're fixing: localStorage hydration flips isLoaded=true
		// synchronously with potentially-stale data. Without the fromIpcLoad
		// gate, the first syncToServer re-asserts the stale cache and
		// triggers a spurious model swap on the server.
		expect(shouldSyncOnConnect("running", true, false, false)).toBe(false);
	});
});

describe("getSmartEndpoint", () => {
	test("returns the smartEndpoint value when present", () => {
		expect(getSmartEndpoint({ quality: { smartEndpoint: true } } as never)).toBe(true);
		expect(getSmartEndpoint({ quality: { smartEndpoint: false } } as never)).toBe(false);
	});

	test("defaults to true when quality is absent", () => {
		expect(getSmartEndpoint({} as never)).toBe(true);
	});

	test("defaults to true when smartEndpoint is undefined", () => {
		expect(getSmartEndpoint({ quality: {} } as never)).toBe(true);
	});
});

describe("getPrevSmartEndpoint", () => {
	test("returns the smartEndpoint value when prev is provided", () => {
		expect(getPrevSmartEndpoint({ quality: { smartEndpoint: true } } as never)).toBe(true);
	});

	test("defaults to true when prev is undefined", () => {
		expect(getPrevSmartEndpoint(undefined)).toBe(true);
	});

	test("defaults to true when prev has no quality", () => {
		expect(getPrevSmartEndpoint({} as never)).toBe(true);
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

describe("mergeBroadcastPreservingUserDirty", () => {
	// Minimal AppSettings shape — only the top-level sections we touch in this
	// test matter; we cast away through `unknown` so we don't need to mock the
	// full Zod-output type here.
	interface Mini {
		audio: { silero: number };
		general: { overlayMode: string };
	}
	const cast = <T>(v: T) => v as unknown as Parameters<typeof mergeBroadcastPreservingUserDirty>[0];
	// Read-back boundary cast: the merge returns the real AppSettings type; we
	// view it as the local Mini shape to assert on the handful of fields we set.
	const asMini = (v: unknown) => v as unknown as Mini;

	test("returns identity (use decoded) when there is no lastSaved baseline", () => {
		const decoded: Mini = { general: { overlayMode: "floating-bottom" }, audio: { silero: 0.4 } };
		const current: Mini = { general: { overlayMode: "dynamic-island" }, audio: { silero: 0.4 } };
		const { merged, preserved } = mergeBroadcastPreservingUserDirty(
			cast(decoded),
			cast(current),
			undefined
		);
		expect(merged).toBe(cast(decoded));
		expect(preserved).toBe(false);
	});

	test("uses decoded when current matches lastSaved for every section (pure broadcast)", () => {
		const decoded: Mini = { general: { overlayMode: "dynamic-island" }, audio: { silero: 0.5 } };
		const current: Mini = { general: { overlayMode: "floating-bottom" }, audio: { silero: 0.4 } };
		const lastSaved: Mini = { ...current };
		const { merged, preserved } = mergeBroadcastPreservingUserDirty(
			cast(decoded),
			cast(current),
			cast(lastSaved)
		);
		expect(merged).toEqual(cast(decoded));
		expect(preserved).toBe(false);
	});

	test("preserves a user-dirty section (current differs from lastSaved) and accepts broadcast for others", () => {
		// This is the canonical race: user clicked overlayMode → general is
		// dirty in `current`. A broadcast from another window's save lands
		// (with `audio` updated, but general still showing the on-disk
		// pre-click value). The merge must keep current.general while
		// accepting decoded.audio.
		const decoded: Mini = { general: { overlayMode: "floating-bottom" }, audio: { silero: 0.5 } };
		const current: Mini = { general: { overlayMode: "dynamic-island" }, audio: { silero: 0.4 } };
		const lastSaved: Mini = { general: { overlayMode: "floating-bottom" }, audio: { silero: 0.4 } };
		const { merged, preserved } = mergeBroadcastPreservingUserDirty(
			cast(decoded),
			cast(current),
			cast(lastSaved)
		);
		expect(asMini(merged).general.overlayMode).toBe("dynamic-island");
		expect(asMini(merged).audio.silero).toBe(0.5);
		expect(preserved).toBe(true);
	});

	test("treats deep-equal sections as not dirty (reference inequality alone is not enough)", () => {
		const decoded: Mini = { general: { overlayMode: "floating-bottom" }, audio: { silero: 0.5 } };
		// Same structural content as lastSaved but a fresh object reference —
		// must not be flagged as user-dirty.
		const current: Mini = { general: { overlayMode: "floating-bottom" }, audio: { silero: 0.4 } };
		const lastSaved: Mini = { general: { overlayMode: "floating-bottom" }, audio: { silero: 0.4 } };
		const { merged, preserved } = mergeBroadcastPreservingUserDirty(
			cast(decoded),
			cast(current),
			cast(lastSaved)
		);
		expect(asMini(merged).general.overlayMode).toBe("floating-bottom");
		expect(asMini(merged).audio.silero).toBe(0.5);
		expect(preserved).toBe(false);
	});

	test("preserves multiple dirty sections simultaneously", () => {
		const decoded: Mini = { general: { overlayMode: "floating-bottom" }, audio: { silero: 0.4 } };
		const current: Mini = { general: { overlayMode: "dynamic-island" }, audio: { silero: 0.7 } };
		const lastSaved: Mini = { general: { overlayMode: "floating-bottom" }, audio: { silero: 0.4 } };
		const { merged, preserved } = mergeBroadcastPreservingUserDirty(
			cast(decoded),
			cast(current),
			cast(lastSaved)
		);
		expect(asMini(merged).general.overlayMode).toBe("dynamic-island");
		expect(asMini(merged).audio.silero).toBe(0.7);
		expect(preserved).toBe(true);
	});
});

describe("deriveBroadcastUpdate", () => {
	// `deriveBroadcastUpdate` calls decodeSettingsPayload internally, which
	// runs the full schema parse — feed it inputs the schema accepts.
	type AnySettings = Parameters<typeof deriveBroadcastUpdate>[0];

	function freshDefaults(): AnySettings {
		// Empty object → schema fills in every default. Cheap way to get a
		// valid AppSettings without listing every section.
		return {} as AnySettings;
	}

	// Boundary cast: expose the writable `audio` slice on the opaque AppSettings
	// value so a test can hand-craft a user-dirty section.
	const asAudioWritable = (s: AnySettings) => s as unknown as { audio: { silero: number } };

	test("pure broadcast (no preserved dirt) flips nextFromBroadcast=true", () => {
		const result = deriveBroadcastUpdate(freshDefaults(), freshDefaults(), undefined, false);
		expect(result.nextFromBroadcast).toBe(true);
	});

	test("preserved dirt keeps nextFromBroadcast at the prior value (false stays false)", () => {
		const current = freshDefaults();
		const lastSaved = freshDefaults();
		// Hand-craft a user-dirty section so preserved=true. Override one key on
		// current that doesn't match lastSaved.
		asAudioWritable(current).audio = { silero: 0.99 };
		asAudioWritable(lastSaved).audio = { silero: 0.5 };
		const result = deriveBroadcastUpdate(freshDefaults(), current, lastSaved, false);
		expect(result.nextFromBroadcast).toBe(false);
	});

	test("preserved dirt keeps a prior true at true (sticky)", () => {
		const current = freshDefaults();
		const lastSaved = freshDefaults();
		asAudioWritable(current).audio = { silero: 0.99 };
		asAudioWritable(lastSaved).audio = { silero: 0.5 };
		const result = deriveBroadcastUpdate(freshDefaults(), current, lastSaved, true);
		expect(result.nextFromBroadcast).toBe(true);
	});
});
