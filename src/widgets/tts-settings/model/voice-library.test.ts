import { beforeEach, describe, expect, test } from "bun:test";
import { APP_DATA_CATEGORY_REMOVED } from "@/shared/lib/app-data-events";
import { REFERENCE_GAP_SECS } from "../lib/clone-voice";
import {
	projectedClipSeconds,
	referencedClipPaths,
	removeClipAt,
	reorderSavedVoices,
	type SavedVoice,
	type SavedVoiceClip,
	type SavedVoiceValue,
	salvageSavedVoice,
	savedVoiceMatches,
	supersededClipPaths,
	totalClipSeconds,
	useVoiceLibraryStore,
	voiceNeedsRebuild,
} from "./voice-library";

const STORAGE_KEY = "winstt:tts-voice-library";

function clip(value: string, refText = ""): SavedVoiceValue {
	return {
		kind: "clip",
		value,
		refText,
		seconds: 12,
		maxSecs: 30,
		clips: [{ name: value, path: value, seconds: 12 }],
	};
}

function readBlob(): { voices: SavedVoice[] } {
	return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
}

beforeEach(() => {
	window.localStorage.clear();
	useVoiceLibraryStore.setState({
		voices: [],
		activeVoiceId: null,
		persistFailed: null,
	});
});

describe("voice library store", () => {
	test("saves a named voice, persists it, and makes it active", () => {
		const id = useVoiceLibraryStore
			.getState()
			.saveVoice("Narrator", clip("a.wav"));

		const state = useVoiceLibraryStore.getState();
		expect(state.voices).toHaveLength(1);
		expect(state.voices[0]?.name).toBe("Narrator");
		expect(state.activeVoiceId).toBe(id);
		// The blob — not just memory — is what a second window reads.
		expect(readBlob().voices[0]?.value).toBe("a.wav");
	});

	test("updates an entry in place without touching its name or id", () => {
		const store = useVoiceLibraryStore.getState();
		const id = store.saveVoice("Narrator", clip("a.wav"));

		useVoiceLibraryStore.getState().updateVoice(id, clip("b.wav", "hello"));

		const saved = useVoiceLibraryStore.getState().voices[0];
		expect(saved?.id).toBe(id);
		expect(saved?.name).toBe("Narrator");
		expect(saved?.value).toBe("b.wav");
		expect(saved?.refText).toBe("hello");
	});

	test("removing the active entry clears the active id", () => {
		const id = useVoiceLibraryStore
			.getState()
			.saveVoice("Narrator", clip("a.wav"));

		useVoiceLibraryStore.getState().removeVoice(id);

		expect(useVoiceLibraryStore.getState().voices).toHaveLength(0);
		expect(useVoiceLibraryStore.getState().activeVoiceId).toBeNull();
		expect(readBlob().voices).toHaveLength(0);
	});

	test("reports a failed write instead of claiming the voice was saved", () => {
		// Every way a persist can fail (quota exceeded, storage disabled,
		// serialization) funnels through the same `false` from
		// `writePersistedSelectorState`. A BigInt makes `JSON.stringify` throw,
		// which reaches that branch without depending on a mockable localStorage.
		const unserializable = {
			...clip("a.wav"),
			seconds: 1n as unknown as number,
		};

		useVoiceLibraryStore.getState().saveVoice("Narrator", unserializable);

		const state = useVoiceLibraryStore.getState();
		// The entry still works in memory for this session…
		expect(state.voices).toHaveLength(1);
		// …but the failure is surfaced, and the row is NOT promoted to "active":
		// claiming a persistence that never happened is the lie this guards.
		expect(state.persistFailed).toBe("save");
		expect(state.activeVoiceId).toBeNull();
		expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
	});
});

describe("removing the Voices app-data category", () => {
	test("drops the library so no name outlives the audio it points at", () => {
		useVoiceLibraryStore.getState().saveVoice("Narrator", clip("a.wav"));
		expect(useVoiceLibraryStore.getState().voices).toHaveLength(1);

		window.dispatchEvent(
			new CustomEvent(APP_DATA_CATEGORY_REMOVED, {
				detail: { key: "voices" },
			}),
		);

		expect(useVoiceLibraryStore.getState().voices).toEqual([]);
		expect(useVoiceLibraryStore.getState().activeVoiceId).toBeNull();
		// The mirror goes too — otherwise the next launch would write these names
		// straight back to the disk record the removal just deleted.
		expect(readBlob().voices).toEqual([]);
	});

	test("another category's removal leaves the voices alone", () => {
		useVoiceLibraryStore.getState().saveVoice("Narrator", clip("a.wav"));

		window.dispatchEvent(
			new CustomEvent(APP_DATA_CATEGORY_REMOVED, { detail: { key: "stt" } }),
		);

		expect(useVoiceLibraryStore.getState().voices).toHaveLength(1);
	});
});

describe("reorderSavedVoices", () => {
	const list: SavedVoice[] = ["a", "b", "c"].map((id) => ({
		id,
		name: id,
		kind: "clip",
		value: `${id}.wav`,
		refText: "",
		seconds: 0,
		maxSecs: 0,
		clips: [],
	}));

	test("moves before and after the target", () => {
		expect(
			reorderSavedVoices(list, "c", "a", "before").map((v) => v.id),
		).toEqual(["c", "a", "b"]);
		expect(
			reorderSavedVoices(list, "a", "b", "after").map((v) => v.id),
		).toEqual(["b", "a", "c"]);
	});

	test("is a no-op for self-drops and unknown ids", () => {
		expect(
			reorderSavedVoices(list, "a", "a", "after").map((v) => v.id),
		).toEqual(["a", "b", "c"]);
		expect(
			reorderSavedVoices(list, "zz", "a", "after").map((v) => v.id),
		).toEqual(["a", "b", "c"]);
	});
});

describe("savedVoiceMatches", () => {
	const entry: SavedVoice = {
		id: "1",
		name: "Narrator",
		kind: "clip",
		value: "a.wav",
		refText: "hello",
		seconds: 12,
		maxSecs: 30,
		clips: [{ name: "a.wav", path: "a.wav", seconds: 12 }],
	};

	test("compares what defines the voice, ignoring descriptive duration", () => {
		expect(
			savedVoiceMatches(entry, {
				kind: "clip",
				value: "a.wav",
				refText: "hello",
				seconds: 0,
				maxSecs: 30,
				clips: entry.clips,
			}),
		).toBe(true);
		expect(
			savedVoiceMatches(entry, {
				kind: "clip",
				value: "a.wav",
				refText: "edited",
				seconds: 12,
				maxSecs: 30,
				clips: entry.clips,
			}),
		).toBe(false);
	});

	test("a design prompt never matches a clip that happens to share its text", () => {
		expect(
			savedVoiceMatches(entry, {
				kind: "design",
				value: "a.wav",
				refText: "hello",
				seconds: 12,
				maxSecs: 0,
				clips: [],
			}),
		).toBe(false);
	});

	test("the ingest history is not part of identity — the combined value is", () => {
		// `value` is derived from the clips, so it already reflects every change
		// that can alter the voice. Comparing the list too would mark a row dirty
		// over a re-ingested copy under a new path or a relabelled clip.
		expect(
			savedVoiceMatches(entry, {
				kind: "clip",
				value: "a.wav",
				refText: "hello",
				seconds: 12,
				maxSecs: 5,
				clips: [
					{ name: "renamed.wav", path: "elsewhere/a.wav", seconds: 7 },
					{ name: "b.wav", path: "b.wav", seconds: 5 },
				],
			}),
		).toBe(true);
	});
});

describe("salvageSavedVoice", () => {
	test("repairs an entry that lost its optional halves rather than dropping it", () => {
		expect(salvageSavedVoice({ id: "1", name: "Narrator" })).toEqual({
			id: "1",
			name: "Narrator",
			kind: "clip",
			value: "",
			refText: "",
			seconds: 0,
			maxSecs: 0,
			clips: [],
		});
	});

	test("rejects a row with no identity", () => {
		expect(salvageSavedVoice({ name: "Narrator" })).toBeNull();
		expect(salvageSavedVoice("nonsense")).toBeNull();
		expect(salvageSavedVoice(null)).toBeNull();
	});

	test("drops only the unusable clips, never the whole voice", () => {
		const salvaged = salvageSavedVoice({
			id: "1",
			name: "Narrator",
			kind: "clip",
			value: "combined.wav",
			seconds: 9,
			clips: [
				{ name: "a.wav", path: "a.wav", seconds: 4 },
				// No path: names nothing on disk, so it cannot be rebuilt from.
				{ name: "ghost.wav", seconds: 5 },
			],
		});

		expect(salvaged?.clips).toEqual([
			{ name: "a.wav", path: "a.wav", seconds: 4 },
		]);
		expect(salvaged?.value).toBe("combined.wav");
	});
});

describe("v1 → v2 migration", () => {
	function seedBlob(blob: unknown): void {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
		// The cross-window listener re-reads storage, which is the only way to
		// exercise the module-private read path after the store was created.
		window.dispatchEvent(
			new StorageEvent("storage", {
				key: STORAGE_KEY,
				newValue: window.localStorage.getItem(STORAGE_KEY),
			}),
		);
	}

	test("a v1 clip survives the zod happy path as its own clip entry", () => {
		// `clips` has a zod default, so a v1 blob parses CLEANLY and never reaches
		// the salvage branch. Without a migration on the happy path the default
		// would hand back a clip voice with no clips — the clip lost in silence.
		seedBlob({
			version: 1,
			voices: [
				{
					id: "1",
					name: "Narrator",
					kind: "clip",
					value: "C:\\voices\\narrator.wav",
					refText: "hello",
					seconds: 12,
				},
			],
		});

		expect(useVoiceLibraryStore.getState().voices[0]?.clips).toEqual([
			{ name: "narrator.wav", path: "C:\\voices\\narrator.wav", seconds: 12 },
		]);
	});

	test("a v1 design prompt migrates to an empty clip list", () => {
		seedBlob({
			version: 1,
			voices: [
				{
					id: "1",
					name: "Batman",
					kind: "design",
					value: "a gravelly, low voice",
					refText: "",
					seconds: 0,
				},
			],
		});

		const voice = useVoiceLibraryStore.getState().voices[0];
		expect(voice?.clips).toEqual([]);
		expect(voice?.value).toBe("a gravelly, low voice");
	});

	test("salvageSavedVoice migrates a v1 record it had to repair", () => {
		// Repair path: `kind` is garbage, so the strict parse fails — the clip must
		// still come through rather than being lost with the broken field.
		expect(
			salvageSavedVoice({
				id: "1",
				name: "Narrator",
				kind: 7,
				value: "/home/me/clips/take-2.mp3",
				seconds: 8.5,
			})?.clips,
		).toEqual([
			{ name: "take-2.mp3", path: "/home/me/clips/take-2.mp3", seconds: 8.5 },
		]);
	});

	test("does not invent a clip for a v1 entry that never had one", () => {
		expect(
			salvageSavedVoice({ id: "1", name: "Empty", kind: "clip", value: "" })
				?.clips,
		).toEqual([]);
	});

	test("leaves an already-migrated v2 voice alone", () => {
		const clips = [
			{ name: "a.wav", path: "a.wav", seconds: 4 },
			{ name: "b.wav", path: "b.wav", seconds: 6 },
		];
		seedBlob({
			version: 2,
			voices: [
				{
					id: "1",
					name: "Narrator",
					kind: "clip",
					value: "combined.wav",
					refText: "",
					seconds: 10,
					clips,
				},
			],
		});

		expect(useVoiceLibraryStore.getState().voices[0]?.clips).toEqual(clips);
	});
});

describe("multi-clip round-trip", () => {
	test("a saved voice keeps its clips across a persist + re-read", () => {
		const clips = [
			{ name: "intro.wav", path: "C:\\v\\intro.wav", seconds: 4 },
			{ name: "outro.wav", path: "C:\\v\\outro.wav", seconds: 6 },
		];
		useVoiceLibraryStore.getState().saveVoice("Narrator", {
			kind: "clip",
			value: "C:\\v\\combined.wav",
			refText: "hi",
			seconds: 10,
			maxSecs: 30,
			clips,
		});

		// Reading the blob back is what a second window (and the next launch) does.
		window.dispatchEvent(
			new StorageEvent("storage", {
				key: STORAGE_KEY,
				newValue: window.localStorage.getItem(STORAGE_KEY),
			}),
		);

		const voice = useVoiceLibraryStore.getState().voices[0];
		expect(voice?.clips).toEqual(clips);
		// The seam: engines still read ONE combined path out of `value`.
		expect(voice?.value).toBe("C:\\v\\combined.wav");
	});
});

describe("totalClipSeconds", () => {
	test("sums the clip durations", () => {
		expect(
			totalClipSeconds([
				{ name: "a", path: "a", seconds: 4 },
				{ name: "b", path: "b", seconds: 6.5 },
			]),
		).toBe(10.5);
		expect(totalClipSeconds([])).toBe(0);
	});

	test("ignores unmeasured and corrupt durations instead of poisoning the sum", () => {
		expect(
			totalClipSeconds([
				{ name: "a", path: "a", seconds: 4 },
				{ name: "b", path: "b", seconds: 0 },
				{ name: "c", path: "c", seconds: Number.NaN },
				{ name: "d", path: "d", seconds: -3 },
			]),
		).toBe(4);
	});

	test("does not let float drift push an exactly-at-the-cap voice over it", () => {
		// 0.1 + 0.2 + … accumulates error; a raw sum reads as > 30 and would make
		// the capacity meter refuse a voice that exactly fits.
		const clips = Array.from({ length: 300 }, (_, i) => ({
			name: String(i),
			path: String(i),
			seconds: 0.1,
		}));
		expect(totalClipSeconds(clips)).toBe(30);
		expect(totalClipSeconds(clips) > 30).toBe(false);
	});
});

describe("projectedClipSeconds — the gaps cost budget too", () => {
	function parts(...seconds: number[]): SavedVoiceClip[] {
		return seconds.map((value, index) => ({
			name: `${index}.wav`,
			path: `C:/v/${index}.wav`,
			seconds: value,
		}));
	}

	test("one clip is welded to nothing, so it spends no gap", () => {
		expect(projectedClipSeconds(parts(8))).toBe(8);
	});

	test("n clips spend n-1 gaps", () => {
		expect(projectedClipSeconds(parts(8, 4))).toBe(8 + 4 + REFERENCE_GAP_SECS);
		expect(projectedClipSeconds(parts(8, 4, 2))).toBe(
			8 + 4 + 2 + 2 * REFERENCE_GAP_SECS,
		);
		expect(projectedClipSeconds(parts(1, 1, 1, 1, 1))).toBe(
			5 + 4 * REFERENCE_GAP_SECS,
		);
	});

	test("it exceeds the bare parts sum by exactly the welded silence", () => {
		// The defect this closes: the meter filled against `totalClipSeconds`, which
		// is what the backend does NOT cap. On OmniVoice's 5s budget three clips lose
		// 0.5s — a tenth of the whole budget — to gaps a parts-only total never saw,
		// so the meter promised room the weld would not honour.
		const clips = parts(1.5, 1.5, 1.5);
		expect(projectedClipSeconds(clips) - totalClipSeconds(clips)).toBeCloseTo(
			2 * REFERENCE_GAP_SECS,
			9,
		);
		// 4.5s of audio + 0.5s of gaps is AT OmniVoice's 5s cap, not 0.5s short of it.
		expect(projectedClipSeconds(clips)).toBe(5);
	});

	test("no clips, and no clip list, cost nothing", () => {
		expect(projectedClipSeconds([])).toBe(0);
	});

	test("unmeasured clips stay at 0 rather than becoming a bar made of gaps", () => {
		// Durations are not re-derived on restore. A voice whose parts were never
		// timed must read as "unmeasured" — reporting 0.5s of gaps would draw a bar
		// at 10% and demand more audio from a voice that works.
		expect(projectedClipSeconds(parts(0, 0, 0))).toBe(0);
	});

	test("a corrupt duration cannot poison the projection", () => {
		expect(projectedClipSeconds(parts(Number.NaN, 4))).toBe(
			4 + REFERENCE_GAP_SECS,
		);
	});
});

describe("supersededClipPaths — what a rebuild may unlink", () => {
	function voice(value: string, ...partPaths: string[]): SavedVoiceValue {
		return {
			clips: partPaths.map((path) => ({ name: path, path, seconds: 4 })),
			kind: "clip",
			maxSecs: 30,
			refText: "",
			seconds: 8,
			value,
		};
	}

	test("the superseded combined clip goes; a part another voice names stays", () => {
		// The exact shape of the leak: adding a clip welds a NEW combined file and
		// orphans the previous one. But stored part names are content-addressed, so
		// the same take picked for two voices IS one managed file — unlinking it
		// would leave the other voice pointing at nothing.
		const previous = ["C:/v/voice-old.wav", "C:/v/shared.wav", "C:/v/gone.wav"];
		const other = voice("C:/v/voice-other.wav", "C:/v/shared.wav");
		const live = voice(
			"C:/v/voice-new.wav",
			"C:/v/shared.wav",
			"C:/v/added.wav",
		);

		expect(supersededClipPaths({ previous, retained: [other, live] })).toEqual([
			// Replaced by the new weld and named by nothing.
			"C:/v/voice-old.wav",
			// Dropped from the voice and named by nothing.
			"C:/v/gone.wav",
		]);
	});

	test("a library row still naming the old combined clip keeps it alive", () => {
		// The user edited a SAVED voice without pressing save: the row can still be
		// restored to the clip it names, so that clip is not garbage yet.
		const row = voice("C:/v/voice-old.wav", "C:/v/a.wav");
		const live = voice("C:/v/voice-new.wav", "C:/v/a.wav", "C:/v/b.wav");

		expect(
			supersededClipPaths({
				previous: ["C:/v/voice-old.wav", "C:/v/a.wav"],
				retained: [row, live],
			}),
		).toEqual([]);
	});

	test("a single-part voice whose combined clip IS its part is never unlinked", () => {
		// One part the cap did not touch is stored as the combined clip itself, so
		// the two paths are the same file.
		const live = voice("C:/v/a.wav", "C:/v/a.wav");

		expect(
			supersededClipPaths({ previous: ["C:/v/a.wav"], retained: [live] }),
		).toEqual([]);
	});

	test("blank and duplicate entries never reach the delete command", () => {
		const live = voice("C:/v/voice-new.wav", "C:/v/a.wav");

		expect(
			supersededClipPaths({
				previous: ["C:/v/old.wav", "  ", "", " C:/v/old.wav "],
				retained: [live],
			}),
		).toEqual(["C:/v/old.wav"]);
	});

	test("with nothing retained at all, everything the voice owned is garbage", () => {
		expect(
			supersededClipPaths({
				previous: ["C:/v/old.wav", "C:/v/a.wav"],
				retained: [],
			}),
		).toEqual(["C:/v/old.wav", "C:/v/a.wav"]);
	});
});

describe("referencedClipPaths", () => {
	test("collects a voice's parts AND the combined clip welded from them", () => {
		expect(
			referencedClipPaths([
				{
					clips: [
						{ name: "a", path: "C:/v/a.wav", seconds: 4 },
						{ name: "b", path: "C:/v/b.wav", seconds: 3 },
					],
					kind: "clip",
					maxSecs: 30,
					refText: "",
					seconds: 7,
					value: "C:/v/voice-ab.wav",
				},
			]),
		).toEqual(new Set(["C:/v/voice-ab.wav", "C:/v/a.wav", "C:/v/b.wav"]));
	});

	test("a part two voices were built from is named once, by both", () => {
		// Stored clip names are content-addressed, so the same take always resolves
		// to the same managed file — this set is what stops a delete from unlinking
		// audio another voice still depends on.
		const shared = referencedClipPaths([
			{
				clips: [{ name: "a", path: "C:/v/a.wav", seconds: 4 }],
				kind: "clip",
				maxSecs: 30,
				refText: "",
				seconds: 4,
				value: "C:/v/voice-a.wav",
			},
			{
				clips: [
					{ name: "a", path: " C:/v/a.wav " },
					{ name: "c", path: "" },
				].map((entry) => ({ ...entry, seconds: 4 })),
				kind: "clip",
				maxSecs: 30,
				refText: "",
				seconds: 8,
				value: "C:/v/voice-ac.wav",
			},
		]);

		expect(shared.has("C:/v/a.wav")).toBe(true);
		// Whitespace-only paths name nothing on disk and are not carried.
		expect(shared.has("")).toBe(false);
		expect(shared.size).toBe(3);
	});

	test("a design voice names no audio — its value is prose", () => {
		expect(
			referencedClipPaths([
				{
					clips: [],
					kind: "design",
					maxSecs: 0,
					refText: "",
					seconds: 0,
					value: "A warm, low narrator.",
				},
			]),
		).toEqual(new Set());
	});
});

describe("voiceNeedsRebuild — one upload, every cloning engine", () => {
	/** A voice whose parts hold `seconds` of audio, welded for a `maxSecs` cap. */
	function voice(seconds: number, maxSecs: number): SavedVoiceValue {
		return {
			clips: [{ name: "a.wav", path: "C:/v/a.wav", seconds }],
			kind: "clip",
			maxSecs,
			refText: "",
			seconds: Math.min(seconds, maxSecs || seconds),
			value: "C:/v/voice.wav",
		};
	}

	test("a 30s voice must be re-welded before a 5s engine hears it", () => {
		// The headline case: OmniVoice's refinement is quadratic in reference
		// frames, so handing it a clip built for Chatterbox is not a cosmetic
		// mismatch — it is six times the audio the cap exists to prevent.
		expect(voiceNeedsRebuild(voice(20, 30), 5)).toBe(true);
	});

	test("a voice trimmed for the 5s engine is re-welded to recover the rest", () => {
		// The other direction matters just as much: the parts still hold all 20s,
		// and without this the 30s engine would keep cloning from the five seconds
		// the smaller model cut it down to.
		expect(voiceNeedsRebuild(voice(20, 5), 30)).toBe(true);
	});

	test("two caps that both clear the audio produce the same clip", () => {
		// 4s of parts fits under either budget, so both welds are the same whole
		// clip — re-welding would rewrite an identical file and churn the row for
		// no audible difference.
		expect(voiceNeedsRebuild(voice(4, 30), 5)).toBe(false);
		expect(voiceNeedsRebuild(voice(4, 5), 30)).toBe(false);
	});

	test("the same cap is never a reason to rebuild", () => {
		expect(voiceNeedsRebuild(voice(20, 30), 30)).toBe(false);
	});

	test("an entry with no recorded cap rebuilds once to find out", () => {
		// Saved before voices were shared: nothing says which budget its clip was
		// welded for, and one rebuild is also what self-heals a combined file that
		// is missing from disk.
		expect(voiceNeedsRebuild(voice(4, 0), 30)).toBe(true);
	});

	test("the inter-part gaps count against the budget", () => {
		// Four parts of 7.5s are 30s of speech plus 0.75s of welded silence, so
		// they do NOT both fit a 30s and a 31s cap — the gap is real budget.
		const gapped: SavedVoiceValue = {
			clips: Array.from({ length: 4 }, (_, i) => ({
				name: `${i}.wav`,
				path: `C:/v/${i}.wav`,
				seconds: 7.5,
			})),
			kind: "clip",
			maxSecs: 31,
			refText: "",
			seconds: 30,
			value: "C:/v/voice.wav",
		};
		expect(voiceNeedsRebuild(gapped, 30)).toBe(true);
	});

	test("leaves alone what it cannot rebuild or cannot judge", () => {
		const noParts: SavedVoiceValue = { ...voice(20, 30), clips: [] };
		// Nothing to re-weld FROM — using the clip in hand beats failing.
		expect(voiceNeedsRebuild(noParts, 5)).toBe(false);
		// No cap on the selected row: no target to build for.
		expect(voiceNeedsRebuild(voice(20, 30), 0)).toBe(false);
		// A prompt has no audio behind it.
		expect(
			voiceNeedsRebuild(
				{ ...voice(20, 30), kind: "design", value: "a warm narrator" },
				5,
			),
		).toBe(false);
		// Unmeasured durations cannot answer the question.
		expect(voiceNeedsRebuild(voice(0, 30), 5)).toBe(false);
	});
});

describe("removeClipAt", () => {
	const clips: SavedVoiceClip[] = ["a", "b", "c"].map((name) => ({
		name,
		path: `${name}.wav`,
		seconds: 1,
	}));

	test("drops the clip at the given position", () => {
		expect(removeClipAt(clips, 1).map((c) => c.name)).toEqual(["a", "c"]);
		expect(removeClipAt(clips, 0).map((c) => c.name)).toEqual(["b", "c"]);
		expect(removeClipAt(clips, 2).map((c) => c.name)).toEqual(["a", "b"]);
	});

	test("does not mutate the input", () => {
		removeClipAt(clips, 1);
		expect(clips).toHaveLength(3);
	});

	test("a stale or nonsense index is a no-op copy", () => {
		expect(removeClipAt(clips, 3).map((c) => c.name)).toEqual(["a", "b", "c"]);
		expect(removeClipAt(clips, -1).map((c) => c.name)).toEqual(["a", "b", "c"]);
		expect(removeClipAt(clips, 1.5).map((c) => c.name)).toEqual([
			"a",
			"b",
			"c",
		]);
		expect(removeClipAt([], 0)).toEqual([]);
	});
});
