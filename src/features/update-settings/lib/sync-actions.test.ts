import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AllowedParameter } from "@/shared/api/models";
import type { AppSettingsOutput as AppSettings } from "@/shared/config/settings-schema";
import {
	AUDIO_PARAM_MAP,
	diarizationNeedsPush,
	modelUnloadTimeoutNeedsPush,
	readDiarizationEnabled,
	resolveModelUnloadTimeoutSeconds,
	type SyncDeps,
	sendIfChanged,
	shouldSendParam,
	syncAudioEntries,
	syncAudioParams,
	syncDiarizationParams,
	syncModelParams,
	syncQualityParams,
	syncTextCorrectionParams,
	syncToServer,
} from "./sync-actions";

function makeDeps() {
	const calls: Array<{ kind: string; args: unknown[] }> = [];
	const deps: SyncDeps = {
		sttRequestDiarizationToggle: mock((enabled: boolean) =>
			calls.push({ kind: "sttRequestDiarizationToggle", args: [enabled] })
		),
		sttSetParameter: mock(<V>(param: AllowedParameter, value: V) =>
			calls.push({ kind: "sttSetParameter", args: [param, value] })
		),
	};
	return { deps, calls };
}

function settingsWith(overrides: Partial<AppSettings>): AppSettings {
	return overrides as AppSettings;
}

beforeEach(() => {
	// No global state.
});

describe("AUDIO_PARAM_MAP", () => {
	test("does not expose audio settings through no-op STT parameters", () => {
		expect(AUDIO_PARAM_MAP).toEqual({});
	});
});

describe("shouldSendParam", () => {
	test("initial mode delegates to shouldSendInitial", () => {
		expect(shouldSendParam(0.4, undefined, true)).toBe(true);
		expect(shouldSendParam(null, undefined, true)).toBe(false);
	});

	test("incremental mode delegates to shouldSendOnChange", () => {
		expect(shouldSendParam(0.4, 0.4, false)).toBe(false);
		expect(shouldSendParam(0.5, 0.4, false)).toBe(true);
	});
});

describe("sendIfChanged", () => {
	test("invokes sttSetParameter when the gate says yes", () => {
		const { deps, calls } = makeDeps();
		sendIfChanged(deps, false, true, "filter_fillers", false);
		expect(calls).toEqual([{ kind: "sttSetParameter", args: ["filter_fillers", false] }]);
	});

	test("is a no-op when the value is unchanged (incremental)", () => {
		const { deps, calls } = makeDeps();
		sendIfChanged(deps, false, false, "filter_fillers", false);
		expect(calls).toEqual([]);
	});

	test("is a no-op when the value is null on initial connect", () => {
		const { deps, calls } = makeDeps();
		sendIfChanged(deps, null, undefined, "filter_fillers", true);
		expect(calls).toEqual([]);
	});
});

describe("syncAudioEntries", () => {
	test("does not push unsupported audio entries", () => {
		const { deps, calls } = makeDeps();
		syncAudioEntries(
			deps,
			{
				sileroSensitivity: 0.5,
				postSpeechSilenceDuration: 0.7,
				wakeWordActivationDelay: 0.1,
				inputDeviceIndex: 1,
			} as never,
			undefined,
			true
		);
		expect(calls).toEqual([]);
	});

	test("incremental mode remains a no-op for unsupported audio entries", () => {
		const { deps, calls } = makeDeps();
		syncAudioEntries(
			deps,
			{
				sileroSensitivity: 0.5,
				postSpeechSilenceDuration: 0.7,
			} as never,
			{
				sileroSensitivity: 0.5,
				postSpeechSilenceDuration: 0.5,
			} as never,
			false
		);
		expect(calls).toEqual([]);
	});
});

describe("syncAudioParams", () => {
	test("returns early when audio section is missing", () => {
		const { deps, calls } = makeDeps();
		syncAudioParams(deps, settingsWith({}), undefined);
		expect(calls).toEqual([]);
	});

	test("does not send VAD settings through no-op STT parameters", () => {
		const { deps, calls } = makeDeps();
		syncAudioParams(
			deps,
			settingsWith({
				audio: { sileroSensitivity: 0.42 } as never,
			}),
			undefined
		);
		expect(calls).toEqual([]);
	});

	test("does not translate microphoneRelease into legacy backend parameters", () => {
		const { deps, calls } = makeDeps();
		syncAudioParams(
			deps,
			settingsWith({
				audio: { microphoneRelease: "min1" } as never,
			}),
			undefined
		);
		const params = calls.map((c) => c.args[0]);
		expect(params).not.toContain("always_on_microphone");
		expect(params).not.toContain("lazy_stream_close");
		expect(params).not.toContain("lazy_close_timeout_seconds");
	});
});

describe("syncModelParams", () => {
	test("pushes language on initial connect", () => {
		const { deps, calls } = makeDeps();
		syncModelParams(deps, settingsWith({ model: { language: "en" } as never }), undefined);
		expect(calls).toEqual([{ kind: "sttSetParameter", args: ["language", "en"] }]);
	});

	test("does not push the `model` field (canonical swap path elsewhere)", () => {
		const { deps, calls } = makeDeps();
		syncModelParams(
			deps,
			settingsWith({ model: { model: "tiny", language: "en" } as never }),
			settingsWith({ model: { model: "tiny", language: "en" } as never })
		);
		expect(calls).toEqual([]);
	});
});

describe("global model unload timeout sync", () => {
	test("pushes global timeout on initial connect", () => {
		const { deps, calls } = makeDeps();
		syncToServer(
			deps,
			settingsWith({ global: { modelUnloadTimeout: "hour1" } } as never)
		);
		expect(calls).toContainEqual({
			kind: "sttSetParameter",
			args: ["model_unload_timeout_seconds", 3600],
		});
	});

	test("pushes global timeout when it changes", () => {
		const { deps, calls } = makeDeps();
		syncToServer(
			deps,
			settingsWith({ global: { modelUnloadTimeout: "never" } } as never),
			settingsWith({ global: { modelUnloadTimeout: "min5" } } as never)
		);
		expect(calls).toContainEqual({
			kind: "sttSetParameter",
			args: ["model_unload_timeout_seconds", -1],
		});
	});
});

describe("syncQualityParams", () => {
	test("pushes silence_timing AND every quality field on initial connect", () => {
		const { deps, calls } = makeDeps();
		syncQualityParams(
			deps,
			settingsWith({
				general: { recordingMode: "toggle" } as never,
				quality: {
					smartEndpoint: true,
					smartEndpointSpeed: 1,
					endOfSentenceDetectionPause: 0.3,
					midSentenceDetectionPause: 0.5,
					unknownSentenceDetectionPause: 0.7,
				} as never,
			}),
			undefined
		);
		const params = calls.map((c) => c.args[0]);
		expect(params).toContain("silence_timing");
		expect(params).toContain("smart_endpoint_enabled");
		expect(params).toContain("detection_speed");
		expect(params).toContain("end_of_sentence_detection_pause");
		expect(params).toContain("mid_sentence_detection_pause");
		expect(params).toContain("unknown_sentence_detection_pause");
	});

	test("skips silence_timing when no inputs that gate it have changed", () => {
		const { deps, calls } = makeDeps();
		const same = settingsWith({
			general: { recordingMode: "ptt", manualToggleStop: false } as never,
			quality: { smartEndpoint: false } as never,
		});
		syncQualityParams(deps, same, same);
		expect(calls.find((c) => c.args[0] === "silence_timing")).toBeUndefined();
	});

	// silence_endpoint_enabled is the master "server may auto-stop" switch.
	// It MUST be pushed through the canonical (server-ready-gated) sync, not
	// only via the racy usePushToTalk mount effect — otherwise a cold start
	// where the mount push is dropped leaves the server at its default True,
	// and PTT auto-stops on silence before the user releases the key.
	test("pushes silence_endpoint_enabled=false for PTT on initial connect", () => {
		const { deps, calls } = makeDeps();
		syncQualityParams(
			deps,
			settingsWith({ general: { recordingMode: "ptt" } as never }),
			undefined
		);
		expect(calls).toContainEqual({
			kind: "sttSetParameter",
			args: ["silence_endpoint_enabled", false],
		});
	});

	test("pushes silence_endpoint_enabled=true for toggle on initial connect", () => {
		const { deps, calls } = makeDeps();
		syncQualityParams(
			deps,
			settingsWith({ general: { recordingMode: "toggle", manualToggleStop: false } as never }),
			undefined
		);
		expect(calls).toContainEqual({
			kind: "sttSetParameter",
			args: ["silence_endpoint_enabled", true],
		});
	});

	test("re-pushes silence_endpoint_enabled when the recording mode flips", () => {
		const { deps, calls } = makeDeps();
		syncQualityParams(
			deps,
			settingsWith({ general: { recordingMode: "ptt" } as never }),
			settingsWith({ general: { recordingMode: "toggle" } as never })
		);
		expect(calls).toContainEqual({
			kind: "sttSetParameter",
			args: ["silence_endpoint_enabled", false],
		});
	});

	test("skips silence_endpoint_enabled when mode and manual-toggle-stop are unchanged", () => {
		const { deps, calls } = makeDeps();
		const same = settingsWith({
			general: { recordingMode: "ptt", manualToggleStop: false } as never,
			quality: { smartEndpoint: false } as never,
		});
		syncQualityParams(deps, same, same);
		expect(calls.find((c) => c.args[0] === "silence_endpoint_enabled")).toBeUndefined();
	});
});

describe("syncTextCorrectionParams", () => {
	test("pushes filter_fillers on initial connect (including false)", () => {
		const { deps, calls } = makeDeps();
		syncTextCorrectionParams(
			deps,
			settingsWith({ general: { filterFillers: false } as never }),
			undefined
		);
		expect(calls).toEqual([{ kind: "sttSetParameter", args: ["filter_fillers", false] }]);
	});

	test("pushes filter_fillers when the toggle flips (true → false)", () => {
		const { deps, calls } = makeDeps();
		syncTextCorrectionParams(
			deps,
			settingsWith({ general: { filterFillers: false } as never }),
			settingsWith({ general: { filterFillers: true } as never })
		);
		expect(calls).toEqual([{ kind: "sttSetParameter", args: ["filter_fillers", false] }]);
	});

	test("does NOT push filter_fillers on a no-op (unchanged)", () => {
		const { deps, calls } = makeDeps();
		const same = settingsWith({ general: { filterFillers: false } as never });
		syncTextCorrectionParams(deps, same, same);
		expect(calls).toEqual([]);
	});

	test("no-ops when general is missing", () => {
		const { deps, calls } = makeDeps();
		syncTextCorrectionParams(deps, settingsWith({}), undefined);
		expect(calls).toEqual([]);
	});
});

describe("readDiarizationEnabled", () => {
	test("returns the speakerDiarization flag when set", () => {
		expect(
			readDiarizationEnabled(settingsWith({ general: { speakerDiarization: true } as never }))
		).toBe(true);
		expect(
			readDiarizationEnabled(settingsWith({ general: { speakerDiarization: false } as never }))
		).toBe(false);
	});

	test("defaults to false when general is missing", () => {
		expect(readDiarizationEnabled(settingsWith({}))).toBe(false);
	});
});

describe("diarizationNeedsPush", () => {
	test("always true on initial connect (prev is undefined)", () => {
		expect(diarizationNeedsPush(true, undefined)).toBe(true);
		expect(diarizationNeedsPush(false, undefined)).toBe(true);
	});

	test("true on an actual flip", () => {
		expect(
			diarizationNeedsPush(true, settingsWith({ general: { speakerDiarization: false } as never }))
		).toBe(true);
	});

	test("false when state matches", () => {
		expect(
			diarizationNeedsPush(true, settingsWith({ general: { speakerDiarization: true } as never }))
		).toBe(false);
	});
});

describe("syncDiarizationParams", () => {
	test("pushes the toggle on initial connect", () => {
		const { deps, calls } = makeDeps();
		syncDiarizationParams(
			deps,
			settingsWith({ general: { speakerDiarization: true } as never }),
			undefined
		);
		expect(calls).toEqual([{ kind: "sttRequestDiarizationToggle", args: [true] }]);
	});

	test("does not push when the state is unchanged", () => {
		const { deps, calls } = makeDeps();
		const s = settingsWith({ general: { speakerDiarization: true } as never });
		syncDiarizationParams(deps, s, s);
		expect(calls).toEqual([]);
	});

	test("pushes on a flip", () => {
		const { deps, calls } = makeDeps();
		syncDiarizationParams(
			deps,
			settingsWith({ general: { speakerDiarization: false } as never }),
			settingsWith({ general: { speakerDiarization: true } as never })
		);
		expect(calls).toEqual([{ kind: "sttRequestDiarizationToggle", args: [false] }]);
	});
});

describe("syncToServer", () => {
	test("runs every per-section sync without throwing on an empty settings tree", () => {
		const { deps } = makeDeps();
		expect(() =>
			syncToServer(
				deps,
				settingsWith({
					audio: {} as never,
					model: {} as never,
					quality: {} as never,
					general: {} as never,
				})
			)
		).not.toThrow();
	});

	test("pushes the expected mix of params on initial connect", () => {
		const { deps, calls } = makeDeps();
		syncToServer(
			deps,
			settingsWith({
				audio: { sileroSensitivity: 0.5 } as never,
				model: { language: "en", model: "tiny" } as never,
				quality: { smartEndpoint: true } as never,
				general: { speakerDiarization: true, autoStart: true } as never,
			})
		);
		const kinds = calls.map((c) => c.kind);
		expect(kinds).toContain("sttSetParameter");
		expect(kinds).toContain("sttRequestDiarizationToggle");
	});
});

describe("resolveModelUnloadTimeoutSeconds", () => {
	test.each([
		["immediately", 0],
		["never", -1],
		["min2", 120],
		["min5", 300],
		["min10", 600],
		["min15", 900],
		["hour1", 3600],
	])("maps '%s' to %d seconds", (key, seconds) => {
		expect(resolveModelUnloadTimeoutSeconds(key)).toBe(seconds);
	});

	test("falls back to 300s default on unknown string", () => {
		expect(resolveModelUnloadTimeoutSeconds("totally-bogus")).toBe(300);
	});

	test("falls back to 300s default on non-string input", () => {
		expect(resolveModelUnloadTimeoutSeconds(null)).toBe(300);
		expect(resolveModelUnloadTimeoutSeconds(undefined)).toBe(300);
		expect(resolveModelUnloadTimeoutSeconds(42)).toBe(300);
	});
});

describe("modelUnloadTimeoutNeedsPush", () => {
	test("false when current is null/undefined", () => {
		expect(modelUnloadTimeoutNeedsPush(null, "min5", false)).toBe(false);
		expect(modelUnloadTimeoutNeedsPush(undefined, "min5", true)).toBe(false);
	});

	test("true on initial when current is set", () => {
		expect(modelUnloadTimeoutNeedsPush("min5", undefined, true)).toBe(true);
	});

	test("true on incremental when current differs from previous", () => {
		expect(modelUnloadTimeoutNeedsPush("never", "min5", false)).toBe(true);
	});

	test("false on incremental when current === previous", () => {
		expect(modelUnloadTimeoutNeedsPush("min5", "min5", false)).toBe(false);
	});
});
