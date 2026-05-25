/**
 * Property tests for the pure server-skew detection helpers in relay.ts.
 *
 * `findMissingServerMethods` and `extractAllowedMethods` are the only pure,
 * IO-free helpers in the high-CRAP region we can property-test without
 * standing up the full relay machinery. They're set-difference / safe-cast
 * helpers, ideal for invariant-based testing:
 *
 *   - extractAllowedMethods returns an array for every input (total).
 *   - findMissingServerMethods is a subset of REQUIRED_SERVER_METHODS.
 *   - findMissingServerMethods drops every method that is present in the
 *     payload's allowed_methods (set-difference correctness).
 *
 * We mock `electron`, `node:fs`, and the helpers' usual dependencies the
 * same way relay.test.ts does so the module imports cleanly.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { electronMock } from "@test/mocks/electron";
import { storeMock } from "@test/mocks/store";
import fc from "fast-check";

const mockWindows: unknown[] = [];
const storeValues: Record<string, unknown> = {};

mock.module("electron", () => ({
	...electronMock(),
	BrowserWindow: {
		getAllWindows: () => mockWindows,
		isDestroyed: () => false,
	},
	ipcMain: {
		handle: () => undefined,
		removeHandler: () => undefined,
	},
}));

mock.module("../lib/store", () => {
	const base = storeMock();
	return {
		...base,
		getStoreValue: (key: string) => storeValues[key],
		getStoreRaw: (key: string) => {
			const v = storeValues[key];
			if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
				return v;
			}
			return;
		},
		store: {
			...base.store,
			get: (k: string) => storeValues[k],
			set: (k: string, v: unknown) => {
				storeValues[k] = v;
			},
			onDidChange: () => () => undefined,
		},
	};
});

const { __relay_test_helpers__: helpers } = await import("./relay");

// Coverage-mode runs reuse mocked modules across the worker; restore so a
// later integration suite that calls setupRelay() gets the real ipcMain.
afterAll(async () => {
	const recordingState = await import("../lib/recording-state");
	recordingState.notifyRecordingStop();
	recordingState.__resetRecordingStateForTesting__();
});

// Arbitraries ---------------------------------------------------------------

// Synthesise plausible runtime-info shapes plus garbage payloads. The
// production payload has shape `{ allowed_methods: string[] }`; everything
// else (null, primitives, missing field, wrong type) must round-trip to []
// via the safe-cast helper.
const garbageInfoArb = fc.oneof(
	fc.constant(null),
	fc.constant(undefined),
	fc.string(),
	fc.integer(),
	fc.boolean(),
	fc.record({ allowed_methods: fc.constant("not-an-array") }),
	fc.record({ allowed_methods: fc.constant(null) }),
	fc.record({ other_field: fc.string() })
);

const validInfoArb = fc.array(fc.string(), { maxLength: 12 }).map((methods) => ({
	allowed_methods: methods,
}));

// extractAllowedMethods -----------------------------------------------------

describe("extractAllowedMethods (property)", () => {
	test("always returns an array (total function)", () => {
		fc.assert(
			fc.property(fc.oneof(garbageInfoArb, validInfoArb), (info) =>
				Array.isArray(helpers.extractAllowedMethods(info))
			),
			{ numRuns: 300 }
		);
	});

	test("returns [] for any non-record / missing-field input", () => {
		fc.assert(
			fc.property(garbageInfoArb, (info) => helpers.extractAllowedMethods(info).length === 0),
			{ numRuns: 200 }
		);
	});

	test("returns the array verbatim when allowed_methods is an array", () => {
		fc.assert(
			fc.property(fc.array(fc.string(), { maxLength: 12 }), (methods) => {
				const out = helpers.extractAllowedMethods({ allowed_methods: methods });
				return Array.isArray(out) && out.length === methods.length;
			}),
			{ numRuns: 200 }
		);
	});
});

// findMissingServerMethods --------------------------------------------------

describe("findMissingServerMethods (property)", () => {
	const required = helpers.REQUIRED_SERVER_METHODS;

	test("output is always a subset of REQUIRED_SERVER_METHODS", () => {
		fc.assert(
			fc.property(fc.oneof(garbageInfoArb, validInfoArb), (info) => {
				const missing = helpers.findMissingServerMethods(info);
				return missing.every((m) => (required as readonly string[]).includes(m));
			}),
			{ numRuns: 300 }
		);
	});

	test("any method declared in allowed_methods is NOT reported missing", () => {
		fc.assert(
			fc.property(
				fc.array(fc.string(), { maxLength: 12 }),
				fc.subarray([...required] as string[]),
				(extra, present) => {
					const allowed = [...extra, ...present];
					const missing = helpers.findMissingServerMethods({ allowed_methods: allowed });
					return present.every((m) => !missing.includes(m));
				}
			),
			{ numRuns: 200 }
		);
	});

	test("output never duplicates a required method", () => {
		fc.assert(
			fc.property(fc.oneof(garbageInfoArb, validInfoArb), (info) => {
				const missing = helpers.findMissingServerMethods(info);
				return new Set(missing).size === missing.length;
			}),
			{ numRuns: 200 }
		);
	});

	test("empty allowed_methods → ALL required methods are missing", () => {
		const missing = helpers.findMissingServerMethods({ allowed_methods: [] });
		expect(missing).toEqual([...required]);
	});

	test("complete allowed_methods → ZERO missing methods", () => {
		const missing = helpers.findMissingServerMethods({ allowed_methods: [...required] });
		expect(missing).toEqual([]);
	});

	test("garbage input → ALL required methods are missing (safe fallback)", () => {
		fc.assert(
			fc.property(garbageInfoArb, (info) => {
				const missing = helpers.findMissingServerMethods(info);
				return missing.length === required.length;
			}),
			{ numRuns: 200 }
		);
	});
});

// handleRecordingStop — light invariant checks ------------------------------

describe("handleRecordingStop (property)", () => {
	function makeSafeSend(): { calls: string[]; send: (ch: string) => void } {
		const calls: string[] = [];
		return {
			calls,
			send: (channel: string) => calls.push(channel),
		};
	}

	test("always returns false (post-condition: not muted after stop)", () => {
		fc.assert(
			fc.property(fc.boolean(), (wasMuted) => {
				const { send } = makeSafeSend();
				return helpers.handleRecordingStop(wasMuted, send) === false;
			}),
			{ numRuns: 100 }
		);
	});

	test("always emits the stt:recording-stop channel exactly once", () => {
		fc.assert(
			fc.property(fc.boolean(), (wasMuted) => {
				const { calls, send } = makeSafeSend();
				helpers.handleRecordingStop(wasMuted, send);
				return calls.filter((c) => c === "stt:recording-stop").length === 1;
			}),
			{ numRuns: 100 }
		);
	});
});
