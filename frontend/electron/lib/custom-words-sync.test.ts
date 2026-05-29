import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Controllable store shim ──────────────────────────────────────────
//
// custom-words-sync.ts pulls in `./store`, whose real module-load runs the
// electron-store constructor + full migration block. We don't need any of
// that — the source only touches `store.get`, `store.onDidChange`, and
// `getStoreRaw`. Mock the module with a tiny in-memory shim we can steer
// per-test. `./debug-log` is mocked to a no-op so no electron-log file
// transport spins up under plain `bun test`.

interface ChangeListener {
	cb: () => void;
	key: string;
}

const storeState: { values: Record<string, unknown>; listeners: ChangeListener[] } = {
	values: {},
	listeners: [],
};

const storeMock = {
	get: (key: string): unknown => storeState.values[key],
	onDidChange: (key: string, cb: () => void): (() => void) => {
		const listener: ChangeListener = { key, cb };
		storeState.listeners.push(listener);
		return () => {
			const idx = storeState.listeners.indexOf(listener);
			if (idx >= 0) {
				storeState.listeners.splice(idx, 1);
			}
		};
	},
};

function getStoreRawMock(key: string): string | number | boolean | undefined {
	const raw = storeState.values[key];
	if (raw == null) {
		return;
	}
	if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
		return raw;
	}
	return;
}

const dbgCalls: Array<{ tag: string; args: unknown[] }> = [];

mock.module("./store", () => ({ store: storeMock, getStoreRaw: getStoreRawMock }));
mock.module("./debug-log", () => ({
	dbg: (tag: string, ...args: unknown[]) => {
		dbgCalls.push({ tag, args });
	},
}));

const { installCustomWordsSync } = await import("./custom-words-sync");

// ── Fake SttClient ───────────────────────────────────────────────────
//
// Records setParameter calls and exposes a manual `server-ready` emit so we
// can drive the on/off listener wiring without the real WebSocket.

interface FakeClient {
	emitServerReady: () => void;
	isConnected: boolean;
	off: (event: string, cb: () => void) => void;
	on: (event: string, cb: () => void) => void;
	params: Array<{ parameter: string; value: unknown }>;
	serverReadyHandlers: Set<() => void>;
	setParameter: (parameter: string, value: unknown) => void;
}

function makeClient(isConnected: boolean): FakeClient {
	const client: FakeClient = {
		isConnected,
		params: [],
		serverReadyHandlers: new Set(),
		setParameter(parameter, value) {
			client.params.push({ parameter, value });
		},
		on(event, cb) {
			if (event === "server-ready") {
				client.serverReadyHandlers.add(cb);
			}
		},
		off(event, cb) {
			if (event === "server-ready") {
				client.serverReadyHandlers.delete(cb);
			}
		},
		emitServerReady() {
			for (const cb of client.serverReadyHandlers) {
				cb();
			}
		},
	};
	return client;
}

// The exported function is typed against the real SttClient; our fake only
// implements the surface it actually calls. Contain the boundary cast here so
// call-sites stay clean.
type SttClientArg = Parameters<typeof installCustomWordsSync>[0];
const asClient = (c: FakeClient): SttClientArg => c as unknown as SttClientArg;

function paramMap(client: FakeClient): Map<string, unknown> {
	return new Map(client.params.map((p) => [p.parameter, p.value]));
}

beforeEach(() => {
	storeState.values = {};
	storeState.listeners = [];
	dbgCalls.length = 0;
});

describe("installCustomWordsSync — initial push (pushCustomWords)", () => {
	test("does NOT push when the client is disconnected", () => {
		const client = makeClient(false);
		installCustomWordsSync(asClient(client));
		expect(client.params).toEqual([]);
		expect(dbgCalls).toEqual([]);
	});

	test("pushes all four parameters when connected, with schema defaults on an empty store", () => {
		const client = makeClient(true);
		installCustomWordsSync(asClient(client));
		const map = paramMap(client);
		// custom_words: empty dictionary → []
		expect(map.get("custom_words")).toEqual([]);
		// threshold: missing key → server default 0.18
		expect(map.get("word_correction_threshold")).toBe(0.18);
		// custom_filler_words: missing key → []
		expect(map.get("custom_filler_words")).toEqual([]);
		// filter_fillers is NOT pushed from here anymore (renderer syncToServer
		// owns it — see syncTextCorrectionParams). Three params pushed.
		expect(map.get("filter_fillers")).toBeUndefined();
		expect(client.params).toHaveLength(3);
	});

	test("emits a dbg line summarizing the push", () => {
		const client = makeClient(true);
		storeState.values.dictionary = [{ term: "kubernetes" }];
		installCustomWordsSync(asClient(client));
		expect(dbgCalls).toHaveLength(1);
		const entry = dbgCalls[0];
		expect(entry?.tag).toBe("custom-words");
		expect(String(entry?.args[0])).toContain("pushed 1 words");
		expect(String(entry?.args[0])).toContain("thr 0.18");
		expect(String(entry?.args[0])).toContain("custom-fillers=0");
	});
});

describe("readCurrentCustomWords (via push)", () => {
	test("keeps only vocab-bias terms (no replacement), trimmed, deduped, in order", () => {
		const client = makeClient(true);
		storeState.values.dictionary = [
			{ term: "  Kubernetes  " }, // trimmed → "Kubernetes"
			{ term: "Postgres", replacement: "" }, // empty replacement → kept
			{ term: "GitHub", replacement: "  " }, // whitespace replacement trims to "" → kept
			{ term: "teh", replacement: "the" }, // has replacement → SKIPPED
			{ term: "Kubernetes" }, // duplicate → SKIPPED
			{ term: "   " }, // whitespace-only term → SKIPPED
			{ replacement: "orphan" }, // no term → SKIPPED
			{ term: 42 }, // non-string term → coerced to "" → SKIPPED
		];
		installCustomWordsSync(asClient(client));
		expect(paramMap(client).get("custom_words")).toEqual(["Kubernetes", "Postgres", "GitHub"]);
	});

	test("returns [] when dictionary is undefined", () => {
		const client = makeClient(true);
		// no dictionary key set
		installCustomWordsSync(asClient(client));
		expect(paramMap(client).get("custom_words")).toEqual([]);
	});

	test("returns [] when dictionary is an empty array", () => {
		const client = makeClient(true);
		storeState.values.dictionary = [];
		installCustomWordsSync(asClient(client));
		expect(paramMap(client).get("custom_words")).toEqual([]);
	});

	test("treats a non-string replacement (number) as absent → term kept", () => {
		const client = makeClient(true);
		// replacement is a non-string falsy value → typeof check yields ""
		// (falsy) so the term is treated as a vocab-bias entry and kept.
		storeState.values.dictionary = [{ term: "Redis", replacement: 0 }];
		installCustomWordsSync(asClient(client));
		expect(paramMap(client).get("custom_words")).toEqual(["Redis"]);
	});
});

describe("readCurrentThreshold (via push)", () => {
	test("returns the persisted numeric threshold when present", () => {
		const client = makeClient(true);
		storeState.values["general.wordCorrectionThreshold"] = 0.42;
		installCustomWordsSync(asClient(client));
		expect(paramMap(client).get("word_correction_threshold")).toBe(0.42);
	});

	test("falls back to 0.18 when the value is not a number (string)", () => {
		const client = makeClient(true);
		storeState.values["general.wordCorrectionThreshold"] = "0.9";
		installCustomWordsSync(asClient(client));
		expect(paramMap(client).get("word_correction_threshold")).toBe(0.18);
	});

	test("accepts 0 as a valid persisted threshold (does not fall back)", () => {
		const client = makeClient(true);
		storeState.values["general.wordCorrectionThreshold"] = 0;
		installCustomWordsSync(asClient(client));
		expect(paramMap(client).get("word_correction_threshold")).toBe(0);
	});
});

describe("readCustomFillerWords (via push)", () => {
	test("returns [] when the value is not an array", () => {
		const client = makeClient(true);
		storeState.values["general.customFillerWords"] = "um, uh";
		installCustomWordsSync(asClient(client));
		expect(paramMap(client).get("custom_filler_words")).toEqual([]);
	});

	test("returns [] when the key is missing entirely", () => {
		const client = makeClient(true);
		installCustomWordsSync(asClient(client));
		expect(paramMap(client).get("custom_filler_words")).toEqual([]);
	});

	test("trims, dedupes, drops non-strings and blanks, preserves order", () => {
		const client = makeClient(true);
		storeState.values["general.customFillerWords"] = [
			"  um  ", // trimmed → "um"
			"uh",
			"um", // duplicate → SKIPPED
			"   ", // whitespace-only → SKIPPED
			"", // empty → SKIPPED
			42, // non-string → SKIPPED
			null, // non-string → SKIPPED
			"like",
		];
		installCustomWordsSync(asClient(client));
		expect(paramMap(client).get("custom_filler_words")).toEqual(["um", "uh", "like"]);
	});
});

describe("installCustomWordsSync — change watchers + server-ready", () => {
	test("wires store.onDidChange for the three watched keys and a server-ready listener", () => {
		const client = makeClient(true);
		installCustomWordsSync(asClient(client));
		const watchedKeys = storeState.listeners.map((l) => l.key).sort();
		// NB: general.filterFillers is NOT watched here anymore — the renderer's
		// syncToServer owns it (it read a stale electron-store value in the live
		// main process). custom-words-sync keeps dictionary + threshold + custom-fillers.
		expect(watchedKeys).toEqual([
			"dictionary",
			"general.customFillerWords",
			"general.wordCorrectionThreshold",
		]);
		expect(client.serverReadyHandlers.size).toBe(1);
	});

	test("a dictionary change re-pushes the current word list", () => {
		const client = makeClient(true);
		installCustomWordsSync(asClient(client));
		client.params.length = 0; // clear the install-time push
		// Simulate the user adding a vocab term, then firing the watcher.
		storeState.values.dictionary = [{ term: "Grafana" }];
		const dictListener = storeState.listeners.find((l) => l.key === "dictionary");
		dictListener?.cb();
		expect(paramMap(client).get("custom_words")).toEqual(["Grafana"]);
	});

	test("a server-ready event re-pushes the live config", () => {
		const client = makeClient(true);
		installCustomWordsSync(asClient(client));
		client.params.length = 0;
		storeState.values["general.wordCorrectionThreshold"] = 0.25;
		client.emitServerReady();
		expect(paramMap(client).get("word_correction_threshold")).toBe(0.25);
	});

	test("the cleanup function detaches every watcher and the server-ready listener", () => {
		const client = makeClient(true);
		const dispose = installCustomWordsSync(asClient(client));
		expect(storeState.listeners).toHaveLength(3);
		expect(client.serverReadyHandlers.size).toBe(1);

		dispose();

		expect(storeState.listeners).toHaveLength(0);
		expect(client.serverReadyHandlers.size).toBe(0);

		// After teardown a server-ready emit must not push anything.
		client.params.length = 0;
		client.emitServerReady();
		expect(client.params).toEqual([]);
	});

	test("watcher firing while disconnected is a no-op (re-checks isConnected)", () => {
		const client = makeClient(true);
		installCustomWordsSync(asClient(client));
		client.params.length = 0;
		// Connection dropped after install; a stray watcher fire must not push.
		client.isConnected = false;
		storeState.listeners.find((l) => l.key === "general.customFillerWords")?.cb();
		expect(client.params).toEqual([]);
	});
});
