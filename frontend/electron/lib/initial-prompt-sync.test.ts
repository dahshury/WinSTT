/**
 * Tests for `initial-prompt-sync.ts`.
 *
 * Covers the three public surfaces:
 *   - `readCurrentInitialPrompt`: pulls dictionary + static prefixes from
 *     the store and composes both main and realtime prompts.
 *   - `installInitialPromptSync`: wires watchers on store + server-ready
 *     events; returns a cleanup function that detaches everything.
 *
 * `mock.module(...)` is process-global, so we install the store + debug-log
 * mocks BEFORE importing the SUT.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { debugLogMock } from "@test/mocks/debug-log";
import { storeMock } from "../../test/mocks/store";
import type { SttClient } from "../ws/stt-client";

mock.module("./debug-log", () => debugLogMock());

const sharedStore = storeMock();
mock.module("./store", () => sharedStore);

const {
	__resetVolatileContextForTesting__,
	clearVolatileContextTail,
	installInitialPromptSync,
	readCurrentInitialPrompt,
	setVolatileContextTail,
} = await import("./initial-prompt-sync");

interface FakeClient {
	calls: Array<{ key: string; value: string }>;
	connected: boolean;
	events: Map<string, Array<() => void>>;
	isConnected: boolean;
	off: (event: string, cb: () => void) => void;
	on: (event: string, cb: () => void) => void;
	setParameter: (key: string, value: string) => void;
}

function makeFakeClient(connected = true): FakeClient {
	const events = new Map<string, Array<() => void>>();
	const calls: FakeClient["calls"] = [];
	return {
		calls,
		connected,
		events,
		get isConnected() {
			return this.connected;
		},
		setParameter(key: string, value: string) {
			calls.push({ key, value });
		},
		on(event: string, cb: () => void) {
			const list = events.get(event) ?? [];
			list.push(cb);
			events.set(event, list);
		},
		off(event: string, cb: () => void) {
			events.set(
				event,
				(events.get(event) ?? []).filter((x) => x !== cb)
			);
		},
	};
}

function install(client: FakeClient): () => void {
	// FakeClient implements only the SttClient surface the SUT touches —
	// isConnected, setParameter, on, off. The full EventEmitter ABI is
	// irrelevant here, so we cast at the call boundary instead of stubbing
	// every method.
	return installInitialPromptSync(client as unknown as SttClient);
}

function resetStore() {
	sharedStore.store.set("dictionary", []);
	sharedStore.store.set("model.initialPrompt", "");
	sharedStore.store.set("model.initialPromptRealtime", "");
}

describe("readCurrentInitialPrompt", () => {
	beforeEach(resetStore);

	test("empty dictionary + empty prefixes → empty composed strings", () => {
		const result = readCurrentInitialPrompt();
		expect(result.main).toBe("");
		expect(result.realtime).toBe("");
	});

	test("static main prefix passes through when dictionary is empty", () => {
		sharedStore.store.set("model.initialPrompt", "Hello world.");
		const result = readCurrentInitialPrompt();
		expect(result.main).toBe("Hello world.");
		expect(result.realtime).toBe("");
	});

	test("static realtime prefix passes through independently", () => {
		sharedStore.store.set("model.initialPromptRealtime", "Realtime: foo");
		const result = readCurrentInitialPrompt();
		expect(result.main).toBe("");
		expect(result.realtime).toBe("Realtime: foo");
	});

	test("dictionary terms are folded into both prompts", () => {
		sharedStore.store.set("dictionary", [{ term: "Kubernetes" }, { term: "GitHub" }]);
		const result = readCurrentInitialPrompt();
		expect(result.main).toContain("Kubernetes");
		expect(result.main).toContain("GitHub");
		expect(result.realtime).toContain("Kubernetes");
		expect(result.realtime).toContain("GitHub");
	});

	test("non-string store values fall back to empty string", () => {
		// Force a non-string raw value at the prefix key. The getStoreRaw shim
		// in the storeMock filters non-strings to undefined, so the SUT's
		// `typeof === "string"` guard sends us into the empty-string branch.
		sharedStore.store.set("model.initialPrompt", 42);
		const result = readCurrentInitialPrompt();
		// Composer drops invalid prefixes; should produce empty prompt.
		expect(typeof result.main).toBe("string");
	});

	test("dictionary + main prefix combine; prefix appears before vocab", () => {
		sharedStore.store.set("model.initialPrompt", "Prefix.");
		sharedStore.store.set("dictionary", [{ term: "Ollama" }]);
		const result = readCurrentInitialPrompt();
		expect(result.main).toContain("Prefix.");
		expect(result.main).toContain("Ollama");
	});
});

describe("installInitialPromptSync", () => {
	beforeEach(resetStore);

	test("pushes prompts immediately on install when client is connected", () => {
		const client = makeFakeClient(true);
		sharedStore.store.set("model.initialPrompt", "main prefix");
		sharedStore.store.set("model.initialPromptRealtime", "realtime prefix");
		const cleanup = install(client);
		// First call should be the immediate push (one main + one realtime).
		const mainCall = client.calls.find((c) => c.key === "initial_prompt");
		const rtCall = client.calls.find((c) => c.key === "initial_prompt_realtime");
		expect(mainCall?.value).toBe("main prefix");
		expect(rtCall?.value).toBe("realtime prefix");
		cleanup();
	});

	test("does NOT push when client is disconnected on install", () => {
		const client = makeFakeClient(false);
		sharedStore.store.set("model.initialPrompt", "main prefix");
		const cleanup = install(client);
		expect(client.calls).toHaveLength(0);
		cleanup();
	});

	test("re-pushes on dictionary change", () => {
		const client = makeFakeClient(true);
		const cleanup = install(client);
		const initialCalls = client.calls.length;
		sharedStore.store.set("dictionary", [{ term: "Whisper" }]);
		// Watchers fire synchronously in storeMock; new push happened.
		expect(client.calls.length).toBeGreaterThan(initialCalls);
		const lastMain = client.calls.findLast((c) => c.key === "initial_prompt");
		expect(lastMain?.value).toContain("Whisper");
		cleanup();
	});

	test("re-pushes on model.initialPrompt change", () => {
		const client = makeFakeClient(true);
		const cleanup = install(client);
		const initialCalls = client.calls.length;
		sharedStore.store.set("model.initialPrompt", "new static");
		expect(client.calls.length).toBeGreaterThan(initialCalls);
		const lastMain = client.calls.findLast((c) => c.key === "initial_prompt");
		expect(lastMain?.value).toBe("new static");
		cleanup();
	});

	test("re-pushes on model.initialPromptRealtime change", () => {
		const client = makeFakeClient(true);
		const cleanup = install(client);
		const initialCalls = client.calls.length;
		sharedStore.store.set("model.initialPromptRealtime", "rt change");
		expect(client.calls.length).toBeGreaterThan(initialCalls);
		const lastRt = client.calls.findLast((c) => c.key === "initial_prompt_realtime");
		expect(lastRt?.value).toBe("rt change");
		cleanup();
	});

	test("subscribes to server-ready event; re-pushes when emitted", () => {
		const client = makeFakeClient(true);
		const cleanup = install(client);
		const beforeReady = client.calls.length;
		// Trigger all server-ready callbacks.
		for (const cb of client.events.get("server-ready") ?? []) {
			cb();
		}
		expect(client.calls.length).toBeGreaterThan(beforeReady);
		cleanup();
	});

	test("cleanup() detaches every watcher so further changes don't push", () => {
		const client = makeFakeClient(true);
		const cleanup = install(client);
		cleanup();
		const afterCleanup = client.calls.length;
		// Drive every observable input. None should re-trigger a push.
		sharedStore.store.set("dictionary", [{ term: "Detached" }]);
		sharedStore.store.set("model.initialPrompt", "won't propagate");
		sharedStore.store.set("model.initialPromptRealtime", "ditto");
		for (const cb of client.events.get("server-ready") ?? []) {
			cb();
		}
		expect(client.calls.length).toBe(afterCleanup);
	});

	test("disconnected client + push triggered by watcher = no-op", () => {
		const client = makeFakeClient(false);
		const cleanup = install(client);
		// Connection is still false; trigger a watcher.
		sharedStore.store.set("dictionary", [{ term: "Disconnected" }]);
		expect(client.calls).toHaveLength(0);
		cleanup();
	});
});

describe("setVolatileContextTail / clearVolatileContextTail", () => {
	beforeEach(() => {
		resetStore();
		__resetVolatileContextForTesting__();
	});

	test("an empty tail is a no-op (does NOT push)", () => {
		const client = makeFakeClient(true);
		setVolatileContextTail(client as unknown as SttClient, "");
		expect(client.calls).toHaveLength(0);
	});

	test("setting a tail re-pushes the composed prompt with the tail prepended", () => {
		const client = makeFakeClient(true);
		sharedStore.store.set("dictionary", [{ term: "Kubernetes" }]);
		setVolatileContextTail(client as unknown as SttClient, "We were talking about the cluster.");
		const lastMain = client.calls.findLast((c) => c.key === "initial_prompt");
		expect(lastMain?.value).toContain("We were talking about the cluster.");
		expect(lastMain?.value).toContain("Glossary: Kubernetes.");
		// Tail comes BEFORE the glossary (highest signal first).
		const tailIdx = lastMain?.value.indexOf("We were talking") ?? -1;
		const glossaryIdx = lastMain?.value.indexOf("Glossary:") ?? -1;
		expect(tailIdx).toBeLessThan(glossaryIdx);
	});

	test("setting the same tail twice produces ONE additional push (idempotent)", () => {
		const client = makeFakeClient(true);
		setVolatileContextTail(client as unknown as SttClient, "Hi Bob.");
		const after1 = client.calls.length;
		setVolatileContextTail(client as unknown as SttClient, "Hi Bob.");
		expect(client.calls.length).toBe(after1);
	});

	test("clear after set restores the base prompt (no tail)", () => {
		const client = makeFakeClient(true);
		sharedStore.store.set("dictionary", [{ term: "Kubernetes" }]);
		setVolatileContextTail(client as unknown as SttClient, "Hi Bob.");
		clearVolatileContextTail(client as unknown as SttClient);
		const lastMain = client.calls.findLast((c) => c.key === "initial_prompt");
		expect(lastMain?.value).not.toContain("Hi Bob.");
		expect(lastMain?.value).toContain("Glossary: Kubernetes.");
	});

	test("clear with no volatile tail is a no-op (does NOT push)", () => {
		const client = makeFakeClient(true);
		clearVolatileContextTail(client as unknown as SttClient);
		expect(client.calls).toHaveLength(0);
	});

	test("disconnected client + setTail = no-op", () => {
		const client = makeFakeClient(false);
		setVolatileContextTail(client as unknown as SttClient, "Should not push.");
		expect(client.calls).toHaveLength(0);
	});

	test("an installed sync sees the volatile tail in its push payload", () => {
		// This is the integration the conversation cared about: the next
		// initial_prompt that lands on the server includes the prior-text
		// from the UIA snapshot, so Whisper biases away from cabernet→Kubernetes.
		const client = makeFakeClient(true);
		sharedStore.store.set("dictionary", [{ term: "Kubernetes" }]);
		const cleanup = install(client);
		setVolatileContextTail(
			client as unknown as SttClient,
			"the cluster is on the new Kubernetes node"
		);
		const lastMain = client.calls.findLast((c) => c.key === "initial_prompt");
		expect(lastMain?.value).toContain("the cluster is on the new Kubernetes node");
		expect(lastMain?.value).toContain("Glossary: Kubernetes.");
		cleanup();
	});
});
