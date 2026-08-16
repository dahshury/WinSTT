import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createTranslator } from "use-intl/core";
import en from "../../../../messages/en.json";
import {
	CLONE_CLIP_EXTENSIONS,
	clipBaseName,
	clipSeconds,
	hasCloneClipExtension,
	isAuthoredVoice,
	isCloneClipPath,
	MAX_VOICE_CLIPS,
	MIN_REF_CLIP_SECS,
	needsReferenceTranscript,
	REFERENCE_GAP_SECS,
	unmetClipRequirement,
	voiceCapacityState,
} from "./clone-voice";

describe("hasCloneClipExtension", () => {
	test("accepts every container the backend decoder handles", () => {
		for (const ext of CLONE_CLIP_EXTENSIONS) {
			expect(hasCloneClipExtension(`voice.${ext}`)).toBe(true);
			expect(hasCloneClipExtension(`voice.${ext.toUpperCase()}`)).toBe(true);
		}
	});

	test("refuses anything else, including extensionless names", () => {
		expect(hasCloneClipExtension("notes.pdf")).toBe(false);
		expect(hasCloneClipExtension("recording")).toBe(false);
		// A directory dot must not be mistaken for an extension.
		expect(hasCloneClipExtension("C:/my.voices/recording")).toBe(false);
	});
});

describe("clipBaseName", () => {
	test("strips both separators so a Windows path displays as a file name", () => {
		expect(clipBaseName("C:\\Users\\me\\clips\\narrator.wav")).toBe(
			"narrator.wav",
		);
		expect(clipBaseName("/home/me/clips/narrator.wav")).toBe("narrator.wav");
	});

	test("leaves a bare name untouched", () => {
		expect(clipBaseName("narrator.wav")).toBe("narrator.wav");
	});
});

describe("isCloneClipPath", () => {
	test("recognizes a stored clip path", () => {
		expect(isCloneClipPath("C:\\AppData\\tts\\reference-voices\\a-1.wav")).toBe(
			true,
		);
		expect(isCloneClipPath("/var/app/tts/reference-voices/a-1.wav")).toBe(true);
		expect(isCloneClipPath("narrator.mp3")).toBe(true);
	});

	test("does NOT treat a preset voice id as a clip", () => {
		// `settings.tts.voice` is overloaded and survives a model swap untouched:
		// a Kokoro voice id left behind by the previous model must read as "no
		// clip", not as a broken clip card.
		expect(isCloneClipPath("af_heart")).toBe(false);
		expect(isCloneClipPath("default")).toBe(false);
		expect(isCloneClipPath("female")).toBe(false);
		expect(isCloneClipPath("")).toBe(false);
		expect(isCloneClipPath("   ")).toBe(false);
	});

	test("does NOT treat a voice-design prompt as a clip", () => {
		expect(isCloneClipPath("a warm, low-pitched narrator")).toBe(false);
	});
});

describe("isAuthoredVoice", () => {
	const prompt =
		"A deep, gravelly middle-aged American man speaking in a low, controlled near-whisper.";

	test("protects a voice-design model's prompt from the catalog self-heal", () => {
		// The regression: a voice-design row is `cloning: none`, so the clip-path
		// guard never fired for it, and its catalog DOES return a voice (one entry
		// whose id is the empty string). The heal then wrote `voice: ""` on every
		// remount — settings tab switch, settings-window open, app restart —
		// destroying the user's prompt with no error and no undo.
		expect(
			isAuthoredVoice({
				isCloningModel: false,
				isVoiceDesignModel: true,
				voice: prompt,
			}),
		).toBe(true);
		// An empty prompt is the valid default, and still must not be "healed" to
		// some preset id.
		expect(
			isAuthoredVoice({
				isCloningModel: false,
				isVoiceDesignModel: true,
				voice: "",
			}),
		).toBe(true);
	});

	test("still protects a cloning model's reference-clip path", () => {
		expect(
			isAuthoredVoice({
				isCloningModel: true,
				isVoiceDesignModel: false,
				voice: "C:/appdata/tts/reference-voices/narrator-1a.wav",
			}),
		).toBe(true);
	});

	test("leaves a stale preset id healable on every other model", () => {
		expect(
			isAuthoredVoice({
				isCloningModel: false,
				isVoiceDesignModel: false,
				voice: "af_heart",
			}),
		).toBe(false);
		// A cloning model whose voice is a leftover preset id, not a clip.
		expect(
			isAuthoredVoice({
				isCloningModel: true,
				isVoiceDesignModel: false,
				voice: "af_heart",
			}),
		).toBe(false);
	});
});

describe("needsReferenceTranscript", () => {
	const clip = "C:/appdata/tts/reference-voices/narrator-1a.wav";
	const owed = {
		busy: false,
		cloneRefText: "",
		needsRefText: true,
		ttsEnabled: true,
		voice: clip,
	};

	test("a clip that arrived without its transcript still owes one", () => {
		// Dropped under a clip-only cloner, then Spark selected: `cloneRefText` is
		// empty and nothing else would ever fill it, so Spark would clone against
		// an EMPTY reference transcript.
		expect(needsReferenceTranscript(owed)).toBe(true);
		// Whitespace is not a transcript.
		expect(needsReferenceTranscript({ ...owed, cloneRefText: "   " })).toBe(
			true,
		);
	});

	test("asks for nothing once a transcript is present", () => {
		expect(
			needsReferenceTranscript({ ...owed, cloneRefText: "hello there" }),
		).toBe(false);
	});

	test("asks for nothing when the engine does not clone from a transcript", () => {
		expect(needsReferenceTranscript({ ...owed, needsRefText: false })).toBe(
			false,
		);
	});

	test("asks for nothing without a clip, or while one is being prepared", () => {
		expect(needsReferenceTranscript({ ...owed, voice: "female" })).toBe(false);
		expect(needsReferenceTranscript({ ...owed, busy: true })).toBe(false);
	});

	test("spends no STT run while read-aloud is switched off", () => {
		expect(needsReferenceTranscript({ ...owed, ttsEnabled: false })).toBe(
			false,
		);
	});
});

describe("unmetClipRequirement", () => {
	// Moved here from the deleted `CloneVoiceField`; it is pure and now lives with
	// the other cloning helpers. Mirrors the two guards in
	// `Audio8LocalEngine::synthesize_sentence` — the clip first, then the
	// transcript — so the warning names what the engine would refuse on.
	const audio8 = {
		hasClip: false,
		needsRefText: true,
		refText: "",
		requiresClip: true,
	};

	test("names the clip first, then the transcript", () => {
		expect(unmetClipRequirement(audio8)).toBe("clip");
		expect(unmetClipRequirement({ ...audio8, hasClip: true })).toBe("refText");
	});

	test("whitespace is not a transcript", () => {
		expect(
			unmetClipRequirement({ ...audio8, hasClip: true, refText: "   \n " }),
		).toBe("refText");
	});

	test("asks for nothing once both are present", () => {
		expect(
			unmetClipRequirement({ ...audio8, hasClip: true, refText: "hello" }),
		).toBeNull();
	});

	test("asks for nothing from an engine that clones from the clip alone", () => {
		expect(
			unmetClipRequirement({
				...audio8,
				hasClip: true,
				needsRefText: false,
			}),
		).toBeNull();
	});

	test("stays silent for every engine that ships a usable voice", () => {
		// True for every catalog row but `audio8-tts-0.6b`.
		expect(unmetClipRequirement({ ...audio8, requiresClip: false })).toBeNull();
	});
});

describe("voiceCapacityState", () => {
	test("below the engine's floor a voice cannot be built at all", () => {
		expect(voiceCapacityState(0, 30)).toBe("belowMinimum");
		expect(voiceCapacityState(MIN_REF_CLIP_SECS - 0.01, 30)).toBe(
			"belowMinimum",
		);
		// A corrupt sum must not read as a usable voice.
		expect(voiceCapacityState(Number.NaN, 30)).toBe("belowMinimum");
	});

	test("exactly on the floor is usable", () => {
		expect(voiceCapacityState(MIN_REF_CLIP_SECS, 30)).toBe("room");
	});

	test("at or over the cap the next clip loses its tail", () => {
		expect(voiceCapacityState(30, 30)).toBe("atCapacity");
		expect(voiceCapacityState(31, 30)).toBe("atCapacity");
		// The cap is per-model: OmniVoice's 5s budget fills five times sooner.
		expect(voiceCapacityState(5, 5)).toBe("atCapacity");
		expect(voiceCapacityState(5, 30)).toBe("room");
	});

	test("an unknown cap makes 'full' unreachable", () => {
		// `maxSecs: 0` = the catalog row didn't say, so there is nothing to be full
		// OF — only the floor can still be reported.
		expect(voiceCapacityState(120, 0)).toBe("room");
		expect(voiceCapacityState(0.5, 0)).toBe("belowMinimum");
	});
});

describe("mirrored backend constants", () => {
	// The three cloning numbers the renderer needs but no catalog row or command
	// result carries (unlike the cap, which arrives per-model as `maxRefClipSecs`).
	// They are mirrored ONCE, in `clone-voice.ts` — and a hand-mirrored constant is
	// only safe while something fails when the original moves, so these read the
	// RUST source and compare. Same technique as `shared/api/emit-coverage.test.ts`,
	// which holds the event-name contract across the same boundary.
	const SRC_TAURI = join(
		import.meta.dir,
		"..",
		"..",
		"..",
		"..",
		"src-tauri",
		"src",
	);

	function rustConstant(relPath: string, name: string): string {
		const source = readFileSync(join(SRC_TAURI, relPath), "utf8");
		const found = new RegExp(
			`const ${name}: [A-Za-z0-9_]+ = ([^;]+);`,
			"u",
		).exec(source);
		expect(
			found?.[1],
			`${name} is gone from ${relPath} — the TS mirror in clone-voice.ts now stands for nothing`,
		).toBeDefined();
		return (found?.[1] ?? "").trim().replace(/_/gu, "");
	}

	test("MIN_REF_CLIP_SECS tracks catalog::MIN_CLONE_REF_SECS", () => {
		expect(MIN_REF_CLIP_SECS).toBe(1);
		expect(
			Number(rustConstant("winstt/tts/catalog.rs", "MIN_CLONE_REF_SECS")),
		).toBe(MIN_REF_CLIP_SECS);
	});

	test("MAX_VOICE_CLIPS tracks tts_voice::MAX_REFERENCE_PARTS", () => {
		expect(MAX_VOICE_CLIPS).toBe(12);
		expect(
			Number(
				rustConstant("winstt/commands/tts_voice.rs", "MAX_REFERENCE_PARTS"),
			),
		).toBe(MAX_VOICE_CLIPS);
	});

	test("REFERENCE_GAP_SECS tracks tts_voice::REFERENCE_GAP_SECS", () => {
		// The one with a USER-VISIBLE consequence: the capacity meter spends this
		// per gap, so a drift here silently makes the meter over-promise again.
		expect(REFERENCE_GAP_SECS).toBe(0.25);
		expect(
			Number(
				rustConstant("winstt/commands/tts_voice.rs", "REFERENCE_GAP_SECS"),
			),
		).toBe(REFERENCE_GAP_SECS);
	});
});

describe("clipSeconds", () => {
	test("hands the raw duration through — rounding is ICU's job, not ours", () => {
		expect(clipSeconds(30)).toBe(30);
		expect(clipSeconds(12.44)).toBe(12.44);
	});

	test("degrades to 0 for unknown/absurd values instead of rendering NaN", () => {
		expect(clipSeconds(0)).toBe(0);
		expect(clipSeconds(-3)).toBe(0);
		expect(clipSeconds(Number.NaN)).toBe(0);
	});

	test("the messages it feeds round AND localize the separator", () => {
		// The regression this replaced `formatClipSeconds` for: a hand-built string
		// carried a "." into every locale, so half of Europe read "12.4 s" where its
		// own number system writes "12,4 s". Asserted through the REAL en.json
		// messages, so a key that loses its `number` type fails here.
		const render = (locale: string, seconds: number): string =>
			(
				createTranslator({
					locale,
					messages: en,
					namespace: "tts",
				}) as unknown as (k: string, v: Record<string, number>) => string
			)("cloneClipDuration", { seconds: clipSeconds(seconds) });

		// One decimal only when it carries information — what `formatClipSeconds` did.
		expect(render("en", 30)).toBe("30s");
		expect(render("en", 12.44)).toBe("12.4s");
		expect(render("en", 12.96)).toBe("13s");
		// …and the separator the reader's locale actually uses.
		expect(render("de", 12.44)).toBe("12,4s");
		expect(render("fr", 12.44)).toBe("12,4s");
		expect(render("ru", 12.44)).toBe("12,4s");
	});
});
