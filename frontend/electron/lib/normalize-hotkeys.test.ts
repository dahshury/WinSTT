/**
 * Unit tests for the boot-time hotkey normalization pass. We exercise the
 * exported `normalizePersistedHotkeys` directly with stub read/write so we
 * don't pull in electron-store. The integration with the live `store` object
 * is covered implicitly by the broader store tests; here we cover the rewrite
 * policy in isolation.
 */
import { describe, expect, test } from "bun:test";
import { normalizePersistedHotkeys } from "./normalize-hotkeys";

function makeIO(initial: Record<string, unknown>) {
	const state: Record<string, unknown> = { ...initial };
	const writes: [string, unknown][] = [];
	return {
		state,
		writes,
		read: (key: string): unknown => state[key],
		write: (key: string, value: unknown): void => {
			state[key] = value;
			writes.push([key, value]);
		},
	};
}

describe("normalizePersistedHotkeys", () => {
	test("no rewrites when all three hotkeys are disjoint", () => {
		const io = makeIO({
			"hotkey.pushToTalkKey": "LCtrl+LMeta",
			"general.repasteHotkey": "LCtrl+LShift+V",
			"tts.hotkey": "LMeta+LShift+E",
		});
		const rewrites = normalizePersistedHotkeys(io.read, io.write);
		expect(rewrites).toEqual([]);
		expect(io.writes).toEqual([]);
	});

	test("rewrites repaste when it equals PTT", () => {
		const io = makeIO({
			"hotkey.pushToTalkKey": "LCtrl+A",
			"general.repasteHotkey": "LCtrl+A",
			"tts.hotkey": "LMeta+LShift+E",
		});
		const rewrites = normalizePersistedHotkeys(io.read, io.write);
		expect(rewrites).toContain("repasteHotkey");
		expect(io.state["general.repasteHotkey"]).toBe("LCtrl+LShift+V");
	});

	test("rewrites TTS when it is a subset of repaste", () => {
		const io = makeIO({
			"hotkey.pushToTalkKey": "LCtrl+LMeta",
			"general.repasteHotkey": "LCtrl+LShift+V",
			"tts.hotkey": "LCtrl+LShift", // subset of repaste
		});
		const rewrites = normalizePersistedHotkeys(io.read, io.write);
		expect(rewrites).toContain("ttsHotkey");
		expect(io.state["tts.hotkey"]).toBe("LMeta+LShift+E");
	});

	test("rewrites both repaste and TTS when both clash with PTT", () => {
		const io = makeIO({
			"hotkey.pushToTalkKey": "LCtrl+LShift+V",
			"general.repasteHotkey": "LCtrl+LShift+V",
			"tts.hotkey": "LCtrl+LShift+V+E",
		});
		const rewrites = normalizePersistedHotkeys(io.read, io.write);
		expect(rewrites).toEqual(["repasteHotkey", "ttsHotkey"]);
		expect(io.state["general.repasteHotkey"]).toBe("LCtrl+LShift+V");
		expect(io.state["tts.hotkey"]).toBe("LMeta+LShift+E");
	});

	test("empty / missing persisted values are treated as defaults (and not rewritten)", () => {
		const io = makeIO({}); // all missing → all defaults
		const rewrites = normalizePersistedHotkeys(io.read, io.write);
		expect(rewrites).toEqual([]);
		expect(io.writes).toEqual([]);
	});

	test("PTT is never rewritten — even when it is the anchor of the conflict", () => {
		const io = makeIO({
			"hotkey.pushToTalkKey": "LCtrl+LShift+V", // colliding with repaste default
			"general.repasteHotkey": "LCtrl+LShift+V",
			"tts.hotkey": "LMeta+LShift+E",
		});
		normalizePersistedHotkeys(io.read, io.write);
		expect(io.state["hotkey.pushToTalkKey"]).toBe("LCtrl+LShift+V");
		// repaste was rewritten to its default — fine, but PTT itself stays put.
		expect(io.writes.find(([k]) => k === "hotkey.pushToTalkKey")).toBeUndefined();
	});
});
