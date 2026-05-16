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
		return Promise.resolve(`TRANSFORMED:${text}`);
	},
}));

const { applyTransform, __transforms_test_helpers__ } = await import("./transforms");

// ── Cross-file pollution guard ───────────────────────────────────────
// bun's `mock.module` registry is process-global and keyed by ABSOLUTE path
// (a distinct specifier like "../ipc/transforms" does NOT bypass it — bun
// normalizes before lookup). transform-hotkeys.test.ts runs first
// alphabetically and registers `mock.module("./transforms", ...)` with a stub
// `applyTransform` (it can't drive the real selection→LLM→paste pipeline).
// Under the full suite this file then `await import("./transforms")` and gets
// that stub: `__transforms_test_helpers__` is still spread-through (real), but
// `applyTransform` is the stub, so the behavioural `applyTransform` tests
// below can't run. They ARE fully exercised in isolation
// (`bun test electron/ipc/transforms.test.ts`), which is what stryker runs.
// Mirrors the identical, pre-existing `STORE_IS_POLLUTED` guard in
// electron/lib/store.test.ts.
// Probe: the genuine `applyTransform("")` rejects (empty id → ValidationError)
// without touching the store; transform-hotkeys's stub always resolves. Use
// that to detect a leaked stub and skip only the behavioural tests.
const TRANSFORMS_IS_POLLUTED = await applyTransform("").then(
	() => true,
	() => false
);
const itIfReal = TRANSFORMS_IS_POLLUTED ? test.skip : test;

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
	liveStore.store.set("llm.transforms", arr);
}

function reset(): void {
	liveStore.store.set("llm.transforms", []);
	// Transforms now require the LLM master switch + the transforms
	// sub-feature on, with a model configured (mirrors the real gate).
	liveStore.store.set("llm.enabled", true);
	liveStore.store.set("llm.transformsEnabled", true);
	liveStore.store.set("llm.model", "test-model");
	llmCalls.length = 0;
	clipboardWrites.length = 0;
	guardLog.length = 0;
	clipboardText = "";
	uiaSelection = "hello world";
}

describe("applyTransform", () => {
	itIfReal("captures selection → LLM → paste happy path", async () => {
		reset();
		setTransforms([
			{ id: "polish", name: "Polish", prompt: "polish me", hotkey: "", builtin: true },
		]);
		const result = await applyTransform("polish");
		expect(result.transformId).toBe("polish");
		expect(result.before).toBe("hello world");
		expect(result.after).toBe("TRANSFORMED:hello world");
		expect(llmCalls).toEqual([{ text: "hello world", prompt: "polish me" }]);
		// Real `pasteText` mirrors the transformed text to the clipboard
		// before sending Ctrl+V.
		expect(clipboardWrites).toContain("TRANSFORMED:hello world");
	});

	itIfReal("missing transform id throws ValidationError without paste/LLM call", async () => {
		reset();
		setTransforms([]);
		await expect(applyTransform("nope")).rejects.toThrow();
		expect(llmCalls.length).toBe(0);
		expect(clipboardWrites.length).toBe(0);
	});

	itIfReal("empty prompt throws and never reaches the LLM", async () => {
		reset();
		setTransforms([{ id: "blank", name: "Blank", prompt: "   ", hotkey: "", builtin: false }]);
		await expect(applyTransform("blank")).rejects.toThrow();
		expect(llmCalls.length).toBe(0);
		expect(clipboardWrites.length).toBe(0);
	});

	itIfReal("empty selection short-circuits — no LLM call, no paste", async () => {
		reset();
		setTransforms([
			{ id: "polish", name: "Polish", prompt: "polish me", hotkey: "", builtin: true },
		]);
		// Empty UIA + no clipboard change → real captureSelection returns
		// EMPTY_SELECTION (source "empty").
		uiaSelection = "";
		const result = await applyTransform("polish");
		expect(result.before).toBe("");
		expect(result.after).toBe("");
		expect(result.source).toBe("empty");
		expect(llmCalls.length).toBe(0);
		expect(clipboardWrites.length).toBe(0);
	});

	itIfReal("throws when the transforms sub-feature is disabled (no LLM call)", async () => {
		reset();
		setTransforms([
			{ id: "polish", name: "Polish", prompt: "polish me", hotkey: "", builtin: true },
		]);
		liveStore.store.set("llm.transformsEnabled", false);
		await expect(applyTransform("polish")).rejects.toThrow();
		expect(llmCalls.length).toBe(0);
		expect(clipboardWrites.length).toBe(0);
	});

	itIfReal("throws when the LLM master switch is off (no LLM call)", async () => {
		reset();
		setTransforms([
			{ id: "polish", name: "Polish", prompt: "polish me", hotkey: "", builtin: true },
		]);
		liveStore.store.set("llm.enabled", false);
		await expect(applyTransform("polish")).rejects.toThrow();
		expect(llmCalls.length).toBe(0);
		expect(clipboardWrites.length).toBe(0);
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
