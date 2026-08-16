import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";
import type { ModeTransitionPayload } from "@/shared/api/ipc-client";

// Per-test capture of the subscription `initModeTransitionStore` wires up, plus
// a controllable resolution for the pull command. Bun's `mock.module` cache is
// process-global, so the real ipc-client fake is extended rather than replaced.
const ipcOverrides: {
	transitionCb: ((payload: ModeTransitionPayload) => void) | null;
	pullState: ModeTransitionPayload | null;
} = { transitionCb: null, pullState: null };

mock.module("@/shared/api/ipc-client", () => ({
	...ipcClientMock(),
	onRecordingModeTransition: (cb: (payload: ModeTransitionPayload) => void) => {
		ipcOverrides.transitionCb = cb;
		return () => {
			ipcOverrides.transitionCb = null;
		};
	},
	recordingModeTransitionState: () =>
		Promise.resolve(
			ipcOverrides.pullState ?? {
				error: null,
				from: "ptt",
				generation: 0,
				phase: "idle",
				to: "ptt",
			},
		),
}));

const { initModeTransitionStore, useModeTransitionStore } = await import(
	"./transition-store"
);

function payload(
	overrides: Partial<ModeTransitionPayload>,
): ModeTransitionPayload {
	return {
		error: null,
		from: "ptt",
		generation: 1,
		phase: "preparing",
		to: "listen",
		...overrides,
	};
}

function reset() {
	useModeTransitionStore.setState({
		isPreparing: false,
		transition: payload({ generation: 0, phase: "idle", to: "ptt" }),
	});
}

describe("useModeTransitionStore", () => {
	beforeEach(() => {
		reset();
		ipcOverrides.pullState = null;
	});

	test("a preparing phase locks the mode controls", () => {
		useModeTransitionStore.getState().apply(payload({}));
		expect(useModeTransitionStore.getState().isPreparing).toBe(true);
		expect(useModeTransitionStore.getState().transition.to).toBe("listen");
	});

	test("ready and failed both unlock the controls", () => {
		useModeTransitionStore.getState().apply(payload({}));
		useModeTransitionStore.getState().apply(payload({ phase: "ready" }));
		expect(useModeTransitionStore.getState().isPreparing).toBe(false);

		useModeTransitionStore.getState().apply(payload({ generation: 2 }));
		useModeTransitionStore.getState().apply(
			payload({
				error: "no realtime model",
				generation: 2,
				phase: "failed",
			}),
		);
		// A failed switch must not strand the switcher — the user has to be able
		// to pick a different mode.
		expect(useModeTransitionStore.getState().isPreparing).toBe(false);
		expect(useModeTransitionStore.getState().transition.error).toBe(
			"no realtime model",
		);
	});

	test("a stale generation cannot clear a newer transition", () => {
		useModeTransitionStore.getState().apply(payload({ generation: 5 }));
		// The pull command resolving late (or an event from a superseded switch)
		// must not unlock controls the current switch is still holding.
		useModeTransitionStore
			.getState()
			.apply(payload({ generation: 4, phase: "ready" }));
		expect(useModeTransitionStore.getState().isPreparing).toBe(true);
		expect(useModeTransitionStore.getState().transition.generation).toBe(5);
	});

	test("a settle for the current generation is applied", () => {
		useModeTransitionStore.getState().apply(payload({ generation: 5 }));
		useModeTransitionStore
			.getState()
			.apply(payload({ generation: 5, phase: "ready" }));
		expect(useModeTransitionStore.getState().isPreparing).toBe(false);
	});

	test("subscribing pulls the phase for a window that mounted mid-switch", async () => {
		ipcOverrides.pullState = payload({ generation: 3 });
		const unsubscribe = initModeTransitionStore();
		await Promise.resolve();
		await Promise.resolve();
		expect(useModeTransitionStore.getState().isPreparing).toBe(true);
		expect(useModeTransitionStore.getState().transition.to).toBe("listen");

		ipcOverrides.transitionCb?.(payload({ generation: 3, phase: "ready" }));
		expect(useModeTransitionStore.getState().isPreparing).toBe(false);
		unsubscribe();
	});
});
