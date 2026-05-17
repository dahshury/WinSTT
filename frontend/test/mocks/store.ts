/**
 * Shared in-memory shim for `electron/lib/store.ts`.
 *
 * Tests across electron/ipc and electron/lib need to mock `./store` (or
 * `../lib/store`) — `mock.module(...)` is process-global, so a thin per-file
 * shim that only exports the symbols THAT file needs will break the other
 * tests that import a different subset. Provide a complete surface from one
 * place and have every test use it.
 *
 * Usage:
 * ```
 * import { storeMock } from "@test/mocks/store";
 * mock.module("../lib/store", () => storeMock());
 * mock.module("./store", () => storeMock()); // for electron/lib tests
 * ```
 */

function getByPath(obj: Record<string, unknown>, key: string): unknown {
	if (key in obj) {
		return obj[key];
	}
	const parts = key.split(".");
	let cur: unknown = obj;
	for (const p of parts) {
		if (cur != null && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
			cur = (cur as Record<string, unknown>)[p];
		} else {
			return;
		}
	}
	return cur;
}

function setByPath(obj: Record<string, unknown>, key: string, value: unknown): void {
	const parts = key.split(".");
	if (parts.length === 1) {
		obj[key] = value;
		return;
	}
	let cur: Record<string, unknown> = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		const p = parts[i] as string;
		if (cur[p] == null || typeof cur[p] !== "object" || Array.isArray(cur[p])) {
			cur[p] = {};
		}
		cur = cur[p] as Record<string, unknown>;
	}
	cur[parts.at(-1) as string] = value;
}

/**
 * Hard-coded subset of `electron/lib/store.ts`'s `defaults` — these are the
 * keys most commonly queried via `getStoreValue` across the suite. Seeding
 * them here means a partial per-file mock that lacks a custom getStoreValue
 * still returns a sensible value when an unrelated test happens to query.
 */
const STORE_DEFAULTS: Record<string, unknown> = {
	general: {
		autoStart: false,
		minimizeToTray: true,
		startMinimized: false,
		systemAudioReductionWhileDictating: 0,
		recordingSound: true,
		recordingSoundPath: "",
		fileTranscriptionFormat: "txt",
		recordingMode: "ptt",
		loopbackDeviceIndex: null,
		showRecordingOverlay: true,
		visualizerSize: "xs",
		liveTranscriptionDisplay: "both",
		visualizerType: "bar",
		visualizerBarCount: 9,
	},
	quality: {
		enableRealtimeTranscription: true,
		useMainModelForRealtime: false,
		ensureSentenceEndsWithPeriod: true,
		smartEndpoint: false,
		smartEndpointSpeed: 1.5,
	},
	audio: {
		sileroSensitivity: 0.4,
		sileroDeactivityDetection: true,
	},
	llm: {
		endpoint: "http://localhost:11434",
		openrouterApiKey: "",
		dictation: {
			enabled: false,
			provider: "ollama",
			model: "",
			openrouterModel: "",
			openrouterFallbackModel: "",
			presets: [{ key: "neutral" }],
		},
		transforms: {
			enabled: false,
			provider: "ollama",
			model: "",
			openrouterModel: "",
			openrouterFallbackModel: "",
			prompts: [],
		},
	},
};

export function storeMock() {
	// Deep clone so each test file gets its own mutable copy.
	const data: Record<string, unknown> = JSON.parse(JSON.stringify(STORE_DEFAULTS));
	const listeners = new Map<string, Array<(value: unknown, prev: unknown) => void>>();

	const fakeStore = {
		store: data,
		get: (key: string) => getByPath(data, key),
		set: (key: string, value: unknown) => {
			const prev = getByPath(data, key);
			setByPath(data, key, value);
			for (const cb of listeners.get(key) ?? []) {
				cb(value, prev);
			}
		},
		delete: (key: string) => {
			delete data[key];
		},
		has: (key: string) => getByPath(data, key) !== undefined,
		onDidChange: (key: string, cb: (value: unknown, prev: unknown) => void) => {
			const list = listeners.get(key) ?? [];
			list.push(cb);
			listeners.set(key, list);
			return () => {
				listeners.set(
					key,
					(listeners.get(key) ?? []).filter((x) => x !== cb)
				);
			};
		},
	};

	return {
		store: fakeStore,
		getStoreValue: (key: string) => getByPath(data, key),
		getStoreRaw: (key: string) => {
			const value = getByPath(data, key);
			if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
				return value;
			}
			return;
		},
	};
}
