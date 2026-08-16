import { z } from "zod";
import { create } from "zustand";
import { commands } from "@/bindings";
import { onAppDataCategoryRemoved } from "@/shared/lib/app-data-events";
import { generateId } from "@/shared/lib/generate-id";
import {
	readPersistedSelectorState,
	writePersistedSelectorState,
} from "@/shared/lib/persisted-selector-state";
import { hasTauriRuntime } from "@/shared/lib/tauri-runtime";
import { clipBaseName, REFERENCE_GAP_SECS } from "../lib/clone-voice";

/**
 * Saved-voice library — the TTS mirror of the LLM "Configurations" list
 * (`widgets/llm-settings/model/configurations.ts`), deliberately built on the
 * same primitives: zod at the storage boundary, a salvage pass for
 * partially-corrupt entries, an honest boolean from
 * `writePersistedSelectorState`, and a `storage` listener so a second window
 * sees the same list.
 *
 * It is a NAMED-SNAPSHOT layer over `settings.tts.voice`: the live voice always
 * remains the single source of truth for synthesis, and a library entry is just
 * a name pointing at a value that field can hold.
 *
 * A voice may be assembled from SEVERAL source clips, but they are concatenated
 * into ONE combined file before they reach here — `value` stays a single string,
 * so the seam at `settings.tts.voice` is untouched and no engine can tell a
 * multi-clip voice from a single-clip one. `clips[]` is the ingest history that
 * makes the combination reversible; see `SavedVoiceValue.clips`.
 *
 * TWO RECORDS, one of them authoritative. Unlike the LLM configurations this
 * list names files on disk that the user recorded or picked, so it is persisted
 * to `<app data>/tts/reference-voices/library.json` — the same folder as the
 * audio, so the two are reported, backed up and removed as one thing (the About
 * tab's "Voices" row). localStorage is kept as a MIRROR, for two things the disk
 * copy cannot do: paint the list synchronously on first render, and tell a
 * second window (the detached picker) that the list changed. On a mismatch the
 * disk wins — that is what survives a cleared web store.
 */

/** Which half of the overloaded `settings.tts.voice` field an entry stores.
 *  `clip` = a normalized reference-clip path (cloning engines); `design` = a
 *  natural-language voice-design prompt. Kept explicit so a prompt is never
 *  restored into a field an engine will try to open as a file. */
export type SavedVoiceKind = "clip" | "design";

/** One source clip a voice was built from. The ingest HISTORY, not what the
 *  engines read — those only ever see the combined `SavedVoiceValue.value`. */
export interface SavedVoiceClip {
	/** Display label, normally the source file's basename. Kept alongside the
	 *  path because the stored path points at a normalized copy in app data,
	 *  whose name no longer resembles what the user dropped in. */
	name: string;
	/** Absolute path to this individual source clip. */
	path: string;
	/** Length of THIS clip in seconds; `0` = unknown. */
	seconds: number;
}

export interface SavedVoiceValue {
	/**
	 * The clips this voice was built from, in ingest order. Purely additive
	 * history: `value` is the single COMBINED file the engines open, and a
	 * combined file cannot be decomposed again, so the pieces are remembered here
	 * to make a rebuild possible after one of them is dropped.
	 *
	 * Always `[]` for `kind: "design"` — a prompt has no audio behind it.
	 */
	clips: SavedVoiceClip[];
	kind: SavedVoiceKind;
	/**
	 * The reference budget `value` was welded under, in seconds; `0` = unknown.
	 *
	 * A voice is offered under EVERY cloning engine, and their budgets differ by
	 * a factor of six (OmniVoice 5 s, everything else 30 s). The clips behind the
	 * voice are stored at the widest budget, so the combined file is the only part
	 * that is model-specific — and this records which model it currently suits.
	 * When it does not match the selected engine's cap, the combined clip is
	 * rebuilt from `clips` rather than the user being asked to upload the audio a
	 * second time.
	 *
	 * `0` on an entry saved before this existed, which reads as "rebuild once to
	 * find out" — the safe direction.
	 */
	maxSecs: number;
	/** Transcript of the reference clip, for engines whose cloning needs one
	 *  (`zero_shot_audio_transcript`). Empty for every other case.
	 *
	 *  Lives HERE, per voice, and not only in `settings.tts.cloneRefText`: that
	 *  field holds the transcript of whichever voice is live right now, so it can
	 *  remember exactly one. Restoring a voice restores its transcript with it. */
	refText: string;
	/** TOTAL length of the stored clip in seconds; `0` = unknown. Recorded at save
	 *  time because re-deriving it means decoding the clip again. Meaningless
	 *  for `design` entries. */
	seconds: number;
	/** The COMBINED clip path (`kind: "clip"`) or the design prompt
	 *  (`kind: "design"`). Deliberately a SINGLE string: it is exactly what
	 *  `settings.tts.voice` holds, so multi-clip voices stay invisible to every
	 *  engine — they keep opening one file and need no change. */
	value: string;
}

export interface SavedVoice extends SavedVoiceValue {
	id: string;
	name: string;
}

export type VoiceLibraryDropPlacement = "before" | "after";

/** Which mutation failed to reach localStorage. Surfaced inline next to the
 *  library so a "saved" that never persisted is observable instead of a silent
 *  lie — the same honesty contract the LLM configurations store keeps. */
export type VoiceLibraryPersistenceAction =
	| "save"
	| "update"
	| "delete"
	| "reorder";

const STORAGE_KEY = "winstt:tts-voice-library";
// v3 — a voice records which model budget its combined clip was welded under
// (`maxSecs`), so one upload can serve engines with different caps. Additive
// like v2 before it: an older build reads a v3 blob as a voice with one extra
// field it ignores, and a v2 blob reads here as `maxSecs: 0` ("unknown"), which
// simply asks for one rebuild.
const BLOB_VERSION = 3;

const savedVoiceClipSchema = z.object({
	name: z.string().default(""),
	// A clip with no path names nothing on disk and cannot be rebuilt from, so it
	// fails the parse and is dropped rather than sitting in the list as a ghost.
	path: z.string().min(1),
	seconds: z.number().default(0),
});

const savedVoiceSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	kind: z.enum(["clip", "design"]),
	value: z.string(),
	refText: z.string().default(""),
	seconds: z.number().default(0),
	maxSecs: z.number().default(0),
	clips: z.array(savedVoiceClipSchema).default([]),
});

const blobSchema = z.object({
	version: z.number().default(BLOB_VERSION),
	voices: z.array(savedVoiceSchema).default([]),
});

/**
 * v1 → v2 migration: give a record persisted before voices owned `clips[]` the
 * single-clip history its `value` implies, so the clip survives the upgrade.
 *
 * Keyed on the SHAPE — a `clip` entry with a value but an empty clip list —
 * rather than on the blob's `version` stamp, for two reasons: `salvageSavedVoice`
 * is handed one entry with no version in scope, and the stamp on a hand-edited
 * or partly-rewritten blob cannot be trusted. A well-formed v2 clip voice always
 * carries at least one clip (dropping the last one deletes the voice), so this
 * is a no-op for anything already migrated.
 */
function withMigratedClips(voice: SavedVoice): SavedVoice {
	if (voice.kind === "design") {
		// A prompt has no audio behind it. Anything found here came from a kind
		// flip or a hand edit and would render as clips the voice doesn't have.
		return voice.clips.length === 0 ? voice : { ...voice, clips: [] };
	}
	if (voice.clips.length > 0 || voice.value === "") {
		return voice;
	}
	return {
		...voice,
		// The v1 `value` WAS the one ingested clip, and `seconds` its whole length.
		clips: [
			{
				name: clipBaseName(voice.value),
				path: voice.value,
				seconds: voice.seconds,
			},
		],
	};
}

/** Parse a raw `clips` array element-wise, dropping only the entries that are
 *  unusable. Losing one bad clip must never cost the user the whole voice. */
function salvageClips(raw: unknown): SavedVoiceClip[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.flatMap((entry) => {
		const parsed = savedVoiceClipSchema.safeParse(entry);
		return parsed.success ? [parsed.data] : [];
	});
}

/**
 * Best-effort repair of one persisted entry. A row that lost its optional
 * fields (an older blob, a hand-edited file) is still a perfectly usable named
 * voice — dropping it would silently delete the user's work — so the optional
 * halves are defaulted and only a row with no id/name/kind is unusable.
 */
export function salvageSavedVoice(raw: unknown): SavedVoice | null {
	const direct = savedVoiceSchema.safeParse(raw);
	if (direct.success) {
		return withMigratedClips(direct.data);
	}
	if (typeof raw !== "object" || raw === null) {
		return null;
	}
	const candidate = raw as Record<string, unknown>;
	const id = typeof candidate["id"] === "string" ? candidate["id"] : "";
	const name = typeof candidate["name"] === "string" ? candidate["name"] : "";
	const kind = candidate["kind"] === "design" ? "design" : "clip";
	if (!(id && name)) {
		return null;
	}
	const value = candidate["value"];
	const refText = candidate["refText"];
	const seconds = candidate["seconds"];
	const maxSecs = candidate["maxSecs"];
	return withMigratedClips({
		id,
		name,
		kind,
		value: typeof value === "string" ? value : "",
		refText: typeof refText === "string" ? refText : "",
		seconds: typeof seconds === "number" ? seconds : 0,
		maxSecs: typeof maxSecs === "number" ? maxSecs : 0,
		clips: salvageClips(candidate["clips"]),
	});
}

function isBlob(
	value: unknown,
): value is { version: number; voices: unknown[] } {
	return (
		typeof value === "object" &&
		value !== null &&
		Array.isArray((value as { voices?: unknown }).voices)
	);
}

/** Read + repair the persisted list. Never throws: a blob we cannot understand
 *  at all degrades to an empty library rather than breaking the settings tab. */
function readVoiceLibrary(): SavedVoice[] {
	const blob = readPersistedSelectorState<{
		version: number;
		voices: unknown[];
	}>(STORAGE_KEY, isBlob, { version: BLOB_VERSION, voices: [] });
	const parsed = blobSchema.safeParse(blob);
	if (parsed.success) {
		// The happy path migrates too. `clips` has a zod default, so a v1 blob parses
		// CLEANLY and never reaches the salvage branch — without this the default
		// would quietly hand back a clip voice with no clips, i.e. a voice the new
		// UI shows as empty and a rebuild can no longer reconstruct.
		return parsed.data.voices.map(withMigratedClips);
	}
	const salvaged: SavedVoice[] = [];
	for (const entry of blob.voices) {
		const repaired = salvageSavedVoice(entry);
		if (repaired) {
			salvaged.push(repaired);
		}
	}
	return salvaged;
}

/** Parse + repair a list that arrived from the backend. Same salvage contract as
 *  the mirror: one unusable row must never cost the user the rest of the list. */
function parseVoiceList(raw: readonly unknown[]): SavedVoice[] {
	const out: SavedVoice[] = [];
	for (const entry of raw) {
		const repaired = salvageSavedVoice(entry);
		if (repaired) {
			out.push(repaired);
		}
	}
	return out;
}

function writeMirror(voices: readonly SavedVoice[]): boolean {
	return writePersistedSelectorState(STORAGE_KEY, {
		version: BLOB_VERSION,
		voices,
	});
}

/**
 * Write the authoritative record. Outside a Tauri webview (browser preview, unit
 * tests) there is no backend to write to and the mirror is all there is, so this
 * is a no-op rather than a reported failure.
 *
 * Failures ARE surfaced, through the same `persistFailed` slot the mirror uses:
 * a voice the user just named that did not reach the disk will be gone the next
 * time the web store is cleared, and silently pretending otherwise is exactly
 * the lie this store was built to avoid.
 */
async function persistToDisk(
	voices: readonly SavedVoice[],
	action: VoiceLibraryPersistenceAction,
): Promise<void> {
	if (!hasTauriRuntime()) {
		return;
	}
	try {
		const result = await commands.ttsWriteVoiceLibrary({
			version: BLOB_VERSION,
			voices: voices.map((voice) => ({ ...voice })),
		});
		if (result.status === "error") {
			console.warn("[tts] the voice library could not be saved:", result.error);
			useVoiceLibraryStore.setState({ persistFailed: action });
		}
	} catch (error) {
		console.warn("[tts] the voice library could not be saved:", error);
		useVoiceLibraryStore.setState({ persistFailed: action });
	}
}

function persist(
	voices: readonly SavedVoice[],
	action: VoiceLibraryPersistenceAction,
): boolean {
	const mirrored = writeMirror(voices);
	void persistToDisk(voices, action);
	return mirrored;
}

/**
 * Adopt the on-disk record once it arrives.
 *
 * Three cases, and the middle one is the upgrade path that matters: a library
 * that only ever existed in localStorage (every install before this shipped) has
 * NO file yet, and adopting an empty disk record would delete the user's voices
 * on the first launch after updating. So an empty file with a non-empty mirror
 * means "write the mirror through", not "the list is empty".
 *
 * A mutation that landed while the read was in flight wins outright — the user
 * acting on the list is newer information than the file was.
 */
async function hydrateFromDisk(): Promise<void> {
	if (!hasTauriRuntime()) {
		return;
	}
	const seeded = useVoiceLibraryStore.getState().voices;
	let stored: SavedVoice[];
	try {
		const result = await commands.ttsReadVoiceLibrary();
		if (result.status === "error") {
			return;
		}
		stored = parseVoiceList(result.data.voices);
	} catch {
		// No backend, or the command failed: the mirror stands.
		return;
	}
	if (useVoiceLibraryStore.getState().voices !== seeded) {
		return;
	}
	if (stored.length === 0) {
		if (seeded.length > 0) {
			void persistToDisk(seeded, "save");
		}
		return;
	}
	useVoiceLibraryStore.setState({ voices: stored });
	writeMirror(stored);
}

/** Pure reorder used by the drag-and-drop handle. Mirrors
 *  `reorderSavedConfigurations`: unknown ids and self-drops are no-ops. */
export function reorderSavedVoices(
	voices: readonly SavedVoice[],
	id: string,
	targetId: string,
	placement: VoiceLibraryDropPlacement,
): SavedVoice[] {
	if (id === targetId) {
		return [...voices];
	}
	const source = voices.find((voice) => voice.id === id);
	if (!(source && voices.some((voice) => voice.id === targetId))) {
		return [...voices];
	}
	const withoutSource = voices.filter((voice) => voice.id !== id);
	const targetIndex = withoutSource.findIndex((voice) => voice.id === targetId);
	if (targetIndex < 0) {
		return [...voices];
	}
	const insertIndex = placement === "after" ? targetIndex + 1 : targetIndex;
	return [
		...withoutSource.slice(0, insertIndex),
		source,
		...withoutSource.slice(insertIndex),
	];
}

/** Total length of a voice's clips — what the capacity meter fills against the
 *  model's `maxRefClipSecs`. Clips whose duration was never measured (`0`) or
 *  arrived corrupt contribute nothing instead of poisoning the sum with `NaN`.
 *  Rounded to milliseconds so accumulated float error can never report a voice
 *  sitting exactly ON the cap as being over it. */
export function totalClipSeconds(clips: readonly SavedVoiceClip[]): number {
	let total = 0;
	for (const clip of clips) {
		if (Number.isFinite(clip.seconds) && clip.seconds > 0) {
			total += clip.seconds;
		}
	}
	return Math.round(total * 1000) / 1000;
}

/**
 * What a voice actually COSTS against the model's reference budget: its parts
 * PLUS the silence welded between them.
 *
 * The backend's cap applies to the concatenation, and the concatenation contains
 * `n - 1` gaps of [`REFERENCE_GAP_SECS`] — so summing the parts alone under-reports
 * the usage and promises room that does not exist. Worst where the budget is
 * smallest: on OmniVoice's 5 s, three clips spend 0.5 s (10% of the whole budget)
 * on gaps a parts-only total never counts.
 *
 * Unmeasured clips (a voice restored from a record that never timed them) stay at
 * `0` rather than becoming "0.5 s of gaps": the meter reads a positive total as
 * "measured", and a bar drawn from gaps alone would report a working voice as
 * nearly empty and demand more audio.
 */
export function projectedClipSeconds(clips: readonly SavedVoiceClip[]): number {
	const parts = totalClipSeconds(clips);
	if (parts <= 0) {
		return 0;
	}
	const gaps = REFERENCE_GAP_SECS * Math.max(clips.length - 1, 0);
	// Same millisecond rounding as the parts sum, for the same reason: a voice that
	// exactly fills its budget must not read as over it through float error.
	return Math.round((parts + gaps) * 1000) / 1000;
}

/**
 * Would this voice's cached combined clip be the WRONG audio for an engine whose
 * reference budget is `maxSecs`?
 *
 * This is what lets one upload serve every cloning engine. The parts are stored
 * at the widest budget, so a voice built for Chatterbox (30 s) holds more audio
 * than OmniVoice (5 s) may hear, and a voice built for OmniVoice has a combined
 * clip that throws away 25 s the next engine could have used. Either way the fix
 * is to re-weld from the parts already on disk — never to ask for the file again.
 *
 * Deliberately conservative. It says "yes" only when the two caps would produce
 * DIFFERENT audio: two budgets that both sit above everything the parts hold
 * yield the same whole clip, and re-welding there would churn the disk and the
 * library row for no audible change.
 *
 * `maxSecs` of `0` (the catalog row didn't say) answers `false` — with no target
 * to build for, the clip in hand is the best answer available.
 */
export function voiceNeedsRebuild(
	voice: SavedVoiceValue,
	maxSecs: number,
): boolean {
	if (voice.kind === "design" || maxSecs <= 0) {
		return false;
	}
	// Nothing to rebuild FROM. A voice restored from a record that predates the
	// part list, or one whose parts were deleted, has only its combined clip —
	// re-welding would fail, and using what exists is strictly better.
	if (voice.clips.length === 0) {
		return false;
	}
	// Never welded by a build that recorded its budget (an entry saved before
	// voices were shared): rebuild once to find out, which is also the direction
	// that self-heals a combined file that is missing from disk.
	if (voice.maxSecs <= 0) {
		return true;
	}
	if (voice.maxSecs === maxSecs) {
		return false;
	}
	const total = projectedClipSeconds(voice.clips);
	// Unmeasured durations (a restored voice whose clips were never timed) cannot
	// answer the question; leave the clip alone rather than churn on a guess.
	if (total <= 0) {
		return false;
	}
	return Math.min(total, voice.maxSecs) !== Math.min(total, maxSecs);
}

/**
 * Every file on disk the given voices still name — their parts AND the combined
 * clip welded from them.
 *
 * Deleting a voice may NOT simply unlink everything it lists: stored clip names
 * are content-addressed (the backend hashes source path + size + mtime), so the
 * same take picked for two voices resolves to the SAME managed file, and a
 * single-part build stores the part itself as the combined clip. Unlinking a
 * file another voice still lists leaves that voice pointing at nothing — its
 * next rebuild fails outright, because a path that no longer exists can no
 * longer be confined to the managed folder.
 *
 * A `design` voice names no audio at all: its value is prose.
 */
export function referencedClipPaths(
	voices: readonly SavedVoiceValue[],
): Set<string> {
	const paths = new Set<string>();
	for (const voice of voices) {
		if (voice.kind === "design") {
			continue;
		}
		for (const path of [voice.value, ...voice.clips.map((clip) => clip.path)]) {
			const trimmed = path.trim();
			if (trimmed.length > 0) {
				paths.add(trimmed);
			}
		}
	}
	return paths;
}

/**
 * Which of the files a rebuild REPLACED are now unreachable, and may therefore
 * leave the disk.
 *
 * Every clip added to or removed from a voice welds a NEW combined WAV, and a
 * removed part stops being named by anything — so without this the managed folder
 * grows on every single edit, which is exactly the leak the delete command was
 * written to close.
 *
 * `retained` is everything that still has a claim: the whole saved library AND the
 * live (possibly unsaved) voice as it stands AFTER the rebuild. Both halves are
 * load-bearing. Stored part names are content-addressed — the same take picked for
 * two voices resolves to the SAME managed file, and a single-part build stores the
 * part itself as the combined clip — so unlinking a path any survivor still names
 * would leave that voice pointing at nothing, and its next rebuild would fail
 * outright (a path that no longer exists can no longer be confined to the managed
 * folder).
 *
 * Deduplicated, because a voice can legitimately name the same file twice.
 */
export function supersededClipPaths(input: {
	/** Every stored file the voice owned BEFORE the rebuild. */
	previous: readonly string[];
	retained: readonly SavedVoiceValue[];
}): string[] {
	const keep = referencedClipPaths(input.retained);
	const out = new Set<string>();
	for (const raw of input.previous) {
		const path = raw.trim();
		if (path.length > 0 && !keep.has(path)) {
			out.add(path);
		}
	}
	return [...out];
}

/** Drop one clip by position, returning a new array. An out-of-range or
 *  non-integer index is a no-op copy: a stale index from a list that re-rendered
 *  mid-gesture must never silently remove the wrong clip or truncate the array. */
export function removeClipAt(
	clips: readonly SavedVoiceClip[],
	index: number,
): SavedVoiceClip[] {
	if (!Number.isInteger(index) || index < 0 || index >= clips.length) {
		return [...clips];
	}
	return [...clips.slice(0, index), ...clips.slice(index + 1)];
}

/** True when `entry` holds exactly what `voice` stores — drives the dirty
 *  (save/reset) row actions. `seconds` is deliberately excluded: it is
 *  descriptive metadata, not part of the voice's identity.
 *
 *  `clips` is excluded for the same reason, plus a stronger one: `value` is
 *  DERIVED from the clips (they are concatenated into it), so comparing `value`
 *  already covers every change that can alter the voice. Including the list
 *  would only add false positives — re-ingesting the same audio produces a fresh
 *  normalized copy under a new path, and a rename changes a label — each of
 *  which would mark an identical-sounding voice dirty. */
export function savedVoiceMatches(
	entry: SavedVoice,
	value: SavedVoiceValue,
): boolean {
	return (
		entry.kind === value.kind &&
		entry.value === value.value &&
		entry.refText === value.refText
	);
}

interface VoiceLibraryState {
	activeVoiceId: string | null;
	clearPersistError: () => void;
	moveVoice: (
		id: string,
		targetId: string,
		placement: VoiceLibraryDropPlacement,
	) => void;
	/** Set when the last mutation could not be written to localStorage. */
	persistFailed: VoiceLibraryPersistenceAction | null;
	removeVoice: (id: string) => void;
	/** Adds a named entry and makes it active. Returns its id. */
	saveVoice: (name: string, value: SavedVoiceValue) => string;
	setActiveVoice: (id: string | null) => void;
	/** Replace an entry's stored value in place (the dirty row's Save action). */
	updateVoice: (id: string, value: SavedVoiceValue) => void;
	voices: SavedVoice[];
}

export const useVoiceLibraryStore = create<VoiceLibraryState>()((set, get) => ({
	voices: readVoiceLibrary(),
	activeVoiceId: null,
	persistFailed: null,
	clearPersistError: () => set({ persistFailed: null }),
	saveVoice: (name, value) => {
		const entry: SavedVoice = { ...value, id: generateId(), name };
		const next = [...get().voices, entry];
		const ok = persist(next, "save");
		set({
			voices: next,
			// A write that never landed must not be reported as the active saved
			// voice — the row would claim a persistence that doesn't exist.
			activeVoiceId: ok ? entry.id : get().activeVoiceId,
			persistFailed: ok ? null : "save",
		});
		return entry.id;
	},
	updateVoice: (id, value) => {
		const next = get().voices.map((voice) =>
			voice.id === id ? { ...voice, ...value } : voice,
		);
		const ok = persist(next, "update");
		set({ voices: next, persistFailed: ok ? null : "update" });
	},
	removeVoice: (id) => {
		const next = get().voices.filter((voice) => voice.id !== id);
		const ok = persist(next, "delete");
		set({
			voices: next,
			activeVoiceId: get().activeVoiceId === id ? null : get().activeVoiceId,
			persistFailed: ok ? null : "delete",
		});
	},
	moveVoice: (id, targetId, placement) => {
		const next = reorderSavedVoices(get().voices, id, targetId, placement);
		const ok = persist(next, "reorder");
		set({ voices: next, persistFailed: ok ? null : "reorder" });
	},
	setActiveVoice: (id) => set({ activeVoiceId: id }),
}));

// Cross-window mirror: the settings window and the detached model picker each
// own a renderer, so a voice saved in one must appear in the other. `storage`
// only fires in OTHER documents, so re-reading here cannot loop.
if (typeof window !== "undefined") {
	window.addEventListener("storage", (event) => {
		if (event.key !== null && event.key !== STORAGE_KEY) {
			return;
		}
		useVoiceLibraryStore.setState({ voices: readVoiceLibrary() });
	});
	// The store was seeded synchronously from the mirror so the row paints
	// immediately; the authoritative list replaces it as soon as the backend
	// answers. Fire-and-forget by design — nothing waits on the voices, and a
	// failure just leaves the mirror in place.
	void hydrateFromDisk();
	// "Remove Voices" in the About tab deletes the clips AND the library file. The
	// mirror would otherwise outlive them — and, worse, be written back to disk by
	// the very hydration above on the next launch, resurrecting a list of names
	// whose audio is gone.
	onAppDataCategoryRemoved("voices", () => {
		useVoiceLibraryStore.setState({ activeVoiceId: null, voices: [] });
		// Writes the empty mirror, which is what tells a second window (the
		// detached picker) that the list is gone.
		writeMirror([]);
	});
}
