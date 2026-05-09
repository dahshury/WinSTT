import { describe, expect, mock, test } from "bun:test";
import { electronMock } from "@test/mocks/electron";

mock.module("electron", () => electronMock());

const relayModule = await import("./relay");
const { __relay_test_helpers__: helpers } = relayModule;

describe("relay module", () => {
	test("exports something importable (smoke test)", () => {
		expect(relayModule).toBeDefined();
	});
});

describe("relay pure helpers", () => {
	test("extractEventText returns string text", () => {
		expect(helpers.extractEventText({ text: "hello" })).toBe("hello");
	});

	test("extractEventText coerces non-strings", () => {
		expect(helpers.extractEventText({ text: 42 })).toBe("42");
		expect(helpers.extractEventText({ text: null })).toBe("");
		expect(helpers.extractEventText({})).toBe("");
	});

	test.each([
		["no_audio_detected", "broadcast"],
		["vad_detect_start", "broadcast"],
		["vad_detect_stop", "broadcast"],
		["transcription_start", "mainSend"],
		["wakeword_detected", "mainSend"],
		["model_download_start", "mainSend"],
	])("pickSenderForSimpleEvent(%p) routes via %s", (type, expected) => {
		const broadcast = () => undefined;
		const mainSend = () => undefined;
		const ctx = {
			broadcast,
			mainSend,
			getMuted: () => false,
			setMuted: () => undefined,
		};
		const sender = helpers.pickSenderForSimpleEvent(type, ctx);
		expect(sender).toBe(expected === "broadcast" ? broadcast : mainSend);
	});

	test("OVERLAY_RELEVANT_SIMPLE_TYPES contains expected overlay-relevant types", () => {
		expect(helpers.OVERLAY_RELEVANT_SIMPLE_TYPES.has("no_audio_detected")).toBe(true);
		expect(helpers.OVERLAY_RELEVANT_SIMPLE_TYPES.has("vad_detect_start")).toBe(true);
		expect(helpers.OVERLAY_RELEVANT_SIMPLE_TYPES.has("vad_detect_stop")).toBe(true);
		expect(helpers.OVERLAY_RELEVANT_SIMPLE_TYPES.has("transcription_start")).toBe(false);
	});

	test("SIMPLE_RELAY_HANDLERS dispatches no_audio_detected without args", () => {
		const calls: Array<{ channel: string; args: unknown[] }> = [];
		const safeSend = (channel: string, ...args: unknown[]) => {
			calls.push({ channel, args });
		};
		const handler = helpers.SIMPLE_RELAY_HANDLERS.no_audio_detected;
		handler?.({}, safeSend);
		expect(calls).toEqual([{ channel: "stt:no-audio-detected", args: [] }]);
	});

	test("SIMPLE_RELAY_HANDLERS forwards transcription_start audio bytes", () => {
		const calls: Array<{ channel: string; args: unknown[] }> = [];
		const safeSend = (channel: string, ...args: unknown[]) => {
			calls.push({ channel, args });
		};
		const handler = helpers.SIMPLE_RELAY_HANDLERS.transcription_start;
		handler?.({ audio_bytes_base64: "abc" }, safeSend);
		expect(calls[0]?.channel).toBe("stt:transcription-start");
		expect(calls[0]?.args[0]).toEqual({ audioBase64: "abc" });
	});

	test("SIMPLE_RELAY_HANDLERS model_download_complete defaults cancelled to false", () => {
		const calls: Array<{ channel: string; args: unknown[] }> = [];
		const safeSend = (channel: string, ...args: unknown[]) => {
			calls.push({ channel, args });
		};
		const handler = helpers.SIMPLE_RELAY_HANDLERS.model_download_complete;
		handler?.({ model: "m" }, safeSend);
		expect(calls[0]?.args[0]).toEqual({ model: "m", cancelled: false });
	});

	test("handleSimpleRelayEvent returns true for known type and forwards", () => {
		const calls: Array<{ channel: string; args: unknown[] }> = [];
		const safeSend = (channel: string, ...args: unknown[]) => {
			calls.push({ channel, args });
		};
		const handled = helpers.handleSimpleRelayEvent("vad_detect_start", {}, safeSend);
		expect(handled).toBe(true);
		expect(calls[0]?.channel).toBe("stt:vad-start");
	});

	test("handleSimpleRelayEvent returns false for unknown type", () => {
		const safeSend = () => undefined;
		expect(helpers.handleSimpleRelayEvent("unknown_type", {}, safeSend)).toBe(false);
	});
});
