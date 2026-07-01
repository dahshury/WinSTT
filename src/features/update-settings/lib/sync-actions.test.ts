import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AllowedParameter } from "@/shared/api/models";
import type { AppSettingsOutput as AppSettings } from "@/shared/config/settings-schema";
import {
	diarizationNeedsPush,
	readDiarizationEnabled,
	type SyncDeps,
	sendIfChanged,
	shouldSendParam,
	syncDiarizationParams,
	syncModelParams,
	syncQualityParams,
	syncToServer,
} from "./sync-actions";

function makeDeps() {
	const calls: Array<{ kind: string; args: unknown[] }> = [];
	const deps: SyncDeps = {
		sttRequestDiarizationToggle: mock((enabled: boolean) =>
			calls.push({ kind: "sttRequestDiarizationToggle", args: [enabled] }),
		),
		sttSetParameter: mock(<V>(param: AllowedParameter, value: V) =>
			calls.push({ kind: "sttSetParameter", args: [param, value] }),
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
		sendIfChanged(deps, false, true, "silence_timing", false);
		expect(calls).toEqual([
			{ kind: "sttSetParameter", args: ["silence_timing", false] },
		]);
	});

	test("is a no-op when the value is unchanged (incremental)", () => {
		const { deps, calls } = makeDeps();
		sendIfChanged(deps, false, false, "silence_timing", false);
		expect(calls).toEqual([]);
	});

	test("is a no-op when the value is null on initial connect", () => {
		const { deps, calls } = makeDeps();
		sendIfChanged(deps, null, undefined, "silence_timing", true);
		expect(calls).toEqual([]);
	});
});

describe("syncModelParams", () => {
	test("pushes language on initial connect", () => {
		const { deps, calls } = makeDeps();
		syncModelParams(
			deps,
			settingsWith({ model: { language: "en" } as never }),
			undefined,
		);
		expect(calls).toEqual([
			{ kind: "sttSetParameter", args: ["language", "en"] },
		]);
	});

	test("does not push the `model` field (canonical swap path elsewhere)", () => {
		const { deps, calls } = makeDeps();
		syncModelParams(
			deps,
			settingsWith({ model: { model: "tiny", language: "en" } as never }),
			settingsWith({ model: { model: "tiny", language: "en" } as never }),
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
			undefined,
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
			undefined,
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
			settingsWith({
				general: { recordingMode: "toggle", manualToggleStop: false } as never,
			}),
			undefined,
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
			settingsWith({ general: { recordingMode: "toggle" } as never }),
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
		expect(
			calls.find((c) => c.args[0] === "silence_endpoint_enabled"),
		).toBeUndefined();
	});
});

describe("readDiarizationEnabled", () => {
	test("returns the speakerDiarization flag when set", () => {
		expect(
			readDiarizationEnabled(
				settingsWith({ general: { speakerDiarization: true } as never }),
			),
		).toBe(true);
		expect(
			readDiarizationEnabled(
				settingsWith({ general: { speakerDiarization: false } as never }),
			),
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
			diarizationNeedsPush(
				true,
				settingsWith({ general: { speakerDiarization: false } as never }),
			),
		).toBe(true);
	});

	test("false when state matches", () => {
		expect(
			diarizationNeedsPush(
				true,
				settingsWith({ general: { speakerDiarization: true } as never }),
			),
		).toBe(false);
	});
});

describe("syncDiarizationParams", () => {
	test("pushes the toggle on initial connect", () => {
		const { deps, calls } = makeDeps();
		syncDiarizationParams(
			deps,
			settingsWith({ general: { speakerDiarization: true } as never }),
			undefined,
		);
		expect(calls).toEqual([
			{ kind: "sttRequestDiarizationToggle", args: [true] },
		]);
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
			settingsWith({ general: { speakerDiarization: true } as never }),
		);
		expect(calls).toEqual([
			{ kind: "sttRequestDiarizationToggle", args: [false] },
		]);
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
				}),
			),
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
			}),
		);
		const kinds = calls.map((c) => c.kind);
		expect(kinds).toContain("sttSetParameter");
		expect(kinds).toContain("sttRequestDiarizationToggle");
	});
});

// `global.modelUnloadTimeout` is no longer pushed via `set_parameter` — it is
// persisted canonically via `winstt_set_settings`, whose on-save handler mirrors it
// into the AppSettings shadow and warms/reloads the model (single writer). The old
// `resolveModelUnloadTimeoutSeconds` / `modelUnloadTimeoutNeedsPush` push helpers and
// their tests were removed with that second write path.
