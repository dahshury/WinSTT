import { afterAll, describe, expect, mock, test } from "bun:test";
import { storeMock } from "@test/mocks/store";
import { electronMock } from "../../test/mocks/electron";

// bun's `mock.module` registry is process-global and is NEVER torn down
// between files. Two leak hazards have to be designed around here:
//
//  1. Mocking the SIBLING modules `../lib/paste` / `../lib/selection-capture`
//     outright erased their real surface for paste.test.ts /
//     selection-capture.test.ts (which import the real modules and run
//     later). Fix: stub their LEAF deps (electron clipboard, node:fs,
//     node:child_process) and let the genuine modules run — exactly the
//     pattern recording-state.test.ts uses.
//
//  2. The shared `../lib/store` mock must expose a COMPLETE surface
//     (`store.set`, `getStoreValue`, dot-path get) because it leaks into
//     recording-state.test.ts, which calls `store.set(...)`. The shared
//     `storeMock()` helper provides exactly that, with one backing object
//     so `set` and `getStoreValue` stay consistent.
//
// `../lib/context-reader` is deliberately NOT mocked — it is driven through
// the leaf `node:child_process` execFile stub, so context-reader.test.ts
// (which re-registers its own child_process mock and runs later) is unharmed.

const storeApi = storeMock();
mock.module("../lib/store", () => storeApi);

const clipboardWrites: string[] = [];
let clipboardText = "";
mock.module("electron", () => {
	const base = electronMock();
	base.clipboard = {
		readText: () => clipboardText,
		writeText: (text: string) => {
			clipboardText = text;
			clipboardWrites.push(text);
		},
		clear: () => {
			clipboardText = "";
		},
	};
	(base.app as unknown as { isPackaged: boolean }).isPackaged = false;
	return base;
});

import * as realFs from "node:fs";

mock.module("node:fs", () => ({
	...realFs,
	existsSync: () => true,
}));

// The UIA text the (real) context-reader → selection-capture pipeline will
// observe. Empty string drives the clipboard-fallback path which, with no
// clipboard change, yields an empty selection (source: "empty").
let uiaSelection = "hello world";

// Real `context-reader` spawns winstt-context.exe via execFile and parses
// its JSON stdout; real `paste`/`selection-capture` spawn winstt-paste.exe.
// Keep every spawn inert and feed the context helper a canned snapshot.
mock.module("node:child_process", () => ({
	execFile: (
		_cmd: string,
		args: string[],
		_opts: unknown,
		cb: (err: Error | null, stdout: string) => void
	) => {
		const isSelection = args.includes("--selection");
		const stdout = isSelection
			? JSON.stringify({ windowTitle: "", elementName: "", focusedText: uiaSelection })
			: "";
		queueMicrotask(() => cb(null, stdout));
	},
	spawn: () => {
		const handlers: Record<string, (arg?: unknown) => void> = {};
		const child = {
			on: (ev: string, cb: (arg?: unknown) => void) => {
				handlers[ev] = cb;
				return child;
			},
			kill: () => undefined,
			stdin: { write: () => undefined, end: () => undefined },
			stdout: { on: () => undefined },
			stderr: { on: () => undefined },
		};
		queueMicrotask(() => {
			handlers.spawn?.();
			handlers.close?.(0);
			handlers.exit?.(0);
		});
		return child;
	},
}));

const guardLog: boolean[] = [];
mock.module("../ipc/hotkey", () => ({
	setPasteGuard: (active: boolean) => {
		guardLog.push(active);
	},
}));

const llmCalls: Array<{ prompt: string; text: string }> = [];
mock.module("./llm", () => ({
	processTextWithCustomPrompt: (text: string, prompt: string) => {
		llmCalls.push({ text, prompt });
		if (prompt === "__throw__") {
			return Promise.reject(new Error("LLM exploded"));
		}
		return Promise.resolve(`TRANSFORMED:${text}`);
	},
}));

const { __transforms_test_helpers__ } = await import("./transforms");

// ── Cross-file pollution: drive the pipeline via the test helpers ────
// bun's `mock.module` registry is process-global and keyed by ABSOLUTE path.
// transform-hotkeys.test.ts runs first alphabetically and registers
// `mock.module("./transforms", () => ({ ...realTransforms, applyTransform: stub }))`.
// Under the full suite this file's `await import("./transforms")` therefore
// yields a STUBBED `applyTransform` but a SPREAD-THROUGH (real)
// `__transforms_test_helpers__`. The behavioural tests below exercise the real
// pipeline through `helpers.runTransformPipeline` (the thin exported
// `applyTransform` just delegates to it), so they run — and produce real
// coverage — regardless of which test file ran first.
const helpers = __transforms_test_helpers__;
const runTransformPipeline = helpers.runTransformPipeline;

// Write transforms through the SAME `../lib/store` module instance that the
// real `applyTransform` reads from. bun's `mock.module` registry is
// process-global: if a sibling test (e.g. transform-hotkeys.test.ts, which
// runs first alphabetically) already registered its own `../lib/store` mock,
// our local `storeApi` is NOT the instance `applyTransform` sees. Resolving
// the module here picks up whichever instance actually won the cache, so
// set→get round-trips regardless of ordering.
const liveStore = (await import("../lib/store")) as unknown as {
	store: { set: (key: string, value: unknown) => void };
};

// `./llm` and `../ipc/hotkey` are siblings of `transforms`; restore the reals
// so any file that runs after this one gets genuine implementations.
afterAll(async () => {
	const realLlm = await import("./llm");
	const realHotkey = await import("../ipc/hotkey");
	mock.module("./llm", () => realLlm);
	mock.module("../ipc/hotkey", () => realHotkey);
});

function setTransforms(arr: unknown): void {
	liveStore.store.set("llm.transforms.prompts", arr);
}

function reset(): void {
	liveStore.store.set("llm.transforms.prompts", []);
	// Transforms now require the transforms sub-feature enabled + a model
	// configured for its provider. There is no master switch.
	liveStore.store.set("llm.transforms.enabled", true);
	liveStore.store.set("llm.transforms.provider", "local");
	liveStore.store.set("llm.openrouterApiKey", "");
	liveStore.store.set("llm.transforms.model", "test-model");
	llmCalls.length = 0;
	clipboardWrites.length = 0;
	guardLog.length = 0;
	clipboardText = "";
	uiaSelection = "hello world";
}

describe("runTransformPipeline (applyTransform)", () => {
	test("captures selection → LLM → paste happy path", async () => {
		reset();
		setTransforms([
			{ id: "polish", name: "Polish", prompt: "polish me", hotkey: "", builtin: true },
		]);
		const pasteMod = await import("../lib/paste");
		pasteMod.__resetPasteCallsForTesting__();
		const result = await runTransformPipeline("polish");
		expect(result.transformId).toBe("polish");
		expect(result.before).toBe("hello world");
		expect(result.after).toBe("TRANSFORMED:hello world");
		expect(llmCalls).toEqual([{ text: "hello world", prompt: "polish me" }]);
		// `pasteText` no longer writes the clipboard on the success path — the
		// new typing-mode helper streams the text to the binary's stdin. We
		// observe the invocation via the call log instead.
		await pasteMod.flushPastePending();
		expect(pasteMod.__getPasteCallsForTesting__()).toContain("TRANSFORMED:hello world");
	});

	test("missing transform id throws ValidationError without paste/LLM call", async () => {
		reset();
		setTransforms([]);
		await expect(runTransformPipeline("nope")).rejects.toThrow();
		expect(llmCalls.length).toBe(0);
		expect(clipboardWrites.length).toBe(0);
	});

	test("empty prompt throws and never reaches the LLM", async () => {
		reset();
		setTransforms([{ id: "blank", name: "Blank", prompt: "   ", hotkey: "", builtin: false }]);
		await expect(runTransformPipeline("blank")).rejects.toThrow();
		expect(llmCalls.length).toBe(0);
		expect(clipboardWrites.length).toBe(0);
	});

	test("empty selection short-circuits — no LLM call, no paste", async () => {
		reset();
		setTransforms([
			{ id: "polish", name: "Polish", prompt: "polish me", hotkey: "", builtin: true },
		]);
		// Empty UIA + no clipboard change → real captureSelection returns
		// EMPTY_SELECTION (source "empty").
		uiaSelection = "";
		const result = await runTransformPipeline("polish");
		expect(result.before).toBe("");
		expect(result.after).toBe("");
		expect(result.source).toBe("empty");
		expect(llmCalls.length).toBe(0);
		expect(clipboardWrites.length).toBe(0);
	});

	test("throws when the transforms sub-feature is disabled (no LLM call)", async () => {
		reset();
		setTransforms([
			{ id: "polish", name: "Polish", prompt: "polish me", hotkey: "", builtin: true },
		]);
		liveStore.store.set("llm.transforms.enabled", false);
		await expect(runTransformPipeline("polish")).rejects.toThrow();
		expect(llmCalls.length).toBe(0);
		expect(clipboardWrites.length).toBe(0);
	});
});

describe("transforms gate helpers", () => {
	test("hasTransformsModel: false with no model, true once configured", () => {
		reset();
		liveStore.store.set("llm.transforms.provider", "local");
		liveStore.store.set("llm.transforms.model", "");
		expect(helpers.hasTransformsModel()).toBe(false);
		liveStore.store.set("llm.transforms.model", "some-model");
		expect(helpers.hasTransformsModel()).toBe(true);
	});

	test("hasTransformsModel: openrouter branch keys off the API key", () => {
		reset();
		liveStore.store.set("llm.transforms.provider", "openrouter");
		liveStore.store.set("llm.openrouterApiKey", "");
		expect(helpers.hasTransformsModel()).toBe(false);
		liveStore.store.set("llm.openrouterApiKey", "sk-xxx");
		expect(helpers.hasTransformsModel()).toBe(true);
		liveStore.store.set("llm.transforms.provider", "local");
	});

	test("isTransformsEnabled: per-feature flag + model must hold", () => {
		reset();
		expect(helpers.isTransformsEnabled()).toBe(true);
		liveStore.store.set("llm.transforms.enabled", false);
		expect(helpers.isTransformsEnabled()).toBe(false);
		liveStore.store.set("llm.transforms.enabled", true);
		liveStore.store.set("llm.transforms.model", "");
		expect(helpers.isTransformsEnabled()).toBe(false);
	});

	test("requireEnabledTransform / requirePrompt enforce the gate", () => {
		reset();
		setTransforms([{ id: "p", name: "P", prompt: "go", hotkey: "", builtin: true }]);
		const t = helpers.requireEnabledTransform("p");
		expect(t.id).toBe("p");
		expect(() => helpers.requireEnabledTransform("missing")).toThrow();
		expect(() =>
			helpers.requirePrompt({ id: "p", name: "P", prompt: "   ", hotkey: "", builtin: true })
		).toThrow();
		expect(() =>
			helpers.requirePrompt({ id: "p", name: "P", prompt: "ok", hotkey: "", builtin: true })
		).not.toThrow();
	});

	test("runLlm resolves on success", async () => {
		reset();
		await expect(helpers.runLlm("id", "text", "ok")).resolves.toBe("TRANSFORMED:text");
	});

	test("runLlm re-throws and broadcasts on LLM failure", async () => {
		reset();
		await expect(helpers.runLlm("id", "text", "__throw__")).rejects.toThrow("LLM exploded");
	});
});

describe("string + record guards", () => {
	test("isNonEmptyString", () => {
		expect(helpers.isNonEmptyString("x")).toBe(true);
		expect(helpers.isNonEmptyString("")).toBe(false);
		expect(helpers.isNonEmptyString(5)).toBe(false);
		expect(helpers.isNonEmptyString(null)).toBe(false);
	});

	test("asRecord returns the object or throws", () => {
		expect(helpers.asRecord({ a: 1 }, "X")).toEqual({ a: 1 });
		expect(() => helpers.asRecord(null, "X")).toThrow();
		expect(() => helpers.asRecord([], "X")).toThrow();
	});
});

describe("broadcastAll / sendToWindow", () => {
	function fakeWin(opts: { destroyed?: boolean; throwOnSend?: boolean }) {
		return {
			isDestroyed: () => opts.destroyed === true,
			webContents: {
				send: () => {
					if (opts.throwOnSend) {
						throw new Error("send blew up");
					}
				},
			},
		} as unknown as Parameters<typeof helpers.sendToWindow>[0];
	}

	test("sendToWindow skips destroyed windows", () => {
		expect(() => helpers.sendToWindow(fakeWin({ destroyed: true }), "c", {})).not.toThrow();
	});

	test("sendToWindow swallows send errors", () => {
		expect(() => helpers.sendToWindow(fakeWin({ throwOnSend: true }), "c", {})).not.toThrow();
	});

	test("sendToWindow delivers to a live window", () => {
		expect(() => helpers.sendToWindow(fakeWin({}), "c", { ok: 1 })).not.toThrow();
	});

	test("broadcastAll iterates all windows without throwing", () => {
		expect(() => helpers.broadcastAll("chan", { hello: true })).not.toThrow();
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
	test("rejects non-string text", () => {
		expect(() =>
			__transforms_test_helpers__.assertPreviewPayload({ text: 5, systemPrompt: "y" })
		).toThrow();
	});

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
