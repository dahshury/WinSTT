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

const { applyPostProcessing, cleanupPostProcessing, initPostProcessing } = await import(
	"./text-processing"
);

beforeEach(() => {
	for (const k of Object.keys(storeData)) {
		delete storeData[k];
	}
	onDidChangeListeners.clear();
	storeData.dictionary = [];
	storeData.snippets = [];
	storeData.quality = { ensureSentenceEndsWithPeriod: false };
	initPostProcessing(mockStore as unknown as Parameters<typeof initPostProcessing>[0]);
});

afterEach(() => {
	cleanupPostProcessing();
});

describe("applyPostProcessing — dictionary", () => {
	test("returns input unchanged when no dictionary entries", () => {
		expect(applyPostProcessing("hello there")).toBe("hello there");
	});

	test("applies a case-insensitive replacement (default)", () => {
		setStoreValue("dictionary", [
			{ find: "ur", replace: "your", caseSensitive: false, wholeWord: false },
		]);
		expect(applyPostProcessing("ur cool")).toBe("your cool");
		expect(applyPostProcessing("UR cool")).toBe("your cool");
	});

	test("applies a case-sensitive replacement when caseSensitive=true", () => {
		setStoreValue("dictionary", [
			{ find: "ur", replace: "your", caseSensitive: true, wholeWord: false },
		]);
		expect(applyPostProcessing("UR cool")).toBe("UR cool");
		expect(applyPostProcessing("ur cool")).toBe("your cool");
	});

	test("respects wholeWord boundary", () => {
		setStoreValue("dictionary", [
			{ find: "cat", replace: "dog", caseSensitive: false, wholeWord: true },
		]);
		expect(applyPostProcessing("the cat sat")).toBe("the dog sat");
		expect(applyPostProcessing("category")).toBe("category"); // not whole word
	});

	test("escapes regex special characters in find", () => {
		setStoreValue("dictionary", [
			{ find: ".com", replace: "[dot]com", caseSensitive: false, wholeWord: false },
		]);
		expect(applyPostProcessing("see foo.com")).toBe("see foo[dot]com");
		// '.' should not match arbitrary chars like 'a' since it was escaped
		expect(applyPostProcessing("seeacom")).toBe("seeacom");
	});

	test("filters out entries with empty 'find'", () => {
		setStoreValue("dictionary", [
			{ find: "", replace: "x", caseSensitive: false, wholeWord: false },
			{ find: "y", replace: "z", caseSensitive: false, wholeWord: false },
		]);
		expect(applyPostProcessing("yes")).toBe("zes");
	});
});

describe("applyPostProcessing — snippets", () => {
	test("expands every occurrence of a trigger", () => {
		setStoreValue("snippets", [{ trigger: "/sig", expansion: "Best,\nSan" }]);
		expect(applyPostProcessing("hi /sig and /sig")).toBe("hi Best,\nSan and Best,\nSan");
	});

	test("filters out snippets with empty triggers", () => {
		setStoreValue("snippets", [
			{ trigger: "", expansion: "X" },
			{ trigger: "/y", expansion: "yes" },
		]);
		expect(applyPostProcessing("/y")).toBe("yes");
	});

	test("dictionary applies before snippets", () => {
		setStoreValue("dictionary", [
			{ find: "hi", replace: "hello", caseSensitive: false, wholeWord: false },
		]);
		setStoreValue("snippets", [{ trigger: "hello", expansion: "HOWDY" }]);
		expect(applyPostProcessing("hi")).toBe("HOWDY");
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
		expect(applyPostProcessing("hi")).toBe("hi");
		setStoreValue("dictionary", [
			{ find: "hi", replace: "hello", caseSensitive: false, wholeWord: false },
		]);
		expect(applyPostProcessing("hi")).toBe("hello");
	});

	test("snippet changes are picked up live", () => {
		expect(applyPostProcessing("/x")).toBe("/x");
		setStoreValue("snippets", [{ trigger: "/x", expansion: "expanded" }]);
		expect(applyPostProcessing("/x")).toBe("expanded");
	});

	test("re-initializing replaces the active watcher set without leaks", () => {
		setStoreValue("dictionary", [
			{ find: "old", replace: "new", caseSensitive: false, wholeWord: false },
		]);
		expect(applyPostProcessing("old")).toBe("new");

		// Re-init with fresh storeData → previous dictionary should be cleared
		for (const k of Object.keys(storeData)) {
			delete storeData[k];
		}
		onDidChangeListeners.clear();
		storeData.dictionary = [];
		storeData.snippets = [];
		storeData.quality = { ensureSentenceEndsWithPeriod: false };
		initPostProcessing(mockStore as unknown as Parameters<typeof initPostProcessing>[0]);
		expect(applyPostProcessing("old")).toBe("old");
	});
});

describe("cleanupPostProcessing", () => {
	test("clears caches so subsequent applyPostProcessing returns input untouched", () => {
		setStoreValue("dictionary", [
			{ find: "x", replace: "y", caseSensitive: false, wholeWord: false },
		]);
		expect(applyPostProcessing("x")).toBe("y");
		cleanupPostProcessing();
		expect(applyPostProcessing("x")).toBe("x");
	});
});
