import { describe, expect, test } from "bun:test";
import type { SoundLibraryEntry } from "@/shared/config/settings-schema";
import { defaultItem, entryToItem, isActive, type SoundLibraryItem } from "./recording-sound";

// The stable id the module assigns to the implicit "default" row. It is never
// persisted, but the picker relies on it being constant + distinctive so the
// default row can be found/keyed without colliding with a real custom entry id.
const DEFAULT_SOUND_ID = "__winstt_default__";

describe("defaultItem", () => {
	test("produces a virtual default row: magic id, isDefault=true, empty path", () => {
		const item = defaultItem("System default");
		expect(item).toEqual({
			id: DEFAULT_SOUND_ID,
			isDefault: true,
			name: "System default",
			path: "",
		});
	});

	test("threads the provided name through verbatim (no normalization)", () => {
		expect(defaultItem("  Padded Name  ").name).toBe("  Padded Name  ");
		expect(defaultItem("").name).toBe("");
	});

	test("always uses the same constant id regardless of name", () => {
		expect(defaultItem("a").id).toBe(defaultItem("b").id);
		expect(defaultItem("a").id).toBe(DEFAULT_SOUND_ID);
	});

	test("default item always carries an empty path (the virtual-row invariant)", () => {
		expect(defaultItem("whatever").path).toBe("");
	});
});

describe("entryToItem", () => {
	test("maps a persisted library entry onto a non-default item, copying id/name/path", () => {
		const entry: SoundLibraryEntry = {
			id: "abc-123",
			name: "Chime",
			path: "C:/Users/me/AppData/sounds/chime.wav",
		};
		expect(entryToItem(entry)).toEqual({
			id: "abc-123",
			isDefault: false,
			name: "Chime",
			path: "C:/Users/me/AppData/sounds/chime.wav",
		});
	});

	test("custom entries are NEVER flagged default, even if their path is empty", () => {
		// Defends the invariant that "default-ness" is structural (this function
		// hard-codes false), not inferred from path/id. A mutant flipping this to
		// `true` or to a path-derived value would be caught here.
		const entry: SoundLibraryEntry = { id: "x", name: "n", path: "" };
		expect(entryToItem(entry).isDefault).toBe(false);
	});

	test("a custom entry that happens to reuse the magic default id stays isDefault=false", () => {
		const entry: SoundLibraryEntry = {
			id: DEFAULT_SOUND_ID,
			name: "Impostor",
			path: "C:/x.wav",
		};
		expect(entryToItem(entry).isDefault).toBe(false);
		expect(entryToItem(entry).id).toBe(DEFAULT_SOUND_ID);
	});
});

describe("isActive", () => {
	test("default item is active only when no custom sound is selected (activePath is empty)", () => {
		const def = defaultItem("System default");
		expect(isActive(def, "")).toBe(true);
		expect(isActive(def, "C:/sounds/chime.wav")).toBe(false);
	});

	test("default item ignores its own path field and keys solely on activePath===''", () => {
		// defaultItem always has path "", but assert the branch keys on activePath,
		// not on item.path equality, by handing it a (degenerate) default item with
		// a non-empty path and a non-empty activePath that matches it.
		const weirdDefault: SoundLibraryItem = {
			id: DEFAULT_SOUND_ID,
			isDefault: true,
			name: "x",
			path: "C:/match.wav",
		};
		// Paths are equal, but because it's the default item the comparison is
		// activePath==="" — which is false here. Catches a mutant that falls
		// through to the path-equality branch for default items.
		expect(isActive(weirdDefault, "C:/match.wav")).toBe(false);
		expect(isActive(weirdDefault, "")).toBe(true);
	});

	test("custom item is active iff its path exactly equals activePath", () => {
		const item = entryToItem({ id: "1", name: "Chime", path: "C:/a.wav" });
		expect(isActive(item, "C:/a.wav")).toBe(true);
		expect(isActive(item, "C:/b.wav")).toBe(false);
	});

	test("custom path match is exact (no trimming, case-sensitive, no separator normalization)", () => {
		const item = entryToItem({ id: "1", name: "Chime", path: "C:/a.wav" });
		expect(isActive(item, " C:/a.wav")).toBe(false);
		expect(isActive(item, "c:/a.wav")).toBe(false);
		expect(isActive(item, "C:\\a.wav")).toBe(false);
	});

	test("a custom item with an empty path is active only when activePath is also empty", () => {
		// This is the boundary where custom-path logic overlaps the default's
		// activePath==="" rule: a non-default item with path "" matches "" by
		// path-equality. Documents/locks the current behavior.
		const item = entryToItem({ id: "1", name: "n", path: "" });
		expect(isActive(item, "")).toBe(true);
		expect(isActive(item, "C:/a.wav")).toBe(false);
	});

	test("integration: among a default + customs list, exactly one is active for a given path", () => {
		const def = defaultItem("System default");
		const a = entryToItem({ id: "1", name: "A", path: "C:/a.wav" });
		const b = entryToItem({ id: "2", name: "B", path: "C:/b.wav" });

		const activeFor = (activePath: string) => [def, a, b].filter((it) => isActive(it, activePath));

		expect(activeFor("")).toEqual([def]);
		expect(activeFor("C:/b.wav")).toEqual([b]);
		expect(activeFor("C:/missing.wav")).toEqual([]);
	});
});
