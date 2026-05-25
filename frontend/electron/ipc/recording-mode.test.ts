import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	_resetHotkeyRecordingState,
	isAnyHotkeyRecording,
	onHotkeyRecordingChange,
	setHotkeyRecording,
} from "./recording-mode";

beforeEach(() => {
	_resetHotkeyRecordingState();
});

afterEach(() => {
	_resetHotkeyRecordingState();
});

describe("recording-mode flag", () => {
	test("starts in the not-recording state", () => {
		expect(isAnyHotkeyRecording()).toBe(false);
	});

	test("setHotkeyRecording(true) flips the flag", () => {
		setHotkeyRecording(true);
		expect(isAnyHotkeyRecording()).toBe(true);
	});

	test("setHotkeyRecording(false) flips back", () => {
		setHotkeyRecording(true);
		setHotkeyRecording(false);
		expect(isAnyHotkeyRecording()).toBe(false);
	});

	test("redundant set to the same value does not re-fire listeners (edge-only)", () => {
		// Edge-only emission is the contract that bounds repaste's expensive
		// unregister/register cycle. Two consecutive `true` calls must produce
		// exactly one listener invocation.
		const calls: boolean[] = [];
		onHotkeyRecordingChange((v) => calls.push(v));
		setHotkeyRecording(true);
		setHotkeyRecording(true);
		setHotkeyRecording(true);
		expect(calls).toEqual([true]);
		setHotkeyRecording(false);
		setHotkeyRecording(false);
		expect(calls).toEqual([true, false]);
	});

	test("multiple subscribers all receive the edge", () => {
		const a: boolean[] = [];
		const b: boolean[] = [];
		onHotkeyRecordingChange((v) => a.push(v));
		onHotkeyRecordingChange((v) => b.push(v));
		setHotkeyRecording(true);
		expect(a).toEqual([true]);
		expect(b).toEqual([true]);
	});

	test("unsubscribe stops further notifications", () => {
		const calls: boolean[] = [];
		const off = onHotkeyRecordingChange((v) => calls.push(v));
		setHotkeyRecording(true);
		off();
		setHotkeyRecording(false);
		expect(calls).toEqual([true]);
	});

	test("a throwing subscriber does not break sibling subscribers", () => {
		// Spec: a misbehaving subscriber must not take down the others. The
		// repaste handler in particular relies on this — we don't want a bug
		// in tts-hotkey to block the re-paste rebuild.
		const survivors: boolean[] = [];
		onHotkeyRecordingChange(() => {
			throw new Error("boom");
		});
		onHotkeyRecordingChange((v) => survivors.push(v));
		setHotkeyRecording(true);
		expect(survivors).toEqual([true]);
	});
});
