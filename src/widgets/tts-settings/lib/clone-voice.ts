/**
 * Pure helpers for the voice-cloning reference clip.
 *
 * `settings.tts.voice` is overloaded three ways (preset voice id, voice-design
 * prompt, reference-clip path) and switching models reinterprets whatever
 * string is already in it — a Kokoro voice id like `af_heart` survives a swap
 * to Chatterbox untouched. Everything here therefore READS that field
 * defensively instead of assuming the previous model left something sane.
 */

/**
 * Audio containers the backend's reference-clip decoder handles (symphonia:
 * wav/mp3/m4a/mp4/flac/ogg/aac). ONE list, shared by the file-dialog filter and
 * the drag-drop guard, so a format the dialog offers can never be refused by the
 * drop target.
 */
export const CLONE_CLIP_EXTENSIONS = [
	"wav",
	"mp3",
	"flac",
	"m4a",
	"mp4",
	"ogg",
	"aac",
] as const;

/**
 * Shortest reference a cloning engine accepts, in seconds.
 *
 * MIRROR of `catalog::MIN_CLONE_REF_SECS` — the backend REJECTS anything below
 * it, and that constant is not on any catalog row the renderer can read (unlike
 * the cap, which arrives per-model as `maxRefClipSecs`). Kept here, once, so the
 * capacity meter can mark the floor without a second copy appearing in a
 * component. If the Rust constant moves, this moves with it.
 */
export const MIN_REF_CLIP_SECS = 1;

/**
 * How many source clips one voice may be welded from.
 *
 * MIRROR of `tts_voice::MAX_REFERENCE_PARTS`. The backend refuses past it with
 * its own prose, so this exists only to refuse a 40-file drop instantly instead
 * of decoding 40 files to learn the same thing. Same rule as above: one copy,
 * next to the other cloning constants, never inside a component.
 */
export const MAX_VOICE_CLIPS = 12;

/**
 * Silence welded BETWEEN consecutive parts of a multi-clip voice, in seconds.
 *
 * MIRROR of `tts_voice::REFERENCE_GAP_SECS`. It costs real budget — the model's
 * cap applies to the parts plus the gaps between them — so anything reasoning
 * about whether a voice fits a given cap has to spend it too. Same rule as the
 * constants above: one copy, here, never inside a component.
 */
export const REFERENCE_GAP_SECS = 0.25;

const EXTENSION_RE = /\.([^./\\]+)$/;

function extensionOf(pathOrName: string): string {
	return EXTENSION_RE.exec(pathOrName)?.[1]?.toLowerCase() ?? "";
}

export function hasCloneClipExtension(pathOrName: string): boolean {
	const ext = extensionOf(pathOrName);
	return (CLONE_CLIP_EXTENSIONS as readonly string[]).includes(ext);
}

/** Last path segment, for displaying a clip without its directory. Handles both
 *  separators because the stored path is produced by the OS, not the renderer. */
export function clipBaseName(path: string): string {
	const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return cut >= 0 ? path.slice(cut + 1) : path;
}

/**
 * Does `voice` name a reference clip rather than one of the engine's preset
 * voices? True only for a value that actually looks like a file path — a
 * directory separator or a known audio extension. A leftover preset id from
 * another model (`af_heart`) is neither, so it correctly reads as "no clip"
 * instead of being displayed as a broken clip card.
 */
export function isCloneClipPath(voice: string): boolean {
	const trimmed = voice.trim();
	if (trimmed.length === 0) {
		return false;
	}
	if (trimmed.includes("/") || trimmed.includes("\\")) {
		return true;
	}
	return hasCloneClipExtension(trimmed);
}

/**
 * Is `settings.tts.voice` currently holding something the USER authored, rather
 * than one of the engine's catalog voice ids?
 *
 * Two engine families overload that one field: a cloning engine stores the
 * reference-clip PATH, and a voice-design engine stores the free-text PROMPT.
 * Neither value is ever in the engine's voice catalog, so the catalog hook's
 * stale-voice self-heal must leave BOTH alone — healing an authored value
 * silently destroys the user's clip or their written prompt on the next catalog
 * fetch, which happens on every remount (settings tab switch, settings-window
 * open, app restart).
 *
 * A voice-design model is protected unconditionally: its prompt is free text, so
 * there is no way to tell a short prompt from a leftover preset id, and losing
 * authored text is far worse than carrying a stale one the user can see and
 * overwrite in the Design-voice dialog.
 */
export function isAuthoredVoice(input: {
	isCloningModel: boolean;
	isVoiceDesignModel: boolean;
	voice: string;
}): boolean {
	if (input.isVoiceDesignModel) {
		return true;
	}
	return input.isCloningModel && isCloneClipPath(input.voice);
}

/**
 * Does the reference clip currently in effect still owe us its transcript?
 *
 * The transcript is a property of the CLIP, not of the gesture that adopted it:
 * a clip can arrive from a model switch (dropped under Chatterbox, then Spark is
 * selected) or from a saved library entry captured under an engine that needed
 * no transcript. Both leave `cloneRefText` empty while the selected engine
 * clones from clip + transcript, and Spark then prepends the reference's
 * semantic tokens with no matching text — the exact misalignment the transcript
 * exists to prevent.
 */
export function needsReferenceTranscript(input: {
	/** A prepare/transcribe round-trip is already running. */
	busy: boolean;
	cloneRefText: string;
	/** The selected engine clones from clip + transcript (`spark-tts-0.5b`). */
	needsRefText: boolean;
	/** Read-aloud is on. Deriving the transcript runs the STT model, so it is
	 *  never spent on a feature that is currently switched off — merely opening
	 *  the tab must not load a model. */
	ttsEnabled: boolean;
	voice: string;
}): boolean {
	return (
		input.needsRefText &&
		input.ttsEnabled &&
		!input.busy &&
		isCloneClipPath(input.voice) &&
		input.cloneRefText.trim().length === 0
	);
}

/**
 * What is still missing before a clip-only engine can synthesize anything.
 *
 * Mirrors the two guards in `Audio8LocalEngine::synthesize_sentence` — the clip
 * first, then the transcript — so the warning names the same thing the engine
 * would refuse on, in the same order. Returns `null` for every engine that ships
 * a usable voice (`requiresClip: false`), which is all of them but Audio8 today.
 */
export function unmetClipRequirement({
	hasClip,
	needsRefText,
	refText,
	requiresClip,
}: {
	hasClip: boolean;
	needsRefText: boolean;
	refText: string;
	requiresClip: boolean;
}): "clip" | "refText" | null {
	if (!requiresClip) {
		return null;
	}
	if (!hasClip) {
		return "clip";
	}
	return needsRefText && refText.trim().length === 0 ? "refText" : null;
}

/**
 * Where a voice sits against this model's reference budget.
 *
 * Three states, because they call for three different sentences: below the
 * engine's floor the voice cannot be built at all, at/over the cap the next clip
 * loses its tail, and in between the only useful number is what is left.
 *
 * `maxSecs` of `0` means the catalog row didn't say — no cap is known, so
 * "at capacity" is unreachable and only the floor can be reported.
 */
export type VoiceCapacityState = "atCapacity" | "belowMinimum" | "room";

export function voiceCapacityState(
	usedSecs: number,
	maxSecs: number,
): VoiceCapacityState {
	if (!(Number.isFinite(usedSecs) && usedSecs >= MIN_REF_CLIP_SECS)) {
		return "belowMinimum";
	}
	return maxSecs > 0 && usedSecs >= maxSecs ? "atCapacity" : "room";
}

/**
 * A measured duration, made safe to hand to `t()` AS A NUMBER.
 *
 * Deliberately NOT a formatter. Rendering the number is ICU's job — the messages
 * that carry a duration declare `{…, number, ::.#}`, which drops the decimal when
 * it carries no information (`30`, not `30.0`) AND writes the separator the
 * reader's locale uses. Formatting here instead produced a `.` for every locale
 * on earth, so half of them (de, fr, es, it, pt, ru, uk, pl, cs, bg, sv, tr, vi)
 * read "12.4 s" where their own number system says "12,4 s", and ar/hi never got
 * their own digits.
 *
 * What is left is the part ICU cannot do: an unmeasured (`0`), corrupt (`NaN`) or
 * negative duration must read as `0` rather than as the literal text "NaN".
 */
export function clipSeconds(seconds: number): number {
	return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}
