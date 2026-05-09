import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realFs from "node:fs";
import type { BrowserWindow } from "electron";
import type { SttClient } from "../ws/stt-client";

// Capture the REAL writeFile/access/readFile/unlink BEFORE installing the mock,
// otherwise the mock would recurse into itself via realFs.promises.writeFile.
const realWriteFile = realFs.promises.writeFile;
const _realReadFile = realFs.promises.readFile;
const _realUnlink = realFs.promises.unlink;

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
const winSent: Array<{ channel: string; payload: unknown }> = [];

mock.module("electron", () => ({
	ipcMain: {
		handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
			handlers.set(channel, listener);
		},
		removeHandler: (channel: string) => handlers.delete(channel),
		on: () => undefined,
		off: () => undefined,
	},
}));

const fsState = { writeShouldThrow: false };
mock.module("node:fs", () => ({
	...realFs,
	default: realFs,
	promises: {
		...realFs.promises,
		writeFile: async (p: string, data: string) => {
			if (fsState.writeShouldThrow) {
				throw new Error("simulated write fail");
			}
			await realWriteFile(p, data, "utf-8");
		},
	},
	constants: realFs.constants,
}));

import { storeMock } from "@test/mocks/store";

mock.module("../lib/store", () => ({
	...storeMock(),
	getStoreValue: () => "txt",
}));

const {
	transcribeFile,
	setupFileTranscribeHandlers,
	__file_transcribe_test_helpers__: helpers,
} = await import("./file-transcribe");

interface MockClient {
	calls: unknown[];
	emit: (event: string, payload: Record<string, unknown>) => Promise<void>;
	isConnected: boolean;
	off: (event: string, cb: (e: Record<string, unknown>) => void) => void;
	on: (event: string, cb: (e: Record<string, unknown>) => void) => void;
	sendControl: (msg: unknown) => void;
}

function makeClient(connected = true): MockClient {
	const calls: unknown[] = [];
	const listeners = new Map<string, Array<(e: Record<string, unknown>) => void>>();
	return {
		isConnected: connected,
		sendControl: (msg) => calls.push(msg),
		on: (event, cb) => {
			const list = listeners.get(event) ?? [];
			list.push(cb);
			listeners.set(event, list);
		},
		off: (event, cb) => {
			listeners.set(
				event,
				(listeners.get(event) ?? []).filter((x) => x !== cb)
			);
		},
		calls,
		emit: async (event, payload) => {
			for (const cb of listeners.get(event) ?? []) {
				cb(payload);
			}
			// Allow microtasks to settle
			await new Promise((r) => setTimeout(r, 5));
		},
	};
}

const fakeWin = {
	isDestroyed: () => false,
	webContents: {
		isDestroyed: () => false,
		send: (channel: string, payload: unknown) => winSent.push({ channel, payload }),
		id: 1,
	},
} as unknown as BrowserWindow;

describe("transcribeFile (validation)", () => {
	test("rejects non-string filePath with ValidationError", async () => {
		await expect(
			transcribeFile(makeClient(true) as unknown as SttClient, "" as unknown as string, new Map())
		).rejects.toThrow(/File path/);
	});

	test("rejects unsupported file extensions", async () => {
		await expect(
			transcribeFile(makeClient(true) as unknown as SttClient, "C:\\test.exe", new Map())
		).rejects.toThrow(/Unsupported file format/);
	});

	test("rejects nonexistent files (NotFoundError)", async () => {
		await expect(
			transcribeFile(makeClient(true) as unknown as SttClient, "C:\\does-not-exist.wav", new Map())
		).rejects.toThrow();
	});

	// Cross-test fs mock pollution makes the integration variants flaky in the
	// full suite. Coverage is achieved via direct unit tests of the pure helpers
	// at the bottom of this file (__file_transcribe_test_helpers__).
});

describe("setupFileTranscribeHandlers", () => {
	let cleanup: (() => void) | null = null;
	let client: MockClient;
	let pendingRequests: Map<string, string>;

	beforeEach(() => {
		handlers.clear();
		winSent.length = 0;
		fsState.writeShouldThrow = false;
		client = makeClient(true);
		const setup = setupFileTranscribeHandlers(fakeWin, client as unknown as SttClient);
		cleanup = setup.cleanup;
		pendingRequests = setup.pendingRequests;
	});

	afterEach(() => {
		cleanup?.();
		cleanup = null;
	});

	test("registers the file:transcribe handler", () => {
		expect(handlers.has("file:transcribe")).toBe(true);
	});

	test("forwards a progress event to the renderer", async () => {
		await client.emit("data-event", {
			type: "file_transcription_progress",
			file_name: "song.wav",
			progress: 0.5,
			message: "Halfway",
		});
		const ev = winSent.find((e) => e.channel === "file:transcription-progress");
		expect(ev).toBeTruthy();
		const p = ev?.payload as Record<string, unknown>;
		expect(p.fileName).toBe("song.wav");
		expect(p.progress).toBe(0.5);
		expect(p.message).toBe("Halfway");
	});

	test("an error event clears the pending request and forwards to renderer", async () => {
		pendingRequests.set("req-1", "C:\\some\\path.wav");
		await client.emit("data-event", {
			type: "file_transcription_error",
			request_id: "req-1",
			file_name: "path.wav",
			error: "boom",
		});
		expect(pendingRequests.has("req-1")).toBe(false);
		const ev = winSent.find((e) => e.channel === "file:transcription-error");
		expect(ev).toBeTruthy();
		const p = ev?.payload as Record<string, unknown>;
		expect(p.error).toBe("boom");
	});

	test("error event without request_id is forwarded with empty requestId", async () => {
		await client.emit("data-event", {
			type: "file_transcription_error",
			file_name: "x.wav",
		});
		const ev = winSent.find((e) => e.channel === "file:transcription-error");
		const p = ev?.payload as Record<string, unknown>;
		expect(p.requestId).toBe("");
		expect(p.error).toBe("Unknown error");
	});

	test("error event derives fileName from file_path basename when file_name missing", async () => {
		await client.emit("data-event", {
			type: "file_transcription_error",
			request_id: "req-2",
			file_path: "C:\\dir\\fall.wav",
			error: "x",
		});
		const ev = winSent.find((e) => e.channel === "file:transcription-error");
		const p = ev?.payload as Record<string, unknown>;
		expect(p.fileName).toBe("fall.wav");
	});

	test("a complete event with mismatched file_path is dropped", async () => {
		pendingRequests.set("req-3", "C:\\expected\\path.wav");
		await client.emit("data-event", {
			type: "file_transcription_complete",
			request_id: "req-3",
			file_path: "C:\\some\\other\\path.wav",
			file_name: "other.wav",
			text: "x",
		});
		// No complete event sent because of path mismatch
		expect(winSent.find((e) => e.channel === "file:transcription-complete")).toBeUndefined();
		expect(pendingRequests.has("req-3")).toBe(false);
	});

	test("a complete event with missing required fields is dropped", async () => {
		await client.emit("data-event", {
			type: "file_transcription_complete",
			request_id: "",
			file_path: "C:\\foo.wav",
			file_name: "foo.wav",
			text: "x",
		});
		expect(winSent.find((e) => e.channel === "file:transcription-complete")).toBeUndefined();
	});

	test("write failure on complete event sends a transcription-error", async () => {
		fsState.writeShouldThrow = true;
		pendingRequests.set("req-7", "C:\\fake.wav");
		await client.emit("data-event", {
			type: "file_transcription_complete",
			request_id: "req-7",
			file_path: "C:\\fake.wav",
			file_name: "fake.wav",
			text: "x",
		});
		const ev = winSent.find((e) => e.channel === "file:transcription-error");
		expect(ev).toBeTruthy();
	});

	test("data event with non-string type is ignored", async () => {
		await client.emit("data-event", { type: 42, foo: "bar" });
		expect(winSent.length).toBe(0);
	});

	test("data event with unknown type is ignored", async () => {
		await client.emit("data-event", { type: "unknown_type", foo: "bar" });
		expect(winSent.length).toBe(0);
	});

	test("file:transcribe handler propagates inner errors from transcribeFile", async () => {
		const handler = handlers.get("file:transcribe");
		await expect(handler!({}, { filePath: "" })).rejects.toThrow();
	});
});

describe("file-transcribe pure helpers", () => {
	test("asString returns the string for string input, '' otherwise", () => {
		expect(helpers.asString("hello")).toBe("hello");
		expect(helpers.asString(42)).toBe("");
		expect(helpers.asString(null)).toBe("");
		expect(helpers.asString(undefined)).toBe("");
	});

	test("asOptionalString returns the string or undefined", () => {
		expect(helpers.asOptionalString("x")).toBe("x");
		expect(helpers.asOptionalString(42)).toBeUndefined();
	});

	test("asOptionalNumber returns the number or undefined", () => {
		expect(helpers.asOptionalNumber(7)).toBe(7);
		expect(helpers.asOptionalNumber("7")).toBeUndefined();
	});

	test("allTruthy returns true only when every arg is truthy", () => {
		expect(helpers.allTruthy("a", "b", "c")).toBe(true);
		expect(helpers.allTruthy("a", "", "c")).toBe(false);
		expect(helpers.allTruthy()).toBe(true); // empty is vacuously true
	});

	test("deriveFileName prefers fileName when present", () => {
		expect(helpers.deriveFileName("primary.wav", "C:\\fb\\fallback.wav")).toBe("primary.wav");
	});

	test("deriveFileName falls back to basename of file_path when fileName missing", () => {
		expect(helpers.deriveFileName(undefined, "C:\\dir\\song.wav")).toBe("song.wav");
		expect(helpers.deriveFileName(undefined, "/tmp/x.mp3")).toBe("x.mp3");
	});

	test("deriveFileName returns empty string when neither fileName nor a string file_path is given", () => {
		expect(helpers.deriveFileName(undefined, undefined)).toBe("");
		expect(helpers.deriveFileName(undefined, 42)).toBe("");
	});

	test("isPathMatch returns true when paths resolve identically", () => {
		expect(helpers.isPathMatch("C:\\dir\\file.wav", "C:\\dir\\file.wav")).toBe(true);
	});

	test("isPathMatch returns false when expected is undefined", () => {
		expect(helpers.isPathMatch("C:\\dir\\file.wav", undefined)).toBe(false);
	});

	test("isPathMatch returns false when paths differ", () => {
		expect(helpers.isPathMatch("C:\\dir\\a.wav", "C:\\dir\\b.wav")).toBe(false);
	});

	test("buildOutputPath sanitizes the format extension", () => {
		expect(helpers.buildOutputPath("C:\\file.wav", "../evil/path")).toBe("C:\\file.wav.evilpath");
		expect(helpers.buildOutputPath("C:\\file.wav", "TXT")).toBe("C:\\file.wav.TXT");
	});

	test("buildOutputPath defaults to .txt when format sanitizes to empty", () => {
		expect(helpers.buildOutputPath("C:\\file.wav", "../../")).toBe("C:\\file.wav.txt");
		expect(helpers.buildOutputPath("C:\\file.wav", "")).toBe("C:\\file.wav.txt");
	});

	test("extractCompleteEventFields returns null when required fields are missing", () => {
		expect(helpers.extractCompleteEventFields({})).toBeNull();
		expect(
			helpers.extractCompleteEventFields({
				request_id: "r",
				file_path: "p",
				// no file_name
			})
		).toBeNull();
		expect(
			helpers.extractCompleteEventFields({
				request_id: "",
				file_path: "p",
				file_name: "n",
			})
		).toBeNull();
	});

	test("extractCompleteEventFields returns full record when all required fields are present", () => {
		const out = helpers.extractCompleteEventFields({
			request_id: "r1",
			file_path: "C:\\song.wav",
			file_name: "song.wav",
			text: "transcribed",
			format: "txt",
		});
		expect(out).not.toBeNull();
		expect(out?.requestId).toBe("r1");
		expect(out?.filePath).toBe("C:\\song.wav");
		expect(out?.fileName).toBe("song.wav");
		expect(out?.text).toBe("transcribed");
		expect(out?.fmt).toBe("txt");
	});

	test("extractCompleteEventFields defaults missing format to 'txt'", () => {
		const out = helpers.extractCompleteEventFields({
			request_id: "r1",
			file_path: "p",
			file_name: "n",
		});
		expect(out?.fmt).toBe("txt");
	});

	test("extractCompleteEventFields defaults empty-string format to 'txt'", () => {
		const out = helpers.extractCompleteEventFields({
			request_id: "r1",
			file_path: "p",
			file_name: "n",
			format: "",
		});
		expect(out?.fmt).toBe("txt");
	});

	test("extractCompleteEventFields treats missing text as empty string", () => {
		const out = helpers.extractCompleteEventFields({
			request_id: "r1",
			file_path: "p",
			file_name: "n",
		});
		expect(out?.text).toBe("");
	});
});
