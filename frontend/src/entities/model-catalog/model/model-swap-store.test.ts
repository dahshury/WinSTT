import { afterEach, describe, expect, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";
import type { ModelSwapKind } from "@/shared/api/ipc-client";

interface SwapPayload {
	kind: ModelSwapKind;
	name: string;
}
interface SwapFailedPayload extends SwapPayload {
	reason: string;
}

// Per-test capture of the lifecycle callbacks that initModelSwapStore wires
// up. Bun's `mock.module` cache is process-global, so we route through the
// real `ipc-client` fake plus the three swap-event overrides this suite needs.
const ipcOverrides: {
	startedCb: ((p: SwapPayload) => void) | null;
	completedCb: ((p: SwapPayload) => void) | null;
	failedCb: ((p: SwapFailedPayload) => void) | null;
} = {
	startedCb: null,
	completedCb: null,
	failedCb: null,
};

mock.module("@/shared/api/ipc-client", () => ({
	...ipcClientMock(),
	onModelSwapStarted: (cb: (p: SwapPayload) => void) => {
		ipcOverrides.startedCb = cb;
		return () => {
			ipcOverrides.startedCb = null;
		};
	},
	onModelSwapCompleted: (cb: (p: SwapPayload) => void) => {
		ipcOverrides.completedCb = cb;
		return () => {
			ipcOverrides.completedCb = null;
		};
	},
	onModelSwapFailed: (cb: (p: SwapFailedPayload) => void) => {
		ipcOverrides.failedCb = cb;
		return () => {
			ipcOverrides.failedCb = null;
		};
	},
}));

const { useModelSwapStore, initModelSwapStore } = await import("./model-swap-store");

function resetStore(): void {
	useModelSwapStore.setState({ activeMain: null, activeRealtime: null });
}

// The zustand store is a singleton across the bun:test process, so leftover
// state would pollute sibling test files (e.g. StatusBar tests that key
// off `activeMain`). Reset after every test to keep the singleton clean.
afterEach(() => {
	resetStore();
});

describe("useModelSwapStore.setActive / clear", () => {
	test("setActive('main', name) records the main swap without touching realtime", () => {
		resetStore();
		useModelSwapStore.getState().setActive("main", "large-v2");
		const s = useModelSwapStore.getState();
		expect(s.activeMain).toBe("large-v2");
		expect(s.activeRealtime).toBeNull();
		expect(s.isSwapping("main")).toBe(true);
		expect(s.isSwapping("realtime")).toBe(false);
	});

	test("setActive('realtime', name) records the realtime swap without touching main", () => {
		resetStore();
		useModelSwapStore.getState().setActive("realtime", "tiny");
		const s = useModelSwapStore.getState();
		expect(s.activeMain).toBeNull();
		expect(s.activeRealtime).toBe("tiny");
		expect(s.isSwapping("realtime")).toBe(true);
	});

	test("clear only clears the matching kind", () => {
		resetStore();
		useModelSwapStore.getState().setActive("main", "large-v2");
		useModelSwapStore.getState().setActive("realtime", "tiny");
		useModelSwapStore.getState().clear("main");
		const s = useModelSwapStore.getState();
		expect(s.activeMain).toBeNull();
		expect(s.activeRealtime).toBe("tiny");
	});
});

function emitStarted(payload: SwapPayload): void {
	const cb = ipcOverrides.startedCb;
	if (cb === null) {
		throw new Error("startedCb not registered — call initModelSwapStore() first");
	}
	cb(payload);
}

function emitCompleted(payload: SwapPayload): void {
	const cb = ipcOverrides.completedCb;
	if (cb === null) {
		throw new Error("completedCb not registered — call initModelSwapStore() first");
	}
	cb(payload);
}

function emitFailed(payload: SwapFailedPayload): void {
	const cb = ipcOverrides.failedCb;
	if (cb === null) {
		throw new Error("failedCb not registered — call initModelSwapStore() first");
	}
	cb(payload);
}

describe("initModelSwapStore", () => {
	test("started → completed flips active flag on and back off", () => {
		resetStore();
		ipcOverrides.startedCb = null;
		ipcOverrides.completedCb = null;
		ipcOverrides.failedCb = null;
		const unsub = initModelSwapStore();
		expect(ipcOverrides.startedCb).not.toBeNull();
		expect(ipcOverrides.completedCb).not.toBeNull();
		expect(ipcOverrides.failedCb).not.toBeNull();

		emitStarted({ kind: "main", name: "large-v2" });
		expect(useModelSwapStore.getState().activeMain).toBe("large-v2");

		emitCompleted({ kind: "main", name: "large-v2" });
		expect(useModelSwapStore.getState().activeMain).toBeNull();

		unsub();
		expect(ipcOverrides.startedCb).toBeNull();
		expect(ipcOverrides.completedCb).toBeNull();
		expect(ipcOverrides.failedCb).toBeNull();
	});

	test("failed event also clears the active flag (swap aborts but UI must unstick)", () => {
		resetStore();
		const unsub = initModelSwapStore();
		emitStarted({ kind: "realtime", name: "base" });
		expect(useModelSwapStore.getState().activeRealtime).toBe("base");

		emitFailed({ kind: "realtime", name: "base", reason: "boom" });
		expect(useModelSwapStore.getState().activeRealtime).toBeNull();
		unsub();
	});

	test("main and realtime swaps are tracked independently", () => {
		resetStore();
		const unsub = initModelSwapStore();
		emitStarted({ kind: "main", name: "large-v2" });
		emitStarted({ kind: "realtime", name: "tiny" });
		expect(useModelSwapStore.getState().activeMain).toBe("large-v2");
		expect(useModelSwapStore.getState().activeRealtime).toBe("tiny");

		emitCompleted({ kind: "realtime", name: "tiny" });
		expect(useModelSwapStore.getState().activeMain).toBe("large-v2");
		expect(useModelSwapStore.getState().activeRealtime).toBeNull();
		unsub();
	});
});
