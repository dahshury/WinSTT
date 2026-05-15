import { describe, expect, mock, test } from "bun:test";
import { electronMock } from "../../test/mocks/electron";

const storeValues: Record<string, unknown> = {};

mock.module("electron", () => electronMock());

mock.module("../lib/store", () => ({
	getStoreValue: (key: string) => storeValues[key],
	store: {
		get: (k: string) => storeValues[k],
		onDidChange: () => () => undefined,
	},
}));

const llmCalls: Array<{ prompt: string; text: string }> = [];
mock.module("./llm", () => ({
	processTextWithCustomPrompt: (text: string, prompt: string) => {
		llmCalls.push({ text, prompt });
		return Promise.resolve(`TRANSFORMED:${text}`);
	},
}));

const pasteCalls: string[] = [];
mock.module("../lib/paste", () => ({
	pasteText: (text: string) => {
		pasteCalls.push(text);
	},
}));

let nextSelection: { text: string; source: "uia" | "clipboard" | "empty" } = {
	text: "hello world",
	source: "uia",
};
mock.module("../lib/selection-capture", () => ({
	captureSelection: () => Promise.resolve({ ...nextSelection, originalClipboard: null }),
}));

const { applyTransform, __transforms_test_helpers__ } = await import("./transforms");

function setTransforms(arr: unknown): void {
	storeValues["llm.transforms"] = arr;
}

function reset(): void {
	for (const key of Object.keys(storeValues)) {
		delete storeValues[key];
	}
	llmCalls.length = 0;
	pasteCalls.length = 0;
	nextSelection = { text: "hello world", source: "uia" };
}

describe("applyTransform", () => {
	test("captures selection → LLM → paste happy path", async () => {
		reset();
		setTransforms([
			{ id: "polish", name: "Polish", prompt: "polish me", hotkey: "", builtin: true },
		]);
		const result = await applyTransform("polish");
		expect(result.transformId).toBe("polish");
		expect(result.before).toBe("hello world");
		expect(result.after).toBe("TRANSFORMED:hello world");
		expect(llmCalls).toEqual([{ text: "hello world", prompt: "polish me" }]);
		expect(pasteCalls).toEqual(["TRANSFORMED:hello world"]);
	});

	test("missing transform id throws ValidationError without paste/LLM call", async () => {
		reset();
		setTransforms([]);
		await expect(applyTransform("nope")).rejects.toThrow();
		expect(llmCalls.length).toBe(0);
		expect(pasteCalls.length).toBe(0);
	});

	test("empty prompt throws and never reaches the LLM", async () => {
		reset();
		setTransforms([{ id: "blank", name: "Blank", prompt: "   ", hotkey: "", builtin: false }]);
		await expect(applyTransform("blank")).rejects.toThrow();
		expect(llmCalls.length).toBe(0);
		expect(pasteCalls.length).toBe(0);
	});

	test("empty selection short-circuits — no LLM call, no paste", async () => {
		reset();
		setTransforms([
			{ id: "polish", name: "Polish", prompt: "polish me", hotkey: "", builtin: true },
		]);
		nextSelection = { text: "   ", source: "empty" };
		const result = await applyTransform("polish");
		expect(result.before).toBe("");
		expect(result.after).toBe("");
		expect(result.source).toBe("empty");
		expect(llmCalls.length).toBe(0);
		expect(pasteCalls.length).toBe(0);
	});
});

describe("assertApplyPayload", () => {
	test("rejects non-object payloads", () => {
		expect(() => __transforms_test_helpers__.assertApplyPayload(null)).toThrow();
		expect(() => __transforms_test_helpers__.assertApplyPayload("hi")).toThrow();
		expect(() => __transforms_test_helpers__.assertApplyPayload([])).toThrow();
	});

	test("rejects payload without transformId", () => {
		expect(() => __transforms_test_helpers__.assertApplyPayload({})).toThrow();
		expect(() => __transforms_test_helpers__.assertApplyPayload({ transformId: "" })).toThrow();
	});

	test("accepts payload with valid transformId", () => {
		expect(() =>
			__transforms_test_helpers__.assertApplyPayload({ transformId: "ok" })
		).not.toThrow();
	});
});

describe("assertPreviewPayload", () => {
	test("rejects missing or empty systemPrompt", () => {
		expect(() =>
			__transforms_test_helpers__.assertPreviewPayload({ text: "x", systemPrompt: "" })
		).toThrow();
		expect(() => __transforms_test_helpers__.assertPreviewPayload({ text: "x" })).toThrow();
	});

	test("accepts full preview payload", () => {
		expect(() =>
			__transforms_test_helpers__.assertPreviewPayload({
				text: "x",
				systemPrompt: "y",
			})
		).not.toThrow();
	});
});
