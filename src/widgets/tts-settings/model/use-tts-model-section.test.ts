import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import type { ReferenceBuild } from "@/bindings";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import {
	useTtsCatalogStore,
	useTtsModelStateStore,
} from "@/entities/tts-catalog";
import { useVoiceLibraryStore } from "./voice-library";
import { useTtsModelSection } from "./use-tts-model-section";

/**
 * `useTtsModelSection` is the clip lifecycle: adopt → build → transcribe →
 * rebuild → discard. It is driven ENTIRELY through the generated command
 * bindings, so the seam these tests hold is `window.__TAURI_INTERNALS__.invoke`
 * rather than a `mock.module` of `@/bindings`.
 *
 * That choice is deliberate. `mock.module` installs a PROCESS-GLOBAL module
 * replacement bun never tears down, and a sibling suite in this same directory
 * (`use-tts-voice-catalog.test.tsx`) already owns that slot for `@/bindings`.
 * The Tauri internals, by contrast, are re-installed from defaults after every
 * test by `test/preload.ts`, so instrumenting them leaks nothing.
 */

type InvokeHandler = (args: Record<string, unknown>) => unknown;

interface TauriWindow extends Window {
	__TAURI_INTERNALS__: {
		invoke: (cmd: string, args?: unknown) => Promise<unknown>;
		transformCallback: (cb?: (payload: unknown) => void) => number;
	};
}

const CLONE_MODEL = "spark-tts-0.5b";
const COMBINED_A = "C:/appdata/tts/reference-voices/voice-a1b2.wav";
const COMBINED_B = "C:/appdata/tts/reference-voices/voice-c3d4.wav";
const SOURCE_1 = "C:/appdata/tts/reference-voices/part-1-11aa.wav";
const SOURCE_2 = "C:/appdata/tts/reference-voices/part-2-22bb.wav";
/** The model's catalog cap. Distinct from every `maxSecs` a build reports, so a
 *  test can tell "read from the catalog" apart from "read from the report". */
const CATALOG_MAX_SECS = 30;

/** Every invoke the hook made, in order — the assertion surface for "the build
 *  command was called with the right ordered paths". */
let invokes: Array<{ args: Record<string, unknown>; cmd: string }> = [];
let handlers: Record<string, InvokeHandler> = {};

function tauriWindow(): TauriWindow {
	return window as unknown as TauriWindow;
}

/** Register the response for one command. A handler may return a value, a
 *  promise, or throw — the three shapes the generated bindings distinguish. */
function onInvoke(cmd: string, handler: InvokeHandler): void {
	handlers[cmd] = handler;
}

function invokedWith(cmd: string): Record<string, unknown>[] {
	return invokes
		.filter((entry) => entry.cmd === cmd)
		.map((entry) => entry.args);
}

/** A backend `Result::Err`: the generated binding turns a rejection with a
 *  NON-Error value into `{ status: "error", error }`. Rejecting with a real
 *  `Error` is the other path — the invoke itself blew up — and is re-thrown. */
function commandError(message: string): never {
	throw message;
}

function build(overrides: Partial<ReferenceBuild> = {}): ReferenceBuild {
	return {
		maxSecs: 12,
		parts: [
			{ name: "part-1.wav", seconds: 4, storedPath: SOURCE_1 },
			{ name: "part-2.wav", seconds: 3, storedPath: SOURCE_2 },
		],
		seconds: 7,
		storedPath: COMBINED_A,
		trimmed: false,
		...overrides,
	};
}

/** Catalog row for a clip+transcript cloner (Spark) that cannot speak without a
 *  reference — the shape that exercises every branch under test. */
function seedCatalog(): void {
	useTtsCatalogStore.getState().setModels([
		{
			available: true,
			available_quantizations: ["fp32"],
			cloning: "zero_shot_audio_transcript",
			description: "",
			display_name: "Spark",
			engine: "spark",
			id: CLONE_MODEL,
			languages: ["en"],
			max_ref_clip_secs: CATALOG_MAX_SECS,
			num_voices: 2,
			requires_reference_clip: true,
		},
	]);
	useTtsModelStateStore.setState({
		isLoaded: true,
		statesById: {
			[CLONE_MODEL]: {
				cacheByQuantization: {
					fp32: {
						downloadedBytes: 1,
						progress: 1,
						state: "cached",
						totalBytes: 1,
					},
				},
				effectiveQuantization: "fp32",
				estimatedBytes: 1,
				id: CLONE_MODEL,
			},
		},
	});
}

function seedSettings(tts: Record<string, unknown> = {}): void {
	useSettingsStore.setState({
		isLoaded: true,
		settings: {
			...DEFAULT_SETTINGS,
			tts: {
				...DEFAULT_SETTINGS.tts,
				cloneRefText: "",
				enabled: true,
				model: CLONE_MODEL,
				voice: "",
				...tts,
			},
		},
	});
}

function liveTts(): { cloneRefText: string; voice: string } {
	const tts = useSettingsStore.getState().settings.tts;
	return { cloneRefText: tts.cloneRefText, voice: tts.voice };
}

/**
 * Let every queued microtask AND macrotask settle — the file-dialog path
 * `await import()`s the Tauri plugin, which no number of microtask ticks can
 * drain.
 *
 * The turns are a LOOP rather than a single macrotask because the paths differ
 * in depth: a browse runs `import → dialog → build → transcribe`, several hops
 * more than a direct adopt, and each hop that lands behind the module load
 * needs its own turn. A one-macrotask budget was therefore enough for the
 * shallow paths and raced on the browse ones, which flaked only when the whole
 * directory ran together and the event loop was busy.
 */
async function flush(): Promise<void> {
	await act(async () => {
		for (let turn = 0; turn < 8; turn++) {
			await Promise.resolve();
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});
}

async function renderSection() {
	const view = renderHook(() => useTtsModelSection(), {
		wrapper: IntlProvider,
	});
	// The voice-catalog fetch resolves on mount, and because the seeded `voice`
	// is empty (not yet a clip PATH) its stale-voice self-heal legitimately fires
	// and lands the engine's first preset — `"female"` — in `tts.voice`. Settling
	// it here keeps that write out of the middle of the behaviour under test, and
	// is why the discard tests expect `"female"` rather than `""`.
	await flush();
	return view;
}

beforeEach(() => {
	invokes = [];
	handlers = {};
	tauriWindow().__TAURI_INTERNALS__.invoke = (cmd, args) => {
		const payload = (args ?? {}) as Record<string, unknown>;
		invokes.push({ args: payload, cmd });
		const handler = handlers[cmd];
		return Promise.resolve(handler ? handler(payload) : undefined);
	};
	// The engine's own preset voices, so "clearing the live voice falls back to
	// the first preset" has something to fall back TO.
	onInvoke("tts_list_voices", () => ({
		languages: [{ code: "en", label: "EN" }],
		voices: [
			{ gender: "female", id: "female", label: "Female", language: "en" },
		],
	}));
	useVoiceLibraryStore.setState({
		activeVoiceId: null,
		persistFailed: null,
		voices: [],
	});
	useTtsCatalogStore.setState({ isLoaded: false, models: [] });
	useTtsModelStateStore.setState({ isLoaded: false, statesById: {} });
	seedCatalog();
	seedSettings();
});

afterEach(() => {
	cleanup();
	useSettingsStore.setState({ isLoaded: false, settings: DEFAULT_SETTINGS });
});

describe("useTtsModelSection — adopting clips", () => {
	test("builds from the ordered paths and stores the COMBINED path, never a source", async () => {
		onInvoke("tts_build_reference", () => build());
		onInvoke("tts_transcribe_reference", () => "Spoken reference.");
		const { result } = await renderSection();

		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1, SOURCE_2]);
			await flush();
		});

		expect(invokedWith("tts_build_reference")).toEqual([
			{ paths: [SOURCE_1, SOURCE_2] },
		]);
		// The seam: a single string holding the welded file, not either source.
		expect(liveTts().voice).toBe(COMBINED_A);
		expect(liveTts().voice).not.toBe(SOURCE_1);
		expect(result.current.referenceClip.path).toBe(COMBINED_A);
		expect(result.current.referenceClip.seconds).toBe(7);
		expect(result.current.cloneError).toBeNull();
	});

	test("adopts the report's parts and its cap for THIS clip", async () => {
		onInvoke("tts_build_reference", () =>
			build({ maxSecs: 12, trimmed: true }),
		);
		onInvoke("tts_transcribe_reference", () => "Spoken reference.");
		const { result } = await renderSection();

		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1, SOURCE_2]);
			await flush();
		});

		expect(result.current.liveSavedVoice.clips).toEqual([
			{ name: "part-1.wav", path: SOURCE_1, seconds: 4 },
			{ name: "part-2.wav", path: SOURCE_2, seconds: 3 },
		]);
		// The cap the backend ACTUALLY applied wins over the catalog row, so the
		// trim notice quotes the number that did the cutting.
		expect(result.current.maxRefClipSecs).toBe(12);
		expect(result.current.referenceClip.trimmed).toBe(true);
	});

	test("refuses more parts than a voice can hold WITHOUT calling the backend", async () => {
		onInvoke("tts_build_reference", () => build());
		const { result } = await renderSection();
		const before = liveTts().voice;
		const tooMany = Array.from(
			{ length: 13 },
			(_unused, index) => `C:/audio/clip-${index}.wav`,
		);

		await act(async () => {
			result.current.handleSetReferenceClips(tooMany);
			await flush();
		});

		expect(invokedWith("tts_build_reference")).toEqual([]);
		expect(result.current.cloneError).toBe(
			"A voice can hold at most 12 clips.",
		);
		expect(liveTts().voice).toBe(before);
	});

	test("browsing APPENDS to what the voice already holds", async () => {
		onInvoke("tts_build_reference", () => build());
		onInvoke("tts_transcribe_reference", () => "Spoken reference.");
		onInvoke("plugin:dialog|open", () => [SOURCE_2]);
		const { result } = await renderSection();

		await act(async () => {
			result.current.handleBrowseReferenceClips([SOURCE_1]);
			await flush();
		});

		expect(invokedWith("tts_build_reference")).toEqual([
			{ paths: [SOURCE_1, SOURCE_2] },
		]);
	});

	test("a cancelled browse builds nothing", async () => {
		onInvoke("tts_build_reference", () => build());
		onInvoke("plugin:dialog|open", () => null);
		const { result } = await renderSection();

		await act(async () => {
			result.current.handleBrowseReferenceClips([SOURCE_1]);
			await flush();
		});

		// The dialog really opened — without this the assertion below would pass
		// just as happily if the picker had never been reached at all.
		expect(invokedWith("plugin:dialog|open")).toEqual([
			{
				options: {
					filters: [
						{
							extensions: ["wav", "mp3", "flac", "m4a", "mp4", "ogg", "aac"],
							name: "Audio",
						},
					],
					multiple: true,
				},
			},
		]);
		expect(invokedWith("tts_build_reference")).toEqual([]);
	});
});

describe("useTtsModelSection — auto-transcribe effect", () => {
	test("transcribes the COMBINED clip once, and does not retry after a failure", async () => {
		onInvoke("tts_build_reference", () => build());
		onInvoke("tts_transcribe_reference", () =>
			commandError("The STT model is unavailable."),
		);
		const { result, rerender } = await renderSection();

		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1, SOURCE_2]);
			await flush();
		});

		// The STORED clip is transcribed — the text must describe the audio the
		// engine will actually hear.
		expect(invokedWith("tts_transcribe_reference")).toEqual([
			{ path: COMBINED_A },
		]);
		expect(result.current.cloneError).toBe("The STT model is unavailable.");
		// The transcript is still empty, so only the one-attempt-per-clip ref keeps
		// this from becoming a retry loop.
		expect(liveTts().cloneRefText).toBe("");

		rerender();
		await flush();
		expect(invokedWith("tts_transcribe_reference")).toHaveLength(1);
	});

	test("fills the transcript from the result and stops asking", async () => {
		onInvoke("tts_build_reference", () => build());
		onInvoke("tts_transcribe_reference", () => "  Spoken reference.  ");
		const { result } = await renderSection();

		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1]);
			await flush();
		});

		expect(liveTts().cloneRefText).toBe("Spoken reference.");
		expect(invokedWith("tts_transcribe_reference")).toHaveLength(1);
		expect(result.current.cloneBusy).toBe(false);
	});

	test("re-arms for the NEW combined path after a rebuild", async () => {
		let nextBuild = build();
		onInvoke("tts_build_reference", () => nextBuild);
		onInvoke("tts_transcribe_reference", () => "First transcript.");
		const { result } = await renderSection();

		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1, SOURCE_2]);
			await flush();
		});
		expect(liveTts().cloneRefText).toBe("First transcript.");

		// Removing a clip re-states the survivors; the weld produces a DIFFERENT
		// combined file, so the previous transcript no longer describes it.
		nextBuild = build({
			parts: [{ name: "part-1.wav", seconds: 4, storedPath: SOURCE_1 }],
			seconds: 4,
			storedPath: COMBINED_B,
		});
		onInvoke("tts_transcribe_reference", () => "Second transcript.");
		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1]);
			await flush();
		});

		expect(invokedWith("tts_build_reference")).toEqual([
			{ paths: [SOURCE_1, SOURCE_2] },
			{ paths: [SOURCE_1] },
		]);
		expect(invokedWith("tts_transcribe_reference")).toEqual([
			{ path: COMBINED_A },
			{ path: COMBINED_B },
		]);
		expect(liveTts().voice).toBe(COMBINED_B);
		expect(liveTts().cloneRefText).toBe("Second transcript.");
		expect(result.current.liveSavedVoice.clips).toEqual([
			{ name: "part-1.wav", path: SOURCE_1, seconds: 4 },
		]);
	});

	test("DROPS a transcript whose clip was replaced while STT ran", async () => {
		onInvoke("tts_build_reference", () => build());
		let releaseTranscript: ((text: string) => void) | null = null;
		onInvoke(
			"tts_transcribe_reference",
			() =>
				new Promise<string>((resolve) => {
					releaseTranscript = resolve;
				}),
		);
		const { result } = await renderSection();

		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1]);
			await flush();
		});
		expect(releaseTranscript).not.toBeNull();

		// The voice moves on mid-flight (another window, or a saved voice applied).
		act(() => {
			useSettingsStore.getState().updateTtsSettings({ voice: COMBINED_B });
		});
		await act(async () => {
			releaseTranscript?.("Transcript of the PREVIOUS clip.");
			await flush();
		});

		// A transcript of the superseded clip is worse than none at all.
		expect(liveTts().cloneRefText).toBe("");
		expect(liveTts().voice).toBe(COMBINED_B);
	});

	test("never spends the STT model while read-aloud is switched off", async () => {
		seedSettings({ enabled: false });
		onInvoke("tts_build_reference", () => build());
		const { result } = await renderSection();

		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1]);
			await flush();
		});

		expect(liveTts().voice).toBe(COMBINED_A);
		expect(invokedWith("tts_transcribe_reference")).toEqual([]);
	});
});

describe("useTtsModelSection — applySavedVoice", () => {
	test("restores the value AND its transcript in one commit", async () => {
		onInvoke("tts_build_reference", () => build());
		const { result } = await renderSection();

		await act(() => {
			result.current.applySavedVoice({
				clips: [{ name: "part-1.wav", path: SOURCE_1, seconds: 4 }],
				kind: "clip",
				maxSecs: CATALOG_MAX_SECS,
				refText: "Saved transcript.",
				seconds: 4,
				value: COMBINED_B,
			});
		});
		await flush();

		expect(liveTts()).toEqual({
			cloneRefText: "Saved transcript.",
			voice: COMBINED_B,
		});
		expect(result.current.referenceClip.seconds).toBe(4);
		expect(result.current.liveSavedVoice.clips).toEqual([
			{ name: "part-1.wav", path: SOURCE_1, seconds: 4 },
		]);
		// A restored clip already carries its transcript, so nothing is re-derived.
		expect(invokedWith("tts_transcribe_reference")).toEqual([]);
	});

	test("adopts maxSecs 0 so no trim notice quotes a cap that never ran", async () => {
		// Build under a cap of 12 first, so a leaked report would be observable.
		onInvoke("tts_build_reference", () =>
			build({ maxSecs: 12, trimmed: true }),
		);
		onInvoke("tts_transcribe_reference", () => "Spoken reference.");
		const { result } = await renderSection();

		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1]);
			await flush();
		});
		expect(result.current.maxRefClipSecs).toBe(12);
		expect(result.current.referenceClip.trimmed).toBe(true);

		await act(() => {
			result.current.applySavedVoice({
				clips: [],
				kind: "clip",
				maxSecs: 0,
				refText: "Saved transcript.",
				seconds: 9,
				value: COMBINED_B,
			});
		});
		await flush();

		// `maxSecs: 0` falls through to the catalog row — the restored clip was
		// never re-trimmed, so the build's cap must not follow it.
		expect(result.current.maxRefClipSecs).toBe(CATALOG_MAX_SECS);
		expect(result.current.referenceClip.trimmed).toBe(false);
	});

	test("an empty saved value clears the report instead of describing nothing", async () => {
		onInvoke("tts_build_reference", () => build());
		onInvoke("tts_transcribe_reference", () => "Spoken reference.");
		const { result } = await renderSection();

		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1]);
			await flush();
		});

		await act(() => {
			result.current.applySavedVoice({
				clips: [],
				kind: "clip",
				maxSecs: 0,
				refText: "",
				seconds: 0,
				value: "",
			});
		});
		await flush();

		expect(result.current.referenceClip.path).toBe("");
		expect(result.current.referenceClip.seconds).toBe(0);
		expect(result.current.liveSavedVoice.clips).toEqual([]);
	});

	test("a voice welded for another model is re-welded, not re-uploaded", async () => {
		// The whole point of a shared library: the clips are already on disk, so a
		// voice cloned under a 30 s engine is offered under a 5 s one by welding its
		// parts again — the user is never asked for the same recordings twice.
		onInvoke("tts_build_reference", () =>
			build({ maxSecs: CATALOG_MAX_SECS, seconds: 12, storedPath: COMBINED_A }),
		);
		const { result } = await renderSection();
		const id = useVoiceLibraryStore.getState().saveVoice("Narrator", {
			clips: [{ name: "part-1.wav", path: SOURCE_1, seconds: 20 }],
			kind: "clip",
			// Welded for a five-second budget: this model's 30 s cap would hear only
			// a quarter of the audio the parts still hold.
			maxSecs: 5,
			refText: "Saved transcript.",
			seconds: 5,
			value: COMBINED_B,
		});

		await act(async () => {
			result.current.applySavedVoice(
				useVoiceLibraryStore.getState().voices[0] as never,
			);
			await flush();
		});

		// Re-welded from the SAME stored parts — no dialog, no new upload.
		expect(invokedWith("tts_build_reference")).toEqual([{ paths: [SOURCE_1] }]);
		expect(liveTts()).toEqual({
			cloneRefText: "Saved transcript.",
			voice: COMBINED_A,
		});
		// The library row now points at the clip that exists, so selecting the voice
		// under a different model does not make it read as edited.
		const row = useVoiceLibraryStore
			.getState()
			.voices.find((voice) => voice.id === id);
		expect(row?.value).toBe(COMBINED_A);
		expect(row?.maxSecs).toBe(CATALOG_MAX_SECS);
		expect(row?.refText).toBe("Saved transcript.");
	});

	test("a voice already welded for this model is applied untouched", async () => {
		onInvoke("tts_build_reference", () => build());
		const { result } = await renderSection();

		await act(async () => {
			result.current.applySavedVoice({
				clips: [{ name: "part-1.wav", path: SOURCE_1, seconds: 4 }],
				kind: "clip",
				maxSecs: CATALOG_MAX_SECS,
				refText: "Saved transcript.",
				seconds: 4,
				value: COMBINED_B,
			});
			await flush();
		});

		// Re-welding an identical clip would churn the disk and mark the row changed
		// for no audible difference.
		expect(invokedWith("tts_build_reference")).toEqual([]);
		expect(liveTts().voice).toBe(COMBINED_B);
	});
});

describe("useTtsModelSection — discardVoice", () => {
	test("deletes the stored files, unlists the row, and clears the ACTIVE voice", async () => {
		onInvoke("tts_build_reference", () => build());
		onInvoke("tts_transcribe_reference", () => "Spoken reference.");
		const { result } = await renderSection();

		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1, SOURCE_2]);
			await flush();
		});
		const id = useVoiceLibraryStore
			.getState()
			.saveVoice("Narrator", result.current.liveSavedVoice);
		const entry = useVoiceLibraryStore
			.getState()
			.voices.find((voice) => voice.id === id);
		expect(entry).toBeDefined();

		await act(async () => {
			result.current.discardVoice({
				entry: entry ?? null,
				// The parts AND the combined clip — the combined path repeats, and the
				// hook must not ask the backend to unlink it twice.
				paths: [SOURCE_1, SOURCE_2, COMBINED_A, COMBINED_A, "   "],
			});
			await flush();
		});

		expect(invokedWith("tts_delete_reference_clips")).toEqual([
			{ paths: [SOURCE_1, SOURCE_2, COMBINED_A] },
		]);
		expect(useVoiceLibraryStore.getState().voices).toEqual([]);
		// Falls back to the engine's own first preset voice.
		expect(liveTts()).toEqual({ cloneRefText: "", voice: "female" });
		expect(result.current.referenceClip.path).toBe("");
	});

	test("deleting a DIFFERENT voice leaves the one in effect alone", async () => {
		onInvoke("tts_build_reference", () => build());
		onInvoke("tts_transcribe_reference", () => "Spoken reference.");
		const { result } = await renderSection();

		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1]);
			await flush();
		});
		const otherId = useVoiceLibraryStore.getState().saveVoice("Other", {
			clips: [],
			kind: "clip",
			maxSecs: CATALOG_MAX_SECS,
			refText: "Other transcript.",
			seconds: 3,
			value: COMBINED_B,
		});
		const other = useVoiceLibraryStore
			.getState()
			.voices.find((voice) => voice.id === otherId);

		await act(async () => {
			result.current.discardVoice({
				entry: other ?? null,
				paths: [COMBINED_B],
			});
			await flush();
		});

		expect(invokedWith("tts_delete_reference_clips")).toEqual([
			{ paths: [COMBINED_B] },
		]);
		expect(useVoiceLibraryStore.getState().voices).toEqual([]);
		expect(liveTts()).toEqual({
			cloneRefText: "Spoken reference.",
			voice: COMBINED_A,
		});
	});

	test("an unnamed voice (no library row) always clears the live settings", async () => {
		onInvoke("tts_build_reference", () => build());
		onInvoke("tts_transcribe_reference", () => "Spoken reference.");
		const { result } = await renderSection();

		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1]);
			await flush();
		});

		await act(async () => {
			result.current.discardVoice({ entry: null, paths: [COMBINED_A] });
			await flush();
		});

		expect(liveTts()).toEqual({ cloneRefText: "", voice: "female" });
	});

	test("a part ANOTHER voice still lists is never unlinked", async () => {
		// Stored clip names are content-addressed (the backend hashes source path +
		// size + mtime), so the same take picked for two voices resolves to ONE
		// managed file. Unlinking it with the first voice would leave the second
		// pointing at nothing: its next rebuild cannot confine a path that no
		// longer exists and fails outright.
		onInvoke("tts_build_reference", () => build());
		onInvoke("tts_transcribe_reference", () => "Spoken reference.");
		const { result } = await renderSection();

		const sharedId = useVoiceLibraryStore.getState().saveVoice("Shared", {
			clips: [
				{ name: "part-1.wav", path: SOURCE_1, seconds: 4 },
				{ name: "part-2.wav", path: SOURCE_2, seconds: 3 },
			],
			kind: "clip",
			maxSecs: CATALOG_MAX_SECS,
			refText: "",
			seconds: 7,
			value: COMBINED_A,
		});
		useVoiceLibraryStore.getState().saveVoice("Keeper", {
			// Same first take, a different second one — so SOURCE_1 is shared and
			// SOURCE_2 belongs to the row being deleted alone.
			clips: [{ name: "part-1.wav", path: SOURCE_1, seconds: 4 }],
			kind: "clip",
			maxSecs: CATALOG_MAX_SECS,
			refText: "",
			seconds: 4,
			value: COMBINED_B,
		});
		const shared = useVoiceLibraryStore
			.getState()
			.voices.find((voice) => voice.id === sharedId);

		await act(async () => {
			result.current.discardVoice({
				entry: shared ?? null,
				paths: [SOURCE_1, SOURCE_2, COMBINED_A],
			});
			await flush();
		});

		expect(invokedWith("tts_delete_reference_clips")).toEqual([
			{ paths: [SOURCE_2, COMBINED_A] },
		]);
	});

	test("the voice in effect keeps its audio when another row named the same parts", async () => {
		// The live voice has moved off its saved row (a clip was added, so the
		// combined path changed) while still sharing the parts with it. Deleting
		// that row must not pull the audio out from under the voice being spoken.
		onInvoke("tts_build_reference", () => build());
		onInvoke("tts_transcribe_reference", () => "Spoken reference.");
		const { result } = await renderSection();

		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1, SOURCE_2]);
			await flush();
		});
		expect(liveTts().voice).toBe(COMBINED_A);

		const staleId = useVoiceLibraryStore.getState().saveVoice("Earlier take", {
			clips: [{ name: "part-1.wav", path: SOURCE_1, seconds: 4 }],
			kind: "clip",
			maxSecs: CATALOG_MAX_SECS,
			refText: "",
			seconds: 4,
			// A DIFFERENT combined clip, so this row is not the live voice…
			value: COMBINED_B,
		});
		const stale = useVoiceLibraryStore
			.getState()
			.voices.find((voice) => voice.id === staleId);

		await act(async () => {
			result.current.discardVoice({
				entry: stale ?? null,
				paths: [SOURCE_1, COMBINED_B],
			});
			await flush();
		});

		// …so only its own combined clip goes; the shared part stays because the
		// voice in effect is welded from it.
		expect(invokedWith("tts_delete_reference_clips")).toEqual([
			{ paths: [COMBINED_B] },
		]);
		expect(liveTts().voice).toBe(COMBINED_A);
	});

	test("a voice with nothing on disk deletes no files", async () => {
		const { result } = await renderSection();

		await act(async () => {
			result.current.discardVoice({ entry: null, paths: ["", "  "] });
			await flush();
		});

		expect(invokedWith("tts_delete_reference_clips")).toEqual([]);
	});
});

describe("useTtsModelSection — a rebuild sweeps what it superseded", () => {
	/** A third take and a third weld, so a rebuild can drop one part, keep one, and
	 *  land on a combined file that is neither of the previous two. */
	const SOURCE_3 = "C:/appdata/tts/reference-voices/part-3-33cc.wav";
	const COMBINED_C = "C:/appdata/tts/reference-voices/voice-e5f6.wav";

	function buildOf(
		storedPath: string,
		parts: [string, string, number][],
	): ReferenceBuild {
		return build({
			parts: parts.map(([name, path, seconds]) => ({
				name,
				seconds,
				storedPath: path,
			})),
			seconds: parts.reduce((total, [, , seconds]) => total + seconds, 0),
			storedPath,
		});
	}

	test("the combined clip a rebuild replaced is unlinked", async () => {
		// Every clip added or removed welds a NEW combined file under a new
		// content-addressed name. Until this shipped nothing removed the old one, so
		// the managed folder grew by a whole voice on every single edit — only
		// DELETING a voice ever swept anything.
		onInvoke("tts_build_reference", () =>
			buildOf(COMBINED_A, [["part-1.wav", SOURCE_1, 4]]),
		);
		onInvoke("tts_transcribe_reference", () => "Spoken reference.");
		const { result } = await renderSection();

		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1]);
			await flush();
		});
		// The FIRST weld supersedes nothing — there was no voice before it.
		expect(invokedWith("tts_delete_reference_clips")).toEqual([]);

		onInvoke("tts_build_reference", () =>
			buildOf(COMBINED_B, [
				["part-1.wav", SOURCE_1, 4],
				["part-2.wav", SOURCE_2, 3],
			]),
		);
		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1, SOURCE_2]);
			await flush();
		});

		expect(liveTts().voice).toBe(COMBINED_B);
		// Only the stranded combination: both parts are still welded into the voice.
		expect(invokedWith("tts_delete_reference_clips")).toEqual([
			{ paths: [COMBINED_A] },
		]);
	});

	test("a dropped part goes too — unless another voice still names it", async () => {
		// Stored part names are content-addressed, so the same take picked for two
		// voices IS one file on disk. Sweeping it with the rebuild would leave the
		// other voice pointing at nothing, and its next re-weld would fail outright.
		onInvoke("tts_build_reference", () =>
			buildOf(COMBINED_A, [
				["part-1.wav", SOURCE_1, 4],
				["part-2.wav", SOURCE_2, 3],
				["part-3.wav", SOURCE_3, 2],
			]),
		);
		onInvoke("tts_transcribe_reference", () => "Spoken reference.");
		const { result } = await renderSection();

		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1, SOURCE_2, SOURCE_3]);
			await flush();
		});

		// A second, saved voice welded from the SAME first take.
		useVoiceLibraryStore.getState().saveVoice("Keeper", {
			clips: [{ name: "part-1.wav", path: SOURCE_1, seconds: 4 }],
			kind: "clip",
			maxSecs: CATALOG_MAX_SECS,
			refText: "",
			seconds: 4,
			value: COMBINED_B,
		});

		// Drop the first and third clips; the voice re-welds from the survivor.
		onInvoke("tts_build_reference", () =>
			buildOf(COMBINED_C, [["part-2.wav", SOURCE_2, 3]]),
		);
		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_2]);
			await flush();
		});

		expect(invokedWith("tts_delete_reference_clips")).toEqual([
			// The superseded combination, and the part nothing names any more.
			// SOURCE_1 survives because "Keeper" is welded from it; SOURCE_2 survives
			// because the voice still is.
			{ paths: [COMBINED_A, SOURCE_3] },
		]);
	});

	test("saving over a dirty row unlinks the clip that row was keeping alive", async () => {
		// The other half of the leak. A rebuild deliberately spares the old combined
		// file BECAUSE the saved row still names it — so the row is the last thing
		// holding it, and re-pointing the row is what finally strands it. Before
		// this, the folder gained one orphaned WAV per edit of a saved voice.
		onInvoke("tts_build_reference", () =>
			buildOf(COMBINED_A, [["part-1.wav", SOURCE_1, 4]]),
		);
		onInvoke("tts_transcribe_reference", () => "Spoken reference.");
		const { result } = await renderSection();

		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1]);
			await flush();
		});
		const id = useVoiceLibraryStore.getState().saveVoice("Narrator", {
			clips: [{ name: "part-1.wav", path: SOURCE_1, seconds: 4 }],
			kind: "clip",
			maxSecs: CATALOG_MAX_SECS,
			refText: "",
			seconds: 4,
			value: COMBINED_A,
		});

		// Add a take: the row still names COMBINED_A, so the rebuild spares it.
		onInvoke("tts_build_reference", () =>
			buildOf(COMBINED_B, [
				["part-1.wav", SOURCE_1, 4],
				["part-2.wav", SOURCE_2, 3],
			]),
		);
		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1, SOURCE_2]);
			await flush();
		});
		expect(invokedWith("tts_delete_reference_clips")).toEqual([]);

		await act(async () => {
			result.current.overwriteSavedVoice(id, {
				clips: [
					{ name: "part-1.wav", path: SOURCE_1, seconds: 4 },
					{ name: "part-2.wav", path: SOURCE_2, seconds: 3 },
				],
				kind: "clip",
				maxSecs: CATALOG_MAX_SECS,
				refText: "",
				seconds: 7,
				value: COMBINED_B,
			});
			await flush();
		});

		// Only the stranded combination — both parts are still welded into the row.
		expect(invokedWith("tts_delete_reference_clips")).toEqual([
			{ paths: [COMBINED_A] },
		]);
	});

	test("saving over a row spares a clip another voice still names", async () => {
		onInvoke("tts_build_reference", () =>
			buildOf(COMBINED_A, [["part-1.wav", SOURCE_1, 4]]),
		);
		onInvoke("tts_transcribe_reference", () => "Spoken reference.");
		const { result } = await renderSection();

		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1]);
			await flush();
		});
		const id = useVoiceLibraryStore.getState().saveVoice("Narrator", {
			clips: [{ name: "part-1.wav", path: SOURCE_1, seconds: 4 }],
			kind: "clip",
			maxSecs: CATALOG_MAX_SECS,
			refText: "",
			seconds: 4,
			value: COMBINED_A,
		});
		// A single-part build stores the part AS the combined clip, so two voices
		// can genuinely share one file. Unlinking it would leave this one dangling.
		useVoiceLibraryStore.getState().saveVoice("Twin", {
			clips: [{ name: "part-1.wav", path: SOURCE_1, seconds: 4 }],
			kind: "clip",
			maxSecs: CATALOG_MAX_SECS,
			refText: "",
			seconds: 4,
			value: COMBINED_A,
		});

		await act(async () => {
			result.current.overwriteSavedVoice(id, {
				clips: [{ name: "part-2.wav", path: SOURCE_2, seconds: 3 }],
				kind: "clip",
				maxSecs: CATALOG_MAX_SECS,
				refText: "",
				seconds: 3,
				value: COMBINED_B,
			});
			await flush();
		});

		expect(invokedWith("tts_delete_reference_clips")).toEqual([]);
	});

	test("a rebuild that lands on the same file unlinks nothing", async () => {
		// Same parts, same order, same cap → the backend hands back the same
		// content-addressed name. Nothing was superseded, so nothing may be swept.
		onInvoke("tts_build_reference", () =>
			buildOf(COMBINED_A, [["part-1.wav", SOURCE_1, 4]]),
		);
		onInvoke("tts_transcribe_reference", () => "Spoken reference.");
		const { result } = await renderSection();

		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1]);
			await flush();
		});
		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1]);
			await flush();
		});

		expect(invokedWith("tts_delete_reference_clips")).toEqual([]);
	});

	test("a FAILED rebuild sweeps nothing — the old voice is still the voice", async () => {
		onInvoke("tts_build_reference", () =>
			buildOf(COMBINED_A, [["part-1.wav", SOURCE_1, 4]]),
		);
		onInvoke("tts_transcribe_reference", () => "Spoken reference.");
		const { result } = await renderSection();

		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1]);
			await flush();
		});

		onInvoke("tts_build_reference", () =>
			commandError("That path is not a file"),
		);
		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1, SOURCE_2]);
			await flush();
		});

		expect(liveTts().voice).toBe(COMBINED_A);
		expect(invokedWith("tts_delete_reference_clips")).toEqual([]);
	});

	test("a re-weld for another model's budget strands the clip it replaced", async () => {
		// One upload serves every cloning engine by re-welding its parts — which
		// leaves the previous cap-keyed combination named by nothing once the row
		// has been re-pointed at the new one.
		onInvoke("tts_build_reference", () =>
			buildOf(COMBINED_A, [["part-1.wav", SOURCE_1, 20]]),
		);
		const { result } = await renderSection();
		useVoiceLibraryStore.getState().saveVoice("Narrator", {
			clips: [{ name: "part-1.wav", path: SOURCE_1, seconds: 20 }],
			kind: "clip",
			// Welded for a five-second budget; this model's cap is 30.
			maxSecs: 5,
			refText: "Saved transcript.",
			seconds: 5,
			value: COMBINED_B,
		});

		await act(async () => {
			result.current.applySavedVoice(
				useVoiceLibraryStore.getState().voices[0] as never,
			);
			await flush();
		});

		expect(liveTts().voice).toBe(COMBINED_A);
		// The part is the build's own input and comes straight back, so only the
		// stale five-second weld is unlinked.
		expect(invokedWith("tts_delete_reference_clips")).toEqual([
			{ paths: [COMBINED_B] },
		]);
	});
});

describe("useTtsModelSection — build failures", () => {
	test("a backend rejection keeps the previous voice and surfaces its prose", async () => {
		onInvoke("tts_build_reference", () => build());
		onInvoke("tts_transcribe_reference", () => "Spoken reference.");
		const { result } = await renderSection();

		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1]);
			await flush();
		});
		expect(liveTts().voice).toBe(COMBINED_A);

		onInvoke("tts_build_reference", () =>
			commandError(
				"Reference clip is too short — use at least ~1 second of clear speech.",
			),
		);
		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1, SOURCE_2]);
			await flush();
		});

		expect(result.current.cloneError).toBe(
			"Reference clip is too short — use at least ~1 second of clear speech.",
		);
		// The voice that already worked is untouched — including its transcript and
		// the parts behind it.
		expect(liveTts()).toEqual({
			cloneRefText: "Spoken reference.",
			voice: COMBINED_A,
		});
		expect(result.current.liveSavedVoice.clips).toHaveLength(2);
		expect(result.current.cloneBusy).toBe(false);
	});

	test("an invoke that blows up falls back to the one honest sentence", async () => {
		onInvoke("tts_build_reference", () => {
			throw new Error("no native runtime");
		});
		const { result } = await renderSection();
		const before = liveTts().voice;

		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1]);
			await flush();
		});

		expect(result.current.cloneError).toBe("Couldn't prepare that audio.");
		expect(liveTts().voice).toBe(before);
		expect(result.current.cloneBusy).toBe(false);
	});

	test("a new attempt clears the previous failure", async () => {
		onInvoke("tts_build_reference", () =>
			commandError("That path is not a file"),
		);
		onInvoke("tts_transcribe_reference", () => "Spoken reference.");
		const { result } = await renderSection();

		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1]);
			await flush();
		});
		expect(result.current.cloneError).toBe("That path is not a file");

		onInvoke("tts_build_reference", () => build());
		await act(async () => {
			result.current.handleSetReferenceClips([SOURCE_1, SOURCE_2]);
			await flush();
		});

		expect(result.current.cloneError).toBeNull();
		expect(liveTts().voice).toBe(COMBINED_A);
	});
});
