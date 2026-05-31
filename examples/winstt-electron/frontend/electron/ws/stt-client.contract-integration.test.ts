// Integration tests for the runtime contract-validator wiring inside
// `stt-client.ts`. The validator (`./contract.ts`) is opt-in defense-in-depth:
// it runs in the data-channel JSON dispatch path as a SIGNAL — a contract
// failure logs once per (type, mismatch) and never blocks the dispatch.
//
// These tests deliberately do NOT spin up a WebSocket; the wiring is exercised
// via the exported test helper `_testHandleDataMessage`, which mirrors
// `SttClient.handleDataMessage` byte-for-byte. This file is intentionally
// separate from `stt-client.test.ts` to avoid touching that file's WIP state.

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { debugLogMock } from "@test/mocks/debug-log";

// The SUT's transitive imports pull in `electron/lib/sentry-main`, which
// imports `electron` — neither is available in `bun test` by default. Install
// the same mocks `stt-client.test.ts` does so the module graph resolves. We
// don't drive the SttClient here — only the exported pure helper — but the
// imports happen at module-load regardless.
mock.module("../lib/debug-log", () => debugLogMock());

const { electronMock } = await import("@test/mocks/electron");
mock.module("electron", () => electronMock());

const { _testHandleDataMessage, _testResetContractMismatchCache } = await import("./stt-client");

// Suppress noise from upstream `validateServerEvent` (it logs its own
// `console.warn` on every rejection). We assert on the wiring's own warn, not
// the validator's.
const originalWarn = console.warn;

// Contained boundary cast — the bun mock spy stands in for console.warn.
const asConsoleWarn = (spy: ReturnType<typeof mock>): typeof console.warn =>
	spy as unknown as typeof console.warn;

function installWarnSpy(): ReturnType<typeof mock> {
	const spy = mock(() => undefined);
	console.warn = asConsoleWarn(spy);
	return spy;
}

function restoreWarn(): void {
	console.warn = originalWarn;
}

function countMismatchLogs(spy: ReturnType<typeof mock>): number {
	// The wiring log starts with "[stt-client] Contract mismatch"; the upstream
	// validator log starts with "[ws/contract] rejected". Count only the
	// wiring's.
	let n = 0;
	for (const call of spy.mock.calls) {
		const first = call[0];
		if (typeof first === "string" && first.startsWith("[stt-client] Contract mismatch")) {
			n += 1;
		}
	}
	return n;
}

describe("stt-client contract-validator wiring", () => {
	beforeEach(() => {
		_testResetContractMismatchCache();
		delete process.env.WINSTT_CONTRACT_VALIDATION;
		restoreWarn();
	});

	test("dispatches a valid event AND records a successful contract validation", () => {
		const spy = installWarnSpy();
		const result = _testHandleDataMessage(JSON.stringify({ type: "realtime", text: "hello" }));
		restoreWarn();

		// Dispatch happens (gate schema passed)
		expect(result.dispatched).toMatchObject({ type: "realtime", text: "hello" });
		// Contract validator returned the typed event
		expect(result.validated).toEqual({ type: "realtime", text: "hello" });
		// No mismatch logged
		expect(countMismatchLogs(spy)).toBe(0);
	});

	test("dispatch still happens when contract validation fails (signal-not-gate)", () => {
		const spy = installWarnSpy();
		// audio_level requires `level` in [0, 1]; sending `level: 2` violates the
		// contract schema but passes the dataMessageSchema gate (it only checks
		// `type: string`).
		const result = _testHandleDataMessage(JSON.stringify({ type: "audio_level", level: 2 }));
		restoreWarn();

		// CRITICAL invariant: dispatch is NOT blocked by contract failure
		expect(result.dispatched).toMatchObject({ type: "audio_level", level: 2 });
		// Contract validator rejected
		expect(result.validated).toBeNull();
		// Mismatch was logged once
		expect(countMismatchLogs(spy)).toBe(1);
	});

	test("WINSTT_CONTRACT_VALIDATION=off skips the contract validator entirely", () => {
		process.env.WINSTT_CONTRACT_VALIDATION = "off";
		const spy = installWarnSpy();
		// Same payload as the failure case above
		const result = _testHandleDataMessage(JSON.stringify({ type: "audio_level", level: 2 }));
		restoreWarn();

		// Dispatch still happens
		expect(result.dispatched).toMatchObject({ type: "audio_level", level: 2 });
		// Validator was NOT run — `validated` is null because we skipped, not
		// because the schema rejected.
		expect(result.validated).toBeNull();
		// And critically, NO mismatch log
		expect(countMismatchLogs(spy)).toBe(0);
	});

	test("same shape mismatch repeated N times logs at most once per process lifetime", () => {
		const spy = installWarnSpy();
		const bad = JSON.stringify({ type: "audio_level", level: 2 });
		for (let i = 0; i < 5; i++) {
			_testHandleDataMessage(bad);
		}
		restoreWarn();
		expect(countMismatchLogs(spy)).toBe(1);
	});

	test("different mismatch types log independently (cache is keyed by type)", () => {
		const spy = installWarnSpy();
		// Two different mismatched event types — each should produce its own log.
		_testHandleDataMessage(JSON.stringify({ type: "audio_level", level: 2 }));
		_testHandleDataMessage(JSON.stringify({ type: "realtime" })); // missing `text`
		// Repeat — neither should log again.
		_testHandleDataMessage(JSON.stringify({ type: "audio_level", level: 2 }));
		_testHandleDataMessage(JSON.stringify({ type: "realtime" }));
		restoreWarn();

		expect(countMismatchLogs(spy)).toBe(2);
	});

	test("unknown event types still pass the gate and log a single contract warning", () => {
		const spy = installWarnSpy();
		const result = _testHandleDataMessage(
			JSON.stringify({ type: "future_event_we_dont_know_yet", payload: 42 })
		);
		restoreWarn();

		// Dispatch happens — production must keep working when the server adds
		// new event types ahead of the client.
		expect(result.dispatched).toMatchObject({ type: "future_event_we_dont_know_yet" });
		expect(result.validated).toBeNull();
		expect(countMismatchLogs(spy)).toBe(1);
	});

	test("malformed JSON returns `undefined` parsed and skips contract validation", () => {
		const spy = installWarnSpy();
		const result = _testHandleDataMessage("not-json");
		restoreWarn();

		expect(result.parsed).toBeUndefined();
		expect(result.dispatched).toBeNull();
		expect(result.validated).toBeNull();
		// No contract mismatch should be logged for JSON we couldn't parse.
		expect(countMismatchLogs(spy)).toBe(0);
	});

	test("payload that fails the inner gate (missing `type`) skips contract validation", () => {
		const spy = installWarnSpy();
		const result = _testHandleDataMessage(JSON.stringify({ no_type: true }));
		restoreWarn();

		expect(result.dispatched).toBeNull();
		expect(result.validated).toBeNull();
		// No contract mismatch — the inner gate already rejected this.
		expect(countMismatchLogs(spy)).toBe(0);
	});
});
