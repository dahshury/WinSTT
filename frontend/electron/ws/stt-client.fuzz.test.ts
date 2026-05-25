import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { debugLogMock } from "@test/mocks/debug-log";
import fc from "fast-check";

mock.module("../lib/debug-log", () => debugLogMock());
const { electronMock } = await import("@test/mocks/electron");
mock.module("electron", () => electronMock());

const { _testHandleDataMessage, _testResetContractMismatchCache } = await import("./stt-client");

beforeEach(() => {
	_testResetContractMismatchCache();
	Reflect.deleteProperty(Object.prototype, "polluted");
});

afterEach(() => {
	Reflect.deleteProperty(Object.prototype, "polluted");
});

function callSafely(raw: string): { threw: boolean; result?: unknown } {
	try {
		return { result: _testHandleDataMessage(raw), threw: false };
	} catch (err) {
		return { result: err, threw: true };
	}
}

describe("stt-client fuzz: totality", () => {
	test("random strings never throw", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 2000 }), (raw) => {
				const { threw } = callSafely(raw);
				expect(threw).toBe(false);
			}),
			{ numRuns: 500 }
		);
	});

	test("unicode strings never throw", () => {
		fc.assert(
			fc.property(fc.string({ unit: "grapheme", maxLength: 5000 }), (raw) => {
				const { threw } = callSafely(raw);
				expect(threw).toBe(false);
			}),
			{ numRuns: 500 }
		);
	});

	test("JSON-shaped values never throw", () => {
		fc.assert(
			fc.property(fc.jsonValue(), (v) => {
				const raw = JSON.stringify(v);
				const { threw } = callSafely(raw);
				expect(threw).toBe(false);
			}),
			{ numRuns: 500 }
		);
	});

	test("raw byte-stream decoded as UTF-8 never throws", () => {
		fc.assert(
			fc.property(fc.uint8Array({ maxLength: 10_000 }), (bytes) => {
				const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
				const { threw } = callSafely(raw);
				expect(threw).toBe(false);
			}),
			{ numRuns: 500 }
		);
	});
});

describe("stt-client fuzz: return-shape consistency", () => {
	test("result is always { parsed, dispatched, validated }", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 1000 }), (raw) => {
				const { result } = callSafely(raw);
				expect(result).toBeDefined();
				const r = result as Record<string, unknown>;
				expect("parsed" in r).toBe(true);
				expect("dispatched" in r).toBe(true);
				expect("validated" in r).toBe(true);
			}),
			{ numRuns: 200 }
		);
	});

	test("dispatched is null when parse fails or schema fails", () => {
		const { result } = callSafely("not json {{{");
		const r = result as { dispatched: unknown };
		expect(r.dispatched).toBeNull();
	});
});

describe("stt-client fuzz: prototype pollution", () => {
	test("payload with __proto__ does not pollute Object.prototype", () => {
		const seeds = [
			'{"__proto__":{"polluted":true},"type":"x"}',
			'{"constructor":{"prototype":{"polluted":true}},"type":"y"}',
			'{"__proto__":{"polluted":42}}',
		];
		for (const raw of seeds) {
			const { threw } = callSafely(raw);
			expect(threw).toBe(false);
		}
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	test("random property names including __proto__ do not pollute", () => {
		fc.assert(
			fc.property(
				fc.dictionary(
					fc.constantFrom("__proto__", "constructor", "prototype", "polluted"),
					fc.jsonValue()
				),
				(obj) => {
					const raw = JSON.stringify(obj);
					callSafely(raw);
					expect(({} as Record<string, unknown>).polluted).toBeUndefined();
				}
			),
			{ numRuns: 200 }
		);
	});
});

describe("stt-client fuzz: adversarial seeds", () => {
	const seeds: string[] = [
		"",
		"null",
		"undefined",
		"true",
		"false",
		"0",
		"[]",
		"{}",
		"[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]",
		`{"type":"${"x".repeat(10_000)}"}`,
		'﻿{"type":"realtime","text":"hello"}',
		'{"type":"‮‭"}',
		"\x00\x01\x02",
		"\r\n\r\n",
		`{"type":"a","extra":"${"\\u0000".repeat(100)}"}`,
	];

	for (const seed of seeds) {
		test(`adversarial seed: ${JSON.stringify(seed).slice(0, 60)}`, () => {
			const { threw } = callSafely(seed);
			expect(threw).toBe(false);
		});
	}
});

describe("stt-client fuzz: large input bounds", () => {
	test("very long string does not crash (1 MB cap)", () => {
		const raw = `{"type":"realtime","text":"${"x".repeat(1_000_000)}"}`;
		const { threw } = callSafely(raw);
		expect(threw).toBe(false);
	});

	test("deeply nested arrays do not crash", () => {
		const raw = "[".repeat(5000) + "]".repeat(5000);
		const { threw } = callSafely(raw);
		expect(threw).toBe(false);
	});
});
