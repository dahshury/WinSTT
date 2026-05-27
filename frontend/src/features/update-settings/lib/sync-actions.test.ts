import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AllowedParameter } from "@/shared/api/models";
import type { AppSettingsOutput as AppSettings } from "@/shared/config/settings-schema";
import {
	AUDIO_PARAM_MAP,
	diarizationNeedsPush,
	readDiarizationEnabled,
	type SyncDeps,
	sendIfChanged,
	shouldSendParam,
	syncAudioEntries,
	syncAudioParams,
	syncDiarizationParams,
	syncModelParams,
	syncQualityParams,
	syncSystemParams,
	syncToServer,
} from "./sync-actions";

function makeDeps() {
	const calls: Array<{ kind: string; args: unknown[] }> = [];
	const deps: SyncDeps = {
		autostartSet: mock((enabled: boolean) => calls.push({ kind: "autostartSet", args: [enabled] })),
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
	test("includes the canonical audio params plus hot-swap additions", () => {
		expect(AUDIO_PARAM_MAP).toEqual({
			sileroSensitivity: "silero_sensitivity",
			postSpeechSilenceDuration: "post_speech_silence_duration",
			wakeWordActivationDelay: "wake_word_activation_delay",
			inputDeviceIndex: "input_device_index",
			// webrtc + silero-deactivity moved off STARTUP_ONLY_KEYS_LIST —
			// they're now pushed via set_parameter on every change so the
			// recorder retunes its VAD (or persists the value) without a
			// process kill. See sync-actions.ts and recorder/__init__.py.
			webrtcSensitivity: "webrtc_sensitivity",
			sileroDeactivityDetection: "silero_deactivity_detection",
		});
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
		sendIfChanged(deps, 0.5, 0.4, "silero_sensitivity", false);
		expect(calls).toEqual([{ kind: "sttSetParameter", args: ["silero_sensitivity", 0.5] }]);
	});

	test("is a no-op when the value is unchanged (incremental)", () => {
		const { deps, calls } = makeDeps();
		sendIfChanged(deps, 0.4, 0.4, "silero_sensitivity", false);
		expect(calls).toEqual([]);
	});

	test("is a no-op when the value is null on initial connect", () => {
		const { deps, calls } = makeDeps();
		sendIfChanged(deps, null, undefined, "silero_sensitivity", true);
		expect(calls).toEqual([]);
	});
});

describe("syncAudioEntries", () => {
	test("pushes every changed audio entry under its snake-case name", () => {
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
		const params = calls.map((c) => c.args[0]);
		expect(params.toSorted()).toEqual(
			[
				"input_device_index",
				"post_speech_silence_duration",
				"silero_sensitivity",
				"wake_word_activation_delay",
			].toSorted()
		);
	});

	test("incremental mode only pushes changed entries", () => {
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
		expect(calls).toHaveLength(1);
		expect(calls[0]?.args[0]).toBe("post_speech_silence_duration");
	});
});

describe("syncAudioParams", () => {
	test("returns early when audio section is missing", () => {
		const { deps, calls } = makeDeps();
		syncAudioParams(deps, settingsWith({}), undefined);
		expect(calls).toEqual([]);
	});

	test("delegates to syncAudioEntries with isInitial=!prev", () => {
		const { deps, calls } = makeDeps();
		syncAudioParams(
			deps,
			settingsWith({
				audio: { sileroSensitivity: 0.42 } as never,
			}),
			undefined
		);
		expect(calls.some((c) => c.args[0] === "silero_sensitivity")).toBe(true);
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
});

describe("syncSystemParams", () => {
	test("returns early on initial connect (prev is undefined)", () => {
		const { deps, calls } = makeDeps();
		syncSystemParams(deps, settingsWith({ general: { autoStart: true } as never }), undefined);
		expect(calls).toEqual([]);
	});

	test("pushes autostart on a flip", () => {
		const { deps, calls } = makeDeps();
		syncSystemParams(
			deps,
			settingsWith({ general: { autoStart: true } as never }),
			settingsWith({ general: { autoStart: false } as never })
		);
		expect(calls).toEqual([{ kind: "autostartSet", args: [true] }]);
	});

	test("does not push autostart on no-op", () => {
		const { deps, calls } = makeDeps();
		syncSystemParams(
			deps,
			settingsWith({ general: { autoStart: true } as never }),
			settingsWith({ general: { autoStart: true } as never })
		);
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
		// autostart is skipped on initial connect (matches existing behavior).
		expect(kinds).not.toContain("autostartSet");
	});
});
