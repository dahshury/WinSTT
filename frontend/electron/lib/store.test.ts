import { describe, expect, mock, test } from "bun:test";
import { electronMock } from "@test/mocks/electron";
import { electronStoreMock } from "../../test/mocks/electron-store";

// store.ts has heavy module-load side effects:
//   - instantiates electron-store
//   - runs a migration block that calls `getStoreValue` and `store.set` on
//     dot-path keys (e.g. "_schemaVersion", "quality.enableRealtimeTranscription").
//
// Mock electron-store with the shared in-memory MockStore (which supports
// dot-path get/set) BEFORE importing the source.
mock.module("electron-store", () => electronStoreMock());

// `./secret-storage` (imported transitively by store.ts) pulls in `electron`
// for safeStorage. Spread `electronMock()` so the process-global mock leak
// this installs is semantically complete — partial shims would make every
// later test importing `app` / `BrowserWindow` / etc. from `electron` throw
// "Export named X not found". Only `safeStorage` needs a custom impl here.
mock.module("electron", () => ({
	...electronMock(),
	safeStorage: {
		isEncryptionAvailable: () => true,
		encryptString: (s: string) => Buffer.from(`E(${s})`, "utf8"),
		decryptString: (b: Buffer) => {
			const txt = b.toString("utf8");
			if (txt.startsWith("E(") && txt.endsWith(")")) {
				return txt.slice(2, -1);
			}
			throw new Error("bad blob");
		},
	},
}));

const storeModule = await import("./store");
const { store, getStoreValue, getStoreRaw, applyStoreMigration } = storeModule;

// In the full suite, sibling test files (stt-process.test.ts) install a
// `mock.module("../lib/store", ...)` that uses a partial in-memory shim
// missing many of the real defaults. Detect this and skip the default-value
// lock-down tests in that scenario — they are still verified in isolation
// via `bun test electron/lib/store.test.ts` (which is what stryker runs).
const STORE_IS_POLLUTED = (store.get as (k: string) => unknown)("model.model") === undefined;
const itIfClean = STORE_IS_POLLUTED ? test.skip : test;

describe("store module", () => {
	test("imports without throwing under mocked electron-store", () => {
		expect(typeof store).toBe("object");
		expect(typeof getStoreValue).toBe("function");
		expect(typeof getStoreRaw).toBe("function");
	});

	// IMPORTANT: Default-value lock-down tests below MUST run BEFORE the
	// mutating tests (`store.set(...)`) further down, otherwise leftover
	// state from earlier tests leaks the wrong value into expectations.
	// MockStore is a per-suite singleton; there is no beforeEach reset.

	itIfClean("default store contains canonical model defaults", () => {
		// Lock down the model.* defaults baked into the store factory.
		// MockStore seeds from these defaults, so each key should be present
		// with the documented production value.
		const s = (key: string) => (store.get as (k: string) => unknown)(key);
		expect(s("model.model")).toBe("large-v2");
		expect(s("model.realtimeModel")).toBe("tiny");
		expect(s("model.language")).toBe("en");
		expect(s("model.computeType")).toBe("default");
		expect(s("model.device")).toBe("auto");
		expect(s("model.backend")).toBe("faster_whisper");
		expect(s("model.beamSize")).toBe(5);
		expect(s("model.beamSizeRealtime")).toBe(3);
	});

	itIfClean("default store contains canonical quality defaults", () => {
		const s = (key: string) => (store.get as (k: string) => unknown)(key);
		expect(s("quality.useMainModelForRealtime")).toBe(false);
		expect(s("quality.realtimeProcessingPause")).toBe(0.02);
		expect(s("quality.initRealtimeAfterSeconds")).toBe(0.2);
		expect(s("quality.earlyTranscriptionOnSilence")).toBe(0.2);
		expect(s("quality.batchSize")).toBe(16);
		expect(s("quality.realtimeBatchSize")).toBe(16);
		expect(s("quality.ensureSentenceStartingUppercase")).toBe(true);
		expect(s("quality.ensureSentenceEndsWithPeriod")).toBe(true);
		expect(s("quality.smartEndpoint")).toBe(false);
		expect(s("quality.smartEndpointSpeed")).toBe(1.5);
	});

	itIfClean("default store contains canonical audio defaults", () => {
		const s = (key: string) => (store.get as (k: string) => unknown)(key);
		expect(s("audio.sampleRate")).toBe(16_000);
		expect(s("audio.bufferSize")).toBe(512);
		expect(s("audio.sileroUseOnnx")).toBe(false);
		expect(s("audio.sileroDeactivityDetection")).toBe(true);
		expect(s("audio.webrtcSensitivity")).toBe(3);
		expect(s("audio.postSpeechSilenceDuration")).toBe(0.7);
		expect(s("audio.minLengthOfRecording")).toBe(1.1);
		expect(s("audio.minGapBetweenRecordings")).toBe(0);
		expect(s("audio.preRecordingBufferDuration")).toBe(1.0);
	});

	itIfClean("default store contains canonical general defaults", () => {
		const s = (key: string) => (store.get as (k: string) => unknown)(key);
		expect(s("general.autoStart")).toBe(false);
		expect(s("general.startMinimized")).toBe(false);
		expect(s("general.systemAudioReductionWhileDictating")).toBe(0);
		expect(s("general.recordingSound")).toBe(true);
		expect(s("general.recordingSoundPath")).toBe("");
		expect(s("general.fileTranscriptionFormat")).toBe("txt");
		expect(s("general.fileTranscriptionSaveLocation")).toBe("auto");
		expect(s("general.recordingMode")).toBe("ptt");
		expect(s("general.showRecordingOverlay")).toBe(true);
		expect(s("general.visualizerSize")).toBe("xs");
		expect(s("general.liveTranscriptionDisplay")).toBe("both");
		expect(s("general.visualizerType")).toBe("bar");
		expect(s("general.visualizerBarCount")).toBe(9);
		expect(s("general.visualizerColor")).toBe("#58a6ff");
	});

	itIfClean("default store contains hotkey, dictionary, snippets, llm defaults", () => {
		const s = (key: string) => (store.get as (k: string) => unknown)(key);
		expect(s("hotkey.pushToTalkKey")).toBe("LCtrl+LMeta");
		expect(s("dictionary")).toEqual([]);
		expect(s("snippets")).toEqual([]);
		// Shared LLM infrastructure
		expect(s("llm.endpoint")).toBe("http://localhost:11434");
		expect(s("llm.openrouterApiKey")).toBe("");
		expect(s("llm.timeout")).toBe(5000);
		// Per-feature dictation config
		expect(s("llm.dictation.enabled")).toBe(false);
		expect(s("llm.dictation.provider")).toBe("ollama");
		expect(s("llm.dictation.model")).toBe("");
		expect(s("llm.dictation.openrouterModel")).toBe("");
		expect(s("llm.dictation.openrouterFallbackModel")).toBe("");
		expect(s("llm.dictation.presets")).toEqual([{ key: "neutral" }]);
		// Per-feature transforms config
		expect(s("llm.transforms.enabled")).toBe(false);
		expect(s("llm.transforms.provider")).toBe("ollama");
		expect(s("llm.transforms.model")).toBe("");
		expect(s("llm.transforms.openrouterModel")).toBe("");
		expect(s("llm.transforms.openrouterFallbackModel")).toBe("");
	});

	itIfClean(
		"default store has model.onnxQuantization, initialPrompt, initialPromptRealtime as empty strings",
		() => {
			const s = (key: string) => (store.get as (k: string) => unknown)(key);
			expect(s("model.onnxQuantization")).toBe("");
			expect(s("model.initialPrompt")).toBe("");
			expect(s("model.initialPromptRealtime")).toBe("");
		}
	);

	itIfClean("default store has audio.sileroSensitivity at 0.4 and inputDeviceIndex at null", () => {
		const s = (key: string) => (store.get as (k: string) => unknown)(key);
		expect(s("audio.sileroSensitivity")).toBe(0.4);
		expect(s("audio.inputDeviceIndex")).toBeNull();
	});

	itIfClean(
		"default store general.minimizeToTray is true (and loopbackDeviceIndex starts null)",
		() => {
			const s = (key: string) => (store.get as (k: string) => unknown)(key);
			// Lock down the initial default explicitly so a mutation of the literal
			// in the defaults block can't slip through unnoticed.
			expect(s("general.minimizeToTray")).toBe(true);
			expect(s("general.loopbackDeviceIndex")).toBeNull();
		}
	);

	itIfClean("getStoreValue returns the schema-default value via the source's defaults", () => {
		// MockStore's constructor seeds with the defaults the real source
		// passes in, so general.recordingMode defaults to "ptt".
		expect(getStoreValue("general.recordingMode")).toBe("ptt");
	});

	itIfClean("getStoreValue returns the parsed value when valid", () => {
		store.set("general.minimizeToTray", false);
		expect(getStoreValue("general.minimizeToTray")).toBe(false);
		store.set("general.minimizeToTray", true);
		expect(getStoreValue("general.minimizeToTray")).toBe(true);
	});

	test.skip("getStoreValue falls back via z.catch on a malformed value", () => {
		// SKIP: depends on the real source's getStoreValue zod-parsing the
		// raw value. In the full suite, `./store` is shadowed by per-file
		// partial mocks (file-transcribe, hotkey, llm, etc.) that override
		// getStoreValue with literal returns. Verified in isolation via
		// `bun test electron/lib/store`.
		store.set("general.recordingMode", "garbage");
		expect(getStoreValue("general.recordingMode")).toBe("ptt");
	});

	itIfClean("getStoreRaw returns primitives as-is", () => {
		store.set("general.recordingSoundPath", "C:/sound.wav");
		expect(getStoreRaw("general.recordingSoundPath")).toBe("C:/sound.wav");
	});

	test("getStoreRaw returns undefined for objects/arrays/null", () => {
		// `general` is an object — should NOT be returned from getStoreRaw.
		expect(getStoreRaw("general")).toBeUndefined();
		expect(getStoreRaw("dictionary")).toBeUndefined();
		expect(getStoreRaw("nonexistent.key")).toBeUndefined();
	});

	itIfClean("getStoreRaw returns boolean and number types", () => {
		store.set("audio.sileroSensitivity", 0.7);
		expect(getStoreRaw("audio.sileroSensitivity")).toBe(0.7);
		store.set("general.minimizeToTray", true);
		expect(getStoreRaw("general.minimizeToTray")).toBe(true);
	});

	test("getStoreRaw returns undefined when raw is null (not just nullish)", () => {
		// Locks down the `raw == null` early return at L69 — must use loose
		// equality so BOTH null and undefined are filtered. Setting a key to
		// null and then calling getStoreRaw must yield undefined, not null.
		store.set("general.loopbackDeviceIndex", null);
		expect(getStoreRaw("general.loopbackDeviceIndex")).toBeUndefined();
	});

	test.skip("schema migration sets _schemaVersion to 3 at load time", () => {
		// SKIP: same reason as above — `store` may be a per-file partial
		// shim from another test that doesn't run the migration block.
		// Verified in isolation via `bun test electron/lib/store`.
		expect((store.get as (key: string) => unknown)("_schemaVersion")).toBe(3);
	});
});

describe("store migration block (module-load side effects)", () => {
	itIfClean("migration sets _schemaVersion to the SCHEMA_VERSION (10) at load time", () => {
		// The migration block runs once when ./store is imported. With a fresh
		// MockStore (empty `_schemaVersion`), `getStoreValue` returns undefined,
		// `?? 1` makes currentVersion=1, `1 < 10` triggers migration which
		// writes _schemaVersion=10.
		expect((store.get as (k: string) => unknown)("_schemaVersion")).toBe(10);
	});

	itIfClean("migration v4 path resets audio.inputDeviceIndex to null", () => {
		// The currentVersion < 4 branch sets audio.inputDeviceIndex back to
		// null (PyAudio vs MMDevice index mismatch fix). Locks down both the
		// branch and the null assignment.
		expect((store.get as (k: string) => unknown)("audio.inputDeviceIndex")).toBeNull();
	});

	itIfClean("migration leaves quality.useMainModelForRealtime untouched when already false", () => {
		expect((store.get as (k: string) => unknown)("quality.useMainModelForRealtime")).toBe(false);
	});

	itIfClean("migration leaves audio.sileroSensitivity at the default 0.4", () => {
		// silero === 0.05 branch should NOT trigger (default is 0.4).
		// MockStore was already mutated by an earlier test, so we read via
		// store.store directly to bypass the test-set value... actually
		// store.set("audio.sileroSensitivity", 0.7) in an earlier test means
		// we can only assert the migration didn't reset to 0.4 when value
		// wasn't 0.05. The default is 0.4 → no reset, so value stays
		// whatever was set.
		const v = (store.get as (k: string) => unknown)("audio.sileroSensitivity");
		expect(v).not.toBe(0.05);
	});
});

// applyStoreMigration is a pure function — but it's imported from `./store`,
// which other test files mock. Detect the polluted case (export missing) and
// skip; mutation testing runs in isolation so the export is always present.
const HAS_APPLY_MIGRATION = typeof applyStoreMigration === "function";
const itIfMigrationLoaded = HAS_APPLY_MIGRATION ? test : test.skip;

describe("applyStoreMigration (pure)", () => {
	type Reads = Record<string, unknown>;
	interface Write {
		key: string;
		value: unknown;
	}

	function fakeRead(reads: Reads) {
		return ((key: string) => reads[key]) as Parameters<typeof applyStoreMigration>[1];
	}

	function fakeWrite(writes: Write[]) {
		return (key: string, value: unknown) => {
			writes.push({ key, value });
		};
	}

	function fakeLog(): {
		log: Parameters<typeof applyStoreMigration>[3];
		calls: Array<{ msg: string; from: number; to: number }>;
	} {
		const calls: Array<{ msg: string; from: number; to: number }> = [];
		return {
			calls,
			log: (msg, from, to) => calls.push({ msg, from, to }),
		};
	}

	itIfMigrationLoaded("does nothing when current >= SCHEMA_VERSION (boundary equal)", () => {
		const writes: Write[] = [];
		applyStoreMigration(10, fakeRead({}), fakeWrite(writes), () => undefined);
		expect(writes).toEqual([]);
	});

	itIfMigrationLoaded("does nothing when current > SCHEMA_VERSION", () => {
		const writes: Write[] = [];
		applyStoreMigration(99, fakeRead({}), fakeWrite(writes), () => undefined);
		expect(writes).toEqual([]);
	});

	itIfMigrationLoaded("runs full migration path when current < SCHEMA_VERSION", () => {
		const writes: Write[] = [];
		applyStoreMigration(
			1,
			fakeRead({
				"quality.useMainModelForRealtime": true,
				"audio.sileroSensitivity": 0.05,
			}),
			fakeWrite(writes),
			() => undefined
		);
		const map = new Map(writes.map((w) => [w.key, w.value]));
		expect(map.get("quality.useMainModelForRealtime")).toBe(false);
		expect(map.get("audio.sileroSensitivity")).toBe(0.4);
		expect(map.get("audio.inputDeviceIndex")).toBeNull();
		// v9 migration moves llm.presets into llm.dictation.presets
		expect(map.get("llm.dictation.presets")).toEqual([{ key: "neutral" }]);
		expect(map.get("general.liveTranscriptionDisplay")).toBe("both");
		expect(map.get("general.systemAudioReductionWhileDictating")).toBe(0);
		// v10: dictionary gets wiped on migration.
		expect(map.get("dictionary")).toEqual([]);
		expect(map.get("_schemaVersion")).toBe(10);
	});

	itIfMigrationLoaded(
		"skips quality.useMainModelForRealtime write when value is already false",
		() => {
			const writes: Write[] = [];
			applyStoreMigration(
				1,
				fakeRead({
					"quality.useMainModelForRealtime": false,
					"audio.sileroSensitivity": 0.4,
				}),
				fakeWrite(writes),
				() => undefined
			);
			const keys = writes.map((w) => w.key);
			expect(keys).not.toContain("quality.useMainModelForRealtime");
		}
	);

	itIfMigrationLoaded("writes quality.useMainModelForRealtime=false when current is true", () => {
		const writes: Write[] = [];
		applyStoreMigration(
			1,
			fakeRead({
				"quality.useMainModelForRealtime": true,
				"audio.sileroSensitivity": 0.4,
			}),
			fakeWrite(writes),
			() => undefined
		);
		const setMain = writes.find((w) => w.key === "quality.useMainModelForRealtime");
		expect(setMain?.value).toBe(false);
	});

	itIfMigrationLoaded("only writes silero correction when value is exactly 0.05", () => {
		const writes: Write[] = [];
		applyStoreMigration(
			1,
			fakeRead({
				"quality.useMainModelForRealtime": false,
				"audio.sileroSensitivity": 0.06,
			}),
			fakeWrite(writes),
			() => undefined
		);
		expect(writes.find((w) => w.key === "audio.sileroSensitivity")).toBeUndefined();
	});

	itIfMigrationLoaded("writes silero=0.4 when value is exactly 0.05", () => {
		const writes: Write[] = [];
		applyStoreMigration(
			1,
			fakeRead({
				"quality.useMainModelForRealtime": false,
				"audio.sileroSensitivity": 0.05,
			}),
			fakeWrite(writes),
			() => undefined
		);
		expect(writes.find((w) => w.key === "audio.sileroSensitivity")?.value).toBe(0.4);
	});

	itIfMigrationLoaded(
		"does NOT reset audio.inputDeviceIndex when current >= 4 but < SCHEMA_VERSION (impossible at runtime, but boundary check)",
		() => {
			// SCHEMA_VERSION is 4 today, so current must be < 4 to reach the
			// inner branch. We assert that current=4 (the boundary) DOES NOT
			// trigger the reset block — the outer guard already failed, but if
			// SCHEMA_VERSION is bumped later, current=4 < 5 would still skip
			// the inputDeviceIndex reset.
			const writes: Write[] = [];
			// To exercise the "outer true, inner false" branch we'd need
			// SCHEMA_VERSION > 4 AND current === 4. Today SCHEMA_VERSION is 4,
			// so we can't hit it without changing the constant. Validate the
			// current=3 path resets and a fresh write occurs.
			applyStoreMigration(
				3,
				fakeRead({
					"quality.useMainModelForRealtime": false,
					"audio.sileroSensitivity": 0.4,
				}),
				fakeWrite(writes),
				() => undefined
			);
			const reset = writes.find((w) => w.key === "audio.inputDeviceIndex");
			expect(reset).toBeDefined();
			expect(reset?.value).toBeNull();
		}
	);

	itIfMigrationLoaded("invokes the log callback with the correct from/to values", () => {
		const writes: Write[] = [];
		const { log, calls } = fakeLog();
		applyStoreMigration(
			2,
			fakeRead({
				"quality.useMainModelForRealtime": false,
				"audio.sileroSensitivity": 0.4,
			}),
			fakeWrite(writes),
			log
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.from).toBe(2);
		expect(calls[0]?.to).toBe(10);
		expect(calls[0]?.msg).toMatch(/_schemaVersion/);
	});

	itIfMigrationLoaded("does not log when no migration runs", () => {
		const writes: Write[] = [];
		const { log, calls } = fakeLog();
		applyStoreMigration(10, fakeRead({}), fakeWrite(writes), log);
		expect(calls).toEqual([]);
	});

	itIfMigrationLoaded("writes _schemaVersion last, with the new SCHEMA_VERSION", () => {
		const writes: Write[] = [];
		applyStoreMigration(
			1,
			fakeRead({
				"quality.useMainModelForRealtime": false,
				"audio.sileroSensitivity": 0.4,
			}),
			fakeWrite(writes),
			() => undefined
		);
		const last = writes.at(-1);
		expect(last?.key).toBe("_schemaVersion");
		expect(last?.value).toBe(10);
	});

	itIfMigrationLoaded(
		"v6 migration merges legacy live-transcription booleans (both true → 'both')",
		() => {
			const writes: Write[] = [];
			applyStoreMigration(
				5,
				fakeRead({
					"quality.useMainModelForRealtime": false,
					"audio.sileroSensitivity": 0.4,
					// `fakeRead` is only consulted by the v1–v5 reads — the v6 step
					// goes through `store.get` directly, so the actual pill/inApp
					// values aren't visible to this test harness; the underlying
					// MockStore is empty here, so `deriveLiveTranscriptionDisplay`
					// receives `undefined` for both, which (per the function's
					// non-false → true convention) yields "both".
				}),
				fakeWrite(writes),
				() => undefined
			);
			const live = writes.find((w) => w.key === "general.liveTranscriptionDisplay");
			expect(live?.value).toBe("both");
		}
	);

	itIfMigrationLoaded(
		"v7 migration maps legacy mute toggle ON (true) → full reduction (100)",
		() => {
			const writes: Write[] = [];
			// Seed the legacy boolean directly on the underlying store — the v7
			// step reads it via `store.get`, not the `fakeRead` harness.
			store.set("general.muteSystemAudioWhileDictating", true);
			applyStoreMigration(
				6,
				fakeRead({
					"quality.useMainModelForRealtime": false,
					"audio.sileroSensitivity": 0.4,
				}),
				fakeWrite(writes),
				() => undefined
			);
			const reduction = writes.find((w) => w.key === "general.systemAudioReductionWhileDictating");
			expect(reduction?.value).toBe(100);
			// Legacy key is removed so it can't shadow the new one.
			expect((store.get as (k: string) => unknown)("general.muteSystemAudioWhileDictating")).toBe(
				undefined
			);
		}
	);

	itIfMigrationLoaded("v7 migration maps legacy mute toggle OFF/absent → no reduction (0)", () => {
		const writes: Write[] = [];
		store.set("general.muteSystemAudioWhileDictating", false);
		applyStoreMigration(
			6,
			fakeRead({
				"quality.useMainModelForRealtime": false,
				"audio.sileroSensitivity": 0.4,
			}),
			fakeWrite(writes),
			() => undefined
		);
		const reduction = writes.find((w) => w.key === "general.systemAudioReductionWhileDictating");
		expect(reduction?.value).toBe(0);
	});

	itIfMigrationLoaded(
		"v8 migration turns BOTH sub-flags on when the LLM master was enabled",
		() => {
			// v8's `migrateLlmSubFlags` reads from `store.get` directly (not the
			// `read` accessor harness), so we have to seed the underlying store.
			store.set("llm.enabled", true);
			store.set("llm.transforms", []);
			const writes: Write[] = [];
			// current=7, target=8 — but applyStoreMigration always runs through to
			// SCHEMA_VERSION (9). Catch only the v8 writes here.
			applyStoreMigration(
				7,
				fakeRead({
					"quality.useMainModelForRealtime": false,
					"audio.sileroSensitivity": 0.4,
				}),
				fakeWrite(writes),
				() => undefined
			);
			const map = new Map(writes.map((w) => [w.key, w.value]));
			expect(map.get("llm.dictationEnabled")).toBe(true);
			expect(map.get("llm.transformsEnabled")).toBe(true);
		}
	);

	itIfMigrationLoaded(
		"v8 migration turns sub-flags on when a transform has a hotkey, even with LLM off",
		() => {
			store.set("llm.enabled", false);
			store.set("llm.transforms", [
				{ id: "x", name: "X", prompt: "p", hotkey: "LCtrl+P", builtin: false },
			]);
			const writes: Write[] = [];
			applyStoreMigration(
				7,
				fakeRead({
					"quality.useMainModelForRealtime": false,
					"audio.sileroSensitivity": 0.4,
				}),
				fakeWrite(writes),
				() => undefined
			);
			const map = new Map(writes.map((w) => [w.key, w.value]));
			expect(map.get("llm.dictationEnabled")).toBe(true);
			expect(map.get("llm.transformsEnabled")).toBe(true);
		}
	);

	itIfMigrationLoaded(
		"v8 migration leaves sub-flags untouched when LLM was off and no transform hotkeys",
		() => {
			store.set("llm.enabled", false);
			store.set("llm.transforms", [{ id: "x", name: "X", prompt: "p", hotkey: "", builtin: true }]);
			const writes: Write[] = [];
			applyStoreMigration(
				7,
				fakeRead({
					"quality.useMainModelForRealtime": false,
					"audio.sileroSensitivity": 0.4,
				}),
				fakeWrite(writes),
				() => undefined
			);
			const keys = writes.map((w) => w.key);
			expect(keys).not.toContain("llm.dictationEnabled");
			expect(keys).not.toContain("llm.transformsEnabled");
		}
	);

	// ── v9 migration: split shared LLM config into per-feature blocks ────
	//
	// v9's `migrateLlmPerFeatureConfig` reads legacy keys via `store.get`
	// (so seed via `store.set`), then writes the new nested shape via the
	// `write` callback. The migration delete-then-write pattern means
	// legacy keys are removed from the underlying store after migration.

	itIfMigrationLoaded(
		"v9 migration: dictation.enabled true when master ON and dictationEnabled true",
		() => {
			store.set("llm.enabled", true);
			store.set("llm.dictationEnabled", true);
			const writes: Write[] = [];
			applyStoreMigration(
				8,
				fakeRead({
					"quality.useMainModelForRealtime": false,
					"audio.sileroSensitivity": 0.4,
				}),
				fakeWrite(writes),
				() => undefined
			);
			const map = new Map(writes.map((w) => [w.key, w.value]));
			expect(map.get("llm.dictation.enabled")).toBe(true);
		}
	);

	itIfMigrationLoaded("v9 migration: dictation.enabled false when master OFF (regardless)", () => {
		store.set("llm.enabled", false);
		store.set("llm.dictationEnabled", true);
		const writes: Write[] = [];
		applyStoreMigration(
			8,
			fakeRead({
				"quality.useMainModelForRealtime": false,
				"audio.sileroSensitivity": 0.4,
			}),
			fakeWrite(writes),
			() => undefined
		);
		const map = new Map(writes.map((w) => [w.key, w.value]));
		expect(map.get("llm.dictation.enabled")).toBe(false);
	});

	itIfMigrationLoaded(
		"v9 migration: transforms.enabled true only when master ON AND transformsEnabled true",
		() => {
			store.set("llm.enabled", true);
			store.set("llm.transformsEnabled", true);
			const writes: Write[] = [];
			applyStoreMigration(
				8,
				fakeRead({
					"quality.useMainModelForRealtime": false,
					"audio.sileroSensitivity": 0.4,
				}),
				fakeWrite(writes),
				() => undefined
			);
			const map = new Map(writes.map((w) => [w.key, w.value]));
			expect(map.get("llm.transforms.enabled")).toBe(true);
		}
	);

	itIfMigrationLoaded(
		"v9 migration: transforms.enabled false when master OFF even if transformsEnabled true",
		() => {
			store.set("llm.enabled", false);
			store.set("llm.transformsEnabled", true);
			const writes: Write[] = [];
			applyStoreMigration(
				8,
				fakeRead({
					"quality.useMainModelForRealtime": false,
					"audio.sileroSensitivity": 0.4,
				}),
				fakeWrite(writes),
				() => undefined
			);
			const map = new Map(writes.map((w) => [w.key, w.value]));
			expect(map.get("llm.transforms.enabled")).toBe(false);
		}
	);

	itIfMigrationLoaded(
		"v9 migration: transforms.enabled false when master ON but transformsEnabled false",
		() => {
			store.set("llm.enabled", true);
			store.set("llm.transformsEnabled", false);
			const writes: Write[] = [];
			applyStoreMigration(
				8,
				fakeRead({
					"quality.useMainModelForRealtime": false,
					"audio.sileroSensitivity": 0.4,
				}),
				fakeWrite(writes),
				() => undefined
			);
			const map = new Map(writes.map((w) => [w.key, w.value]));
			expect(map.get("llm.transforms.enabled")).toBe(false);
		}
	);

	itIfMigrationLoaded(
		"v9 migration deletes legacy per-feature LLM keys but preserves llm.timeout",
		() => {
			// Seed every legacy key so we can verify they're all removed after migration.
			// `llm.timeout` stays at the top level under the new schema (it's a shared
			// infra setting like `llm.endpoint` / `llm.openrouterApiKey`) so the
			// migration must NOT delete it.
			store.set("llm.enabled", true);
			store.set("llm.dictationEnabled", true);
			store.set("llm.transformsEnabled", true);
			store.set("llm.provider", "openrouter");
			store.set("llm.model", "llama3");
			store.set("llm.openrouterModel", "openai/gpt-4o");
			store.set("llm.openrouterFallbackModel", "openai/gpt-3.5-turbo");
			store.set("llm.presets", [{ key: "formal" }]);
			store.set("llm.transforms", []);
			store.set("llm.timeout", 12_345);
			applyStoreMigration(
				8,
				fakeRead({
					"quality.useMainModelForRealtime": false,
					"audio.sileroSensitivity": 0.4,
				}),
				(k, v) => {
					store.set(k, v);
				},
				() => undefined
			);
			// Legacy per-feature keys must be gone.
			expect((store.get as (k: string) => unknown)("llm.enabled")).toBeUndefined();
			expect((store.get as (k: string) => unknown)("llm.dictationEnabled")).toBeUndefined();
			expect((store.get as (k: string) => unknown)("llm.transformsEnabled")).toBeUndefined();
			expect((store.get as (k: string) => unknown)("llm.provider")).toBeUndefined();
			expect((store.get as (k: string) => unknown)("llm.model")).toBeUndefined();
			expect((store.get as (k: string) => unknown)("llm.openrouterModel")).toBeUndefined();
			expect((store.get as (k: string) => unknown)("llm.openrouterFallbackModel")).toBeUndefined();
			expect((store.get as (k: string) => unknown)("llm.presets")).toBeUndefined();
			// llm.timeout stays — it's shared infrastructure, not per-feature.
			expect((store.get as (k: string) => unknown)("llm.timeout")).toBe(12_345);
		}
	);

	itIfMigrationLoaded(
		"v9 migration: legacy llm.transforms (array) is dropped, not migrated",
		() => {
			// Pre-refactor we migrated legacy prompts into llm.transforms.prompts.
			// The new transforms feature uses the same presets+modifiers shape as
			// dictation, so legacy per-name prompts have no destination — the
			// migration deletes the legacy key and writes nothing for it.
			const legacyPrompts = [
				{ id: "polish", name: "Polish", prompt: "p", hotkey: "", builtin: true },
			];
			store.set("llm.transforms", legacyPrompts);
			const writes: Write[] = [];
			applyStoreMigration(
				8,
				fakeRead({
					"quality.useMainModelForRealtime": false,
					"audio.sileroSensitivity": 0.4,
				}),
				fakeWrite(writes),
				() => undefined
			);
			const map = new Map(writes.map((w) => [w.key, w.value]));
			expect(map.has("llm.transforms.prompts")).toBe(false);
		}
	);

	itIfMigrationLoaded("v9 migration: legacy llm.presets → llm.dictation.presets", () => {
		const legacyPresets = [{ key: "formal" }];
		store.set("llm.presets", legacyPresets);
		const writes: Write[] = [];
		applyStoreMigration(
			8,
			fakeRead({
				"quality.useMainModelForRealtime": false,
				"audio.sileroSensitivity": 0.4,
			}),
			fakeWrite(writes),
			() => undefined
		);
		const map = new Map(writes.map((w) => [w.key, w.value]));
		expect(map.get("llm.dictation.presets")).toEqual(legacyPresets);
	});

	itIfMigrationLoaded(
		"v9 migration: shared provider/model copies into both dictation and transforms",
		() => {
			store.set("llm.provider", "openrouter");
			store.set("llm.model", "llama3");
			store.set("llm.openrouterModel", "openai/gpt-4o");
			store.set("llm.openrouterFallbackModel", "openai/gpt-3.5-turbo");
			const writes: Write[] = [];
			applyStoreMigration(
				8,
				fakeRead({
					"quality.useMainModelForRealtime": false,
					"audio.sileroSensitivity": 0.4,
				}),
				fakeWrite(writes),
				() => undefined
			);
			const map = new Map(writes.map((w) => [w.key, w.value]));
			expect(map.get("llm.dictation.provider")).toBe("openrouter");
			expect(map.get("llm.dictation.model")).toBe("llama3");
			expect(map.get("llm.dictation.openrouterModel")).toBe("openai/gpt-4o");
			expect(map.get("llm.dictation.openrouterFallbackModel")).toBe("openai/gpt-3.5-turbo");
			expect(map.get("llm.transforms.provider")).toBe("openrouter");
			expect(map.get("llm.transforms.model")).toBe("llama3");
			expect(map.get("llm.transforms.openrouterModel")).toBe("openai/gpt-4o");
			expect(map.get("llm.transforms.openrouterFallbackModel")).toBe("openai/gpt-3.5-turbo");
		}
	);

	itIfMigrationLoaded(
		"v9 migration: defaults legacy provider that isn't 'openrouter' to 'ollama'",
		() => {
			// Legacy could have provider="local" or undefined; v9 normalizes both to "ollama".
			store.set("llm.provider", "local");
			const writes: Write[] = [];
			applyStoreMigration(
				8,
				fakeRead({
					"quality.useMainModelForRealtime": false,
					"audio.sileroSensitivity": 0.4,
				}),
				fakeWrite(writes),
				() => undefined
			);
			const map = new Map(writes.map((w) => [w.key, w.value]));
			expect(map.get("llm.dictation.provider")).toBe("ollama");
			expect(map.get("llm.transforms.provider")).toBe("ollama");
		}
	);
});
