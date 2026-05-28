import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Mock the store module so initPostProcessing can read from a controllable shape.
const storeData: Record<string, unknown> = {};
const onDidChangeListeners = new Map<string, Array<() => void>>();

function setStoreValue(key: string, value: unknown) {
	storeData[key] = value;
	for (const cb of onDidChangeListeners.get(key) ?? []) {
		cb();
	}
}

const mockStore = {
	get: (key: string) => storeData[key],
	set: (key: string, value: unknown) => setStoreValue(key, value),
	onDidChange: (key: string, cb: () => void) => {
		const list = onDidChangeListeners.get(key) ?? [];
		list.push(cb);
		onDidChangeListeners.set(key, list);
		return () => {
			const current = onDidChangeListeners.get(key) ?? [];
			onDidChangeListeners.set(
				key,
				current.filter((x) => x !== cb)
			);
		};
	},
};

import { storeMock } from "@test/mocks/store";

mock.module("./store", () => ({
	...storeMock(),
	store: mockStore,
	getStoreValue: (key: string) => {
		const [section, sub] = key.split(".");
		const top = section ? storeData[section] : undefined;
		if (top != null && typeof top === "object" && sub) {
			return (top as Record<string, unknown>)[sub];
		}
		return top;
	},
}));

const { applyPostProcessing, cleanupPostProcessing, getPostProcessingVocab, initPostProcessing } =
	await import("./text-processing");

// Contained boundary cast — `mockStore` implements only the electron-store
// surface initPostProcessing reads (get / set / onDidChange). The runtime
// object is passed through unchanged; only the type is widened to the real
// store parameter shape.
const asStore = (s: typeof mockStore) => s as unknown as Parameters<typeof initPostProcessing>[0];

beforeEach(() => {
	for (const k of Object.keys(storeData)) {
		delete storeData[k];
	}
	onDidChangeListeners.clear();
	storeData.dictionary = [];
	storeData.snippets = [];
	storeData.quality = { ensureSentenceEndsWithPeriod: false };
	initPostProcessing(asStore(mockStore));
});

afterEach(() => {
	cleanupPostProcessing();
});

describe("applyPostProcessing — dictionary (fuzzy)", () => {
	test("returns input unchanged when no dictionary entries", () => {
		expect(applyPostProcessing("hello there")).toBe("hello there");
	});

	test("snaps a near-miss spelling to the canonical term", () => {
		setStoreValue("dictionary", [{ id: "1", term: "Kubernetes" }]);
		expect(applyPostProcessing("deploy on kubernetees now")).toBe("deploy on Kubernetes now");
	});

	test("exact-match snaps to canonical casing", () => {
		setStoreValue("dictionary", [{ id: "1", term: "WinSTT" }]);
		expect(applyPostProcessing("install winstt")).toBe("install WinSTT");
	});

	test("ignores empty terms in the dictionary array", () => {
		setStoreValue("dictionary", [
			{ id: "1", term: "" },
			{ id: "2", term: "WinSTT" },
		]);
		expect(applyPostProcessing("hi winstt")).toBe("hi WinSTT");
	});

	test("does not over-match unrelated similar-looking words", () => {
		// "cube" should NOT trigger "Kubernetes" — too dissimilar.
		setStoreValue("dictionary", [{ id: "1", term: "Kubernetes" }]);
		expect(applyPostProcessing("a cube of nuts")).toBe("a cube of nuts");
	});
});

describe("applyPostProcessing — snippets (fuzzy)", () => {
	test("expands a multi-word trigger on exact match", () => {
		setStoreValue("snippets", [{ trigger: "my email address", expansion: "khaled@example.com" }]);
		expect(applyPostProcessing("forward to my email address")).toBe(
			"forward to khaled@example.com"
		);
	});

	test("expands a fuzzy trigger when Whisper drops a letter", () => {
		setStoreValue("snippets", [{ trigger: "my email address", expansion: "khaled@example.com" }]);
		expect(applyPostProcessing("forward to my email adress")).toBe("forward to khaled@example.com");
	});

	test("filters out snippets with empty triggers", () => {
		setStoreValue("snippets", [
			{ trigger: "", expansion: "X" },
			{ trigger: "my email", expansion: "khaled@example.com" },
		]);
		expect(applyPostProcessing("send my email")).toBe("send khaled@example.com");
	});

	test("dictionary applies before snippets", () => {
		setStoreValue("dictionary", [{ id: "1", term: "WinSTT" }]);
		setStoreValue("snippets", [{ trigger: "my email", expansion: "khaled@example.com" }]);
		expect(applyPostProcessing("ship winstt to my email")).toBe(
			"ship WinSTT to khaled@example.com"
		);
	});
});

describe("applyPostProcessing — sentence end period", () => {
	test("adds a period when ensureSentenceEndsWithPeriod is true and missing punctuation", () => {
		setStoreValue("quality", { ensureSentenceEndsWithPeriod: true });
		expect(applyPostProcessing("hello world")).toBe("hello world.");
	});

	test("trims trailing whitespace before adding the period", () => {
		setStoreValue("quality", { ensureSentenceEndsWithPeriod: true });
		expect(applyPostProcessing("hello  ")).toBe("hello.");
	});

	test("does not add a period when sentence already ends with one", () => {
		setStoreValue("quality", { ensureSentenceEndsWithPeriod: true });
		expect(applyPostProcessing("hello.")).toBe("hello.");
		expect(applyPostProcessing("hello!")).toBe("hello!");
		expect(applyPostProcessing("hello?")).toBe("hello?");
	});

	test("does not add a period for empty result", () => {
		setStoreValue("quality", { ensureSentenceEndsWithPeriod: true });
		expect(applyPostProcessing("")).toBe("");
	});
});

describe("rebuild watchers", () => {
	test("dictionary changes are picked up live", () => {
		expect(applyPostProcessing("kubernetees")).toBe("kubernetees");
		setStoreValue("dictionary", [{ id: "1", term: "Kubernetes" }]);
		expect(applyPostProcessing("kubernetees")).toBe("Kubernetes");
	});

	test("snippet changes are picked up live", () => {
		expect(applyPostProcessing("my email")).toBe("my email");
		setStoreValue("snippets", [{ trigger: "my email", expansion: "khaled@example.com" }]);
		expect(applyPostProcessing("my email")).toBe("khaled@example.com");
	});

	test("re-initializing replaces the active watcher set without leaks", () => {
		setStoreValue("dictionary", [{ id: "1", term: "Kubernetes" }]);
		expect(applyPostProcessing("kubernetees")).toBe("Kubernetes");

		for (const k of Object.keys(storeData)) {
			delete storeData[k];
		}
		onDidChangeListeners.clear();
		storeData.dictionary = [];
		storeData.snippets = [];
		storeData.quality = { ensureSentenceEndsWithPeriod: false };
		initPostProcessing(asStore(mockStore));
		expect(applyPostProcessing("kubernetees")).toBe("kubernetees");
	});
});

describe("cleanupPostProcessing", () => {
	test("clears caches so subsequent applyPostProcessing returns input untouched", () => {
		setStoreValue("dictionary", [{ id: "1", term: "Kubernetes" }]);
		expect(applyPostProcessing("kubernetees")).toBe("Kubernetes");
		cleanupPostProcessing();
		expect(applyPostProcessing("kubernetees")).toBe("kubernetees");
	});
});

describe("getPostProcessingVocab", () => {
	test("returns the canonical terms and snippets from the live caches", () => {
		setStoreValue("dictionary", [
			{ id: "1", term: "Kubernetes" },
			{ id: "2", term: "WinSTT" },
		]);
		setStoreValue("snippets", [{ trigger: "my email", expansion: "khaled@example.com" }]);
		const vocab = getPostProcessingVocab();
		expect(vocab.dictionary).toEqual(["Kubernetes", "WinSTT"]);
		expect(vocab.snippets).toEqual([{ trigger: "my email", expansion: "khaled@example.com" }]);
	});

	test("empty caches yield empty vocab arrays", () => {
		const vocab = getPostProcessingVocab();
		expect(vocab.dictionary).toEqual([]);
		expect(vocab.snippets).toEqual([]);
	});
});

describe("rebuild handles missing/null store data", () => {
	test("dictionary explicitly set to undefined: applyPostProcessing returns input untouched", () => {
		setStoreValue("dictionary", undefined);
		expect(applyPostProcessing("hello")).toBe("hello");
	});

	test("dictionary set to empty array: still no-op", () => {
		setStoreValue("dictionary", []);
		expect(applyPostProcessing("hello")).toBe("hello");
	});

	test("snippets explicitly set to undefined: applyPostProcessing returns input untouched", () => {
		setStoreValue("snippets", undefined);
		expect(applyPostProcessing("hello")).toBe("hello");
	});

	test("snippets array filters out empty triggers", () => {
		setStoreValue("snippets", [
			{ trigger: "", expansion: "DEAD" },
			{ trigger: "my email", expansion: "OK" },
		]);
		expect(applyPostProcessing("my email")).toBe("OK");
		expect(applyPostProcessing("abc")).toBe("abc");
	});
});
