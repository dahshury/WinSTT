import { describe, expect, test } from "bun:test";
import type { TtsModelInfo } from "@/entities/tts-catalog";
import { deriveInlineTagsGate } from "./inline-tags-gate";

type TagRow = Pick<TtsModelInfo, "tagSyntax" | "tags">;

// The two shipped vocabularies, written the way the CATALOG carries them: BARE
// names plus a syntax. The delimiters below appear only in the expectations, as
// the thing the gate must produce — never as an input.
const ORPHEUS: TagRow = { tagSyntax: "angle", tags: ["laugh", "sigh", "gasp"] };
const TURBO: TagRow = { tagSyntax: "square", tags: ["laugh", "cough"] };
const KOKORO: TagRow = { tagSyntax: "none", tags: [] };

describe("deriveInlineTagsGate", () => {
	test("renders each engine's vocabulary in ITS OWN delimiters", () => {
		expect(
			deriveInlineTagsGate({
				cloud: false,
				model: ORPHEUS,
				postProcessingReady: true,
			}),
		).toEqual({
			blockedBy: null,
			supported: true,
			tagList: "<laugh> <sigh> <gasp>",
		});
		// Same flag, same code path, incompatible syntax — a `[laugh]` fed to
		// Orpheus (or `<laugh>` to Turbo) is SPOKEN, not ignored.
		expect(
			deriveInlineTagsGate({
				cloud: false,
				model: TURBO,
				postProcessingReady: true,
			}).tagList,
		).toBe("[laugh] [cough]");
	});

	test("an engine with no vocabulary is unsupported, not merely blocked", () => {
		const gate = deriveInlineTagsGate({
			cloud: false,
			model: KOKORO,
			postProcessingReady: true,
		});
		expect(gate.supported).toBe(false);
		expect(gate.blockedBy).toBe("unsupported");
		expect(gate.tagList).toBe("");
	});

	test("a half-filled catalog row counts as no vocabulary either way round", () => {
		// Defensive: `tagSyntax` and `tags` default independently in the store, so
		// a partially-populated row must not produce bare, delimiter-less tags.
		expect(
			deriveInlineTagsGate({
				cloud: false,
				model: { tagSyntax: "angle", tags: [] },
				postProcessingReady: true,
			}).supported,
		).toBe(false);
		expect(
			deriveInlineTagsGate({
				cloud: false,
				model: { tagSyntax: "none", tags: ["laugh"] },
				postProcessingReady: true,
			}).supported,
		).toBe(false);
	});

	test("supported but blocked while post-processing can't run", () => {
		const gate = deriveInlineTagsGate({
			cloud: false,
			model: ORPHEUS,
			postProcessingReady: false,
		});
		// Still SUPPORTED: the row stays visible and disabled so the user can find
		// out what turns it on, instead of the capability vanishing.
		expect(gate.supported).toBe(true);
		expect(gate.blockedBy).toBe("post-processing");
		expect(gate.tagList).toBe("<laugh> <sigh> <gasp>");
	});

	test("the cloud source has no catalog row to take a vocabulary from", () => {
		// `model` still resolves (the local selection is remembered), but the cloud
		// provider would read the delimiters out loud — mirrors the backend hook,
		// which annotates only while `tts.source` is local.
		expect(
			deriveInlineTagsGate({
				cloud: true,
				model: ORPHEUS,
				postProcessingReady: true,
			}).supported,
		).toBe(false);
	});

	test("no row at all (catalog still loading) offers nothing", () => {
		expect(
			deriveInlineTagsGate({
				cloud: false,
				model: undefined,
				postProcessingReady: true,
			}).supported,
		).toBe(false);
	});
});
