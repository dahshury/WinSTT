import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import fc from "fast-check";
import { IPC } from "@/shared/api/ipc-channels";
import { useKeyRecorder } from "./use-key-recorder";

// ─── Mock IPC plumbing ─────────────────────────────────────────────────
// The hook's "state machine" is driven by four actions:
//   1. startRecording()                      → invokes HOTKEY_START_RECORDING
//   2. stopRecording()                       → sends   HOTKEY_STOP_RECORDING
//   3. main → renderer  HOTKEY_RECORDING_UPDATE  { keys }
//   4. main → renderer  HOTKEY_RECORDING_DONE    { combo }
//
// Properties below drive random permutations of these four actions and
// verify the invariants the user spec'd (adapted from a key-event hook to
// this IPC-event hook).

const originalApi = window.electronAPI;
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
const sentChannels: string[] = [];
const invokes: string[] = [];

function makeApi() {
	listeners.clear();
	sentChannels.length = 0;
	invokes.length = 0;
	return {
		...originalApi,
		invoke: async (channel: string) => {
			invokes.push(channel);
			return false;
		},
		send: (channel: string) => {
			sentChannels.push(channel);
		},
		on: (channel: string, cb: (...args: unknown[]) => void) => {
			const list = listeners.get(channel) ?? [];
			list.push(cb);
			listeners.set(channel, list);
			return () => {
				listeners.set(
					channel,
					(listeners.get(channel) ?? []).filter((x) => x !== cb)
				);
			};
		},
	};
}

function fire(channel: string, ...args: unknown[]) {
	for (const cb of listeners.get(channel) ?? []) {
		cb(...args);
	}
}

beforeEach(() => {
	window.electronAPI = makeApi();
});

afterEach(() => {
	window.electronAPI = originalApi;
});

// ─── Arbitraries ───────────────────────────────────────────────────────
// "Keys" the main process might report; mix modifier-like + ordinary tokens
// to mirror the real hotkey vocabulary.
const KEY_TOKEN = fc.constantFrom(
	"LCtrl",
	"RCtrl",
	"LShift",
	"RShift",
	"LAlt",
	"RAlt",
	"LWin",
	"RWin",
	"A",
	"B",
	"Enter",
	"Tab",
	"F1",
	"Space"
);

const COMBO_ARB = fc.oneof(
	fc.constant<string | null>(null),
	fc.array(KEY_TOKEN, { minLength: 1, maxLength: 4 }).map((ks) => Array.from(new Set(ks)).join("+"))
);

type Action =
	| { tag: "start" }
	| { tag: "stop" }
	| { tag: "update"; keys: string[] }
	| { tag: "done"; combo: string | null };

const ACTION_ARB: fc.Arbitrary<Action> = fc.oneof(
	fc.constant<Action>({ tag: "start" }),
	fc.constant<Action>({ tag: "stop" }),
	fc.array(KEY_TOKEN, { maxLength: 4 }).map<Action>((keys) => ({ tag: "update", keys })),
	COMBO_ARB.map<Action>((combo) => ({ tag: "done", combo }))
);

function applyAction(result: { current: ReturnType<typeof useKeyRecorder> }, action: Action) {
	switch (action.tag) {
		case "start":
			act(() => result.current.startRecording());
			break;
		case "stop":
			act(() => result.current.stopRecording());
			break;
		case "update":
			act(() => fire(IPC.HOTKEY_RECORDING_UPDATE, { keys: action.keys }));
			break;
		case "done":
			act(() => fire(IPC.HOTKEY_RECORDING_DONE, { combo: action.combo }));
			break;
		default: {
			const _exhaustive: never = action;
			throw new Error(`unreachable: ${String(_exhaustive)}`);
		}
	}
}

function isStringOrNull(v: unknown): v is string | null {
	return v === null || typeof v === "string";
}

// ─── Properties ────────────────────────────────────────────────────────

test("property: state fields are always well-typed (no undefined leaks)", () => {
	fc.assert(
		fc.property(fc.array(ACTION_ARB, { maxLength: 20 }), (actions) => {
			const { result, unmount } = renderHook(() => useKeyRecorder());
			try {
				for (const action of actions) {
					applyAction(result, action);
					// Invariant: recording must always be a boolean (never undefined)
					expect(typeof result.current.recording).toBe("boolean");
					// key is string|null (never undefined)
					expect(isStringOrNull(result.current.key)).toBe(true);
					// liveKeys is always an array of strings
					expect(Array.isArray(result.current.liveKeys)).toBe(true);
					for (const k of result.current.liveKeys) {
						expect(typeof k).toBe("string");
					}
				}
			} finally {
				unmount();
			}
		}),
		{ numRuns: 75 }
	);
});

test("property: a final stop+done sequence terminates recording (no stuck-in-recording state)", () => {
	fc.assert(
		fc.property(fc.array(ACTION_ARB, { maxLength: 15 }), COMBO_ARB, (actions, finalCombo) => {
			const { result, unmount } = renderHook(() => useKeyRecorder());
			try {
				for (const action of actions) {
					applyAction(result, action);
				}
				// Force a clean termination: stop, then deliver the done reply
				// the main process would normally emit.
				applyAction(result, { tag: "stop" });
				applyAction(result, { tag: "done", combo: finalCombo });
				// Invariant: recording is false, liveKeys cleared.
				expect(result.current.recording).toBe(false);
				expect(result.current.liveKeys).toEqual([]);
			} finally {
				unmount();
			}
		}),
		{ numRuns: 75 }
	);
});

test("property: liveKeys are ignored while not recording", () => {
	fc.assert(
		fc.property(
			fc.array(KEY_TOKEN, { maxLength: 4 }),
			fc.array(KEY_TOKEN, { maxLength: 4 }),
			(keysBefore, keysAfter) => {
				const { result, unmount } = renderHook(() => useKeyRecorder());
				try {
					// Fire updates BEFORE starting — should be ignored.
					applyAction(result, { tag: "update", keys: keysBefore });
					expect(result.current.liveKeys).toEqual([]);

					applyAction(result, { tag: "start" });
					applyAction(result, { tag: "update", keys: keysAfter });
					expect(result.current.liveKeys).toEqual(keysAfter);

					// Stop, then any further update is ignored (recordingRef=false).
					applyAction(result, { tag: "stop" });
					const snapshot = result.current.liveKeys;
					applyAction(result, { tag: "update", keys: keysBefore });
					// After stop, recordingRef is false, so liveKeys must NOT update.
					expect(result.current.liveKeys).toEqual(snapshot);
				} finally {
					unmount();
				}
			}
		),
		{ numRuns: 60 }
	);
});

test("property: done event before start is ignored (no orphan key commit)", () => {
	fc.assert(
		fc.property(COMBO_ARB, (combo) => {
			const { result, unmount } = renderHook(() => useKeyRecorder());
			try {
				// pendingDoneRef starts false — done with no prior start must be a no-op.
				applyAction(result, { tag: "done", combo });
				expect(result.current.key).toBeNull();
				expect(result.current.recording).toBe(false);
			} finally {
				unmount();
			}
		}),
		{ numRuns: 50 }
	);
});

test("property: at most one done event ever commits per start (subsequent dones are dropped)", () => {
	fc.assert(
		fc.property(
			fc.string({ minLength: 1, maxLength: 8 }),
			fc.string({ minLength: 1, maxLength: 8 }),
			(firstCombo, secondCombo) => {
				const calls: string[] = [];
				const { result, unmount } = renderHook(() =>
					useKeyRecorder({ onKeyRecorded: (k) => calls.push(k) })
				);
				try {
					applyAction(result, { tag: "start" });
					applyAction(result, { tag: "done", combo: firstCombo });
					// Second done with no fresh start must be dropped.
					applyAction(result, { tag: "done", combo: secondCombo });
					expect(result.current.key).toBe(firstCombo);
					expect(calls).toEqual([firstCombo]);
				} finally {
					unmount();
				}
			}
		),
		{ numRuns: 60 }
	);
});

test("property: idempotent stop — repeated stops do not flip state or re-send IPC", () => {
	fc.assert(
		fc.property(fc.integer({ min: 2, max: 6 }), (n) => {
			const { result, unmount } = renderHook(() => useKeyRecorder());
			try {
				applyAction(result, { tag: "start" });
				const sentBefore = sentChannels.filter((c) => c === IPC.HOTKEY_STOP_RECORDING).length;
				for (let i = 0; i < n; i++) {
					applyAction(result, { tag: "stop" });
				}
				const sentAfter = sentChannels.filter((c) => c === IPC.HOTKEY_STOP_RECORDING).length;
				// Only the first stop should send the IPC (guarded by recordingRef).
				expect(sentAfter - sentBefore).toBe(1);
				expect(result.current.recording).toBe(false);
			} finally {
				unmount();
			}
		}),
		{ numRuns: 50 }
	);
});

test("property: start resets prior key + liveKeys cleanly (no leaked state)", () => {
	fc.assert(
		fc.property(
			fc.array(ACTION_ARB, { maxLength: 12 }),
			fc.array(KEY_TOKEN, { maxLength: 4 }),
			(actions, liveKeys) => {
				const { result, unmount } = renderHook(() => useKeyRecorder());
				try {
					for (const action of actions) {
						applyAction(result, action);
					}
					// New start: must clear key + liveKeys, set recording=true.
					applyAction(result, { tag: "start" });
					expect(result.current.recording).toBe(true);
					expect(result.current.key).toBeNull();
					expect(result.current.liveKeys).toEqual([]);
					// And subsequent live updates flow through.
					applyAction(result, { tag: "update", keys: liveKeys });
					expect(result.current.liveKeys).toEqual(liveKeys);
				} finally {
					unmount();
				}
			}
		),
		{ numRuns: 60 }
	);
});

test("property: only the owning instance commits on a shared done event", () => {
	fc.assert(
		fc.property(fc.string({ minLength: 1, maxLength: 8 }), (combo) => {
			const ownerCalls: string[] = [];
			const otherCalls: string[] = [];
			const owner = renderHook(() => useKeyRecorder({ onKeyRecorded: (k) => ownerCalls.push(k) }));
			const other = renderHook(() => useKeyRecorder({ onKeyRecorded: (k) => otherCalls.push(k) }));
			try {
				// Only `owner` starts; the broadcast done must only commit on owner.
				applyAction(owner.result, { tag: "start" });
				applyAction(owner.result, { tag: "done", combo });
				expect(owner.result.current.key).toBe(combo);
				expect(other.result.current.key).toBeNull();
				expect(ownerCalls).toEqual([combo]);
				expect(otherCalls).toEqual([]);
			} finally {
				owner.unmount();
				other.unmount();
			}
		}),
		{ numRuns: 50 }
	);
});

test("property: invariant — recording=true implies a start IPC was invoked at least once", () => {
	fc.assert(
		fc.property(fc.array(ACTION_ARB, { maxLength: 20 }), (actions) => {
			const { result, unmount } = renderHook(() => useKeyRecorder());
			try {
				for (const action of actions) {
					applyAction(result, action);
					if (result.current.recording) {
						expect(invokes).toContain(IPC.HOTKEY_START_RECORDING);
					}
				}
			} finally {
				unmount();
			}
		}),
		{ numRuns: 60 }
	);
});
