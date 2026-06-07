import { afterEach, describe, expect, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";
import type {
	ModelSwapKind,
	RuntimeInfoPayload,
} from "@/shared/api/ipc-client";

interface SwapPayload {
	kind: ModelSwapKind;
	name: string;
}
interface SwapFailedPayload extends SwapPayload {
	reason: string;
}

// Per-test capture of the lifecycle callbacks that initModelSwapStore wires
// up. Bun's `mock.module` cache is process-global, so we route through the
// real `ipc-client` fake plus the four swap-event overrides this suite needs.
const ipcOverrides: {
	startedCb: ((p: SwapPayload) => void) | null;
	completedCb: ((p: SwapPayload) => void) | null;
	failedCb: ((p: SwapFailedPayload) => void) | null;
	runtimeCb: ((info: RuntimeInfoPayload | null) => void) | null;
} = {
	startedCb: null,
	completedCb: null,
	failedCb: null,
	runtimeCb: null,
};

// Count `markSwapFailed()` invocations so we can assert the failed-event
// handler stamps the failure BEFORE clearing (the load-bearing ordering the
// source comment calls out — see shared/lib/swap-failure-timing.ts).
let markSwapFailedCalls = 0;
mock.module("@/shared/lib/swap-failure-timing", () => ({
	markSwapFailed: () => {
		markSwapFailedCalls += 1;
	},
	recentSwapFailedAt: () => 0,
	_resetSwapFailureTimingForTests: () => {
		markSwapFailedCalls = 0;
	},
}));

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
	onRuntimeInfo: (cb: (info: RuntimeInfoPayload | null) => void) => {
		ipcOverrides.runtimeCb = cb;
		return () => {
			ipcOverrides.runtimeCb = null;
		};
	},
}));

const {
	useModelSwapStore,
	initModelSwapStore,
	_setOptimisticSwapStaleMsForTests,
	_resetOptimisticSwapForTests,
} = await import("./model-swap-store");

function runtimeInfo(
	overrides: Partial<RuntimeInfoPayload>,
): RuntimeInfoPayload {
	return {
		device: "cpu",
		is_gpu: false,
		model: null,
		providers: ["CPUExecutionProvider"],
		realtime_model: null,
		...overrides,
	};
}

function resetStore(): void {
	useModelSwapStore.setState({
		activeMain: null,
		activeRealtime: null,
		fromMain: null,
		fromRealtime: null,
	});
}

// The zustand store is a singleton across the bun:test process, so leftover
// state would pollute sibling test files (e.g. StatusBar tests that key
// off `activeMain`). Reset after every test to keep the singleton clean.
afterEach(() => {
	resetStore();
	_resetOptimisticSwapForTests();
	markSwapFailedCalls = 0;
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

	test("beginSwap('main') records from→to on the main slot only", () => {
		resetStore();
		useModelSwapStore.getState().beginSwap("main", "tiny", "large-v2");
		const s = useModelSwapStore.getState();
		expect(s.activeMain).toBe("large-v2");
		expect(s.fromMain).toBe("tiny");
		// Realtime slot remains untouched.
		expect(s.activeRealtime).toBeNull();
		expect(s.fromRealtime).toBeNull();
		expect(s.isSwapping("main")).toBe(true);
		expect(s.isSwapping("realtime")).toBe(false);
	});

	test("beginSwap('realtime') records from→to on the realtime slot only", () => {
		resetStore();
		useModelSwapStore.getState().beginSwap("realtime", "small", "base");
		const s = useModelSwapStore.getState();
		expect(s.activeRealtime).toBe("base");
		expect(s.fromRealtime).toBe("small");
		// Main slot remains untouched.
		expect(s.activeMain).toBeNull();
		expect(s.fromMain).toBeNull();
		expect(s.isSwapping("realtime")).toBe(true);
	});

	test("clear('realtime') wipes both the active and from fields on the realtime slot", () => {
		resetStore();
		useModelSwapStore.getState().beginSwap("realtime", "tiny", "base");
		useModelSwapStore.getState().clear("realtime");
		const s = useModelSwapStore.getState();
		expect(s.activeRealtime).toBeNull();
		expect(s.fromRealtime).toBeNull();
	});

	test("clear('main') wipes both the active and from fields on the main slot", () => {
		resetStore();
		useModelSwapStore.getState().beginSwap("main", "tiny", "large-v2");
		useModelSwapStore.getState().clear("main");
		const s = useModelSwapStore.getState();
		expect(s.activeMain).toBeNull();
		expect(s.fromMain).toBeNull();
	});
});

function emitStarted(payload: SwapPayload): void {
	const cb = ipcOverrides.startedCb;
	if (cb === null) {
		throw new Error(
			"startedCb not registered — call initModelSwapStore() first",
		);
	}
	cb(payload);
}

function emitCompleted(payload: SwapPayload): void {
	const cb = ipcOverrides.completedCb;
	if (cb === null) {
		throw new Error(
			"completedCb not registered — call initModelSwapStore() first",
		);
	}
	cb(payload);
}

function emitFailed(payload: SwapFailedPayload): void {
	const cb = ipcOverrides.failedCb;
	if (cb === null) {
		throw new Error(
			"failedCb not registered — call initModelSwapStore() first",
		);
	}
	cb(payload);
}

function emitRuntime(info: RuntimeInfoPayload | null): void {
	const cb = ipcOverrides.runtimeCb;
	if (cb === null) {
		throw new Error(
			"runtimeCb not registered — call initModelSwapStore() first",
		);
	}
	cb(info);
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

	test("registers and tears down the runtime-info subscription", () => {
		resetStore();
		ipcOverrides.runtimeCb = null;
		const unsub = initModelSwapStore();
		expect(ipcOverrides.runtimeCb).not.toBeNull();
		unsub();
		expect(ipcOverrides.runtimeCb).toBeNull();
	});

	test("failed event stamps the swap-failure timestamp before clearing", () => {
		resetStore();
		const unsub = initModelSwapStore();
		emitStarted({ kind: "main", name: "large-v2" });
		expect(markSwapFailedCalls).toBe(0);

		emitFailed({ kind: "main", name: "large-v2", reason: "boom" });
		expect(markSwapFailedCalls).toBe(1);
		expect(useModelSwapStore.getState().activeMain).toBeNull();
		unsub();
	});
});

describe("initModelSwapStore — runtime_info restart-based completion", () => {
	test("null runtime info is ignored and leaves in-flight swaps untouched", () => {
		resetStore();
		const unsub = initModelSwapStore();
		emitStarted({ kind: "main", name: "large-v2" });
		emitStarted({ kind: "realtime", name: "tiny" });

		emitRuntime(null);
		expect(useModelSwapStore.getState().activeMain).toBe("large-v2");
		expect(useModelSwapStore.getState().activeRealtime).toBe("tiny");
		unsub();
	});

	test("matching main model clears the main swap (restart-based completion)", () => {
		resetStore();
		const unsub = initModelSwapStore();
		emitStarted({ kind: "main", name: "large-v2" });

		emitRuntime(runtimeInfo({ model: "large-v2" }));
		expect(useModelSwapStore.getState().activeMain).toBeNull();
		unsub();
	});

	test("matching realtime model clears the realtime swap (restart-based completion)", () => {
		resetStore();
		const unsub = initModelSwapStore();
		emitStarted({ kind: "realtime", name: "tiny" });

		emitRuntime(runtimeInfo({ realtime_model: "tiny" }));
		expect(useModelSwapStore.getState().activeRealtime).toBeNull();
		unsub();
	});

	test("mismatched runtime model keeps the spinner up (no premature clear)", () => {
		resetStore();
		const unsub = initModelSwapStore();
		emitStarted({ kind: "main", name: "large-v2" });

		// Server still reporting the OLD model — swap not done yet.
		emitRuntime(runtimeInfo({ model: "tiny" }));
		expect(useModelSwapStore.getState().activeMain).toBe("large-v2");
		unsub();
	});

	test("no active main swap: runtime info never spuriously clears", () => {
		resetStore();
		const unsub = initModelSwapStore();
		// activeMain is null; the `state.activeMain !== null` guard must short
		// out so a stray runtime_info with model === null does not "clear" it.
		emitRuntime(runtimeInfo({ model: null }));
		expect(useModelSwapStore.getState().activeMain).toBeNull();
		expect(useModelSwapStore.getState().activeRealtime).toBeNull();
		unsub();
	});

	test("clears both kinds at once when runtime info matches both targets", () => {
		resetStore();
		const unsub = initModelSwapStore();
		emitStarted({ kind: "main", name: "large-v2" });
		emitStarted({ kind: "realtime", name: "tiny" });

		emitRuntime(runtimeInfo({ model: "large-v2", realtime_model: "tiny" }));
		expect(useModelSwapStore.getState().activeMain).toBeNull();
		expect(useModelSwapStore.getState().activeRealtime).toBeNull();
		unsub();
	});

	test("clears only the matching kind, leaving the non-matching swap in flight", () => {
		resetStore();
		const unsub = initModelSwapStore();
		emitStarted({ kind: "main", name: "large-v2" });
		emitStarted({ kind: "realtime", name: "tiny" });

		// Only the main target matches the freshly-reported model.
		emitRuntime(runtimeInfo({ model: "large-v2", realtime_model: "base" }));
		expect(useModelSwapStore.getState().activeMain).toBeNull();
		expect(useModelSwapStore.getState().activeRealtime).toBe("tiny");
		unsub();
	});
});

describe("optimistic swap self-heal (kills the stuck / reversed-direction spinner)", () => {
	// Repro of the user-reported "first click shows a reversed B→A switch that
	// spins forever": an OPTIMISTIC beginSwap (opened by useSyncActiveModel
	// reacting to a settings change / rollback — see use-sync-active-model.ts)
	// that no real server swap ever confirms. The server emits
	// `model_swap_started` at the START of every genuine reload, so an
	// optimistic open that gets no `setActive` within the window is a phantom
	// and must auto-clear rather than strand the chip.

	test("an optimistic beginSwap never confirmed by model_swap_started self-clears", async () => {
		resetStore();
		_setOptimisticSwapStaleMsForTests(15);
		// Reversed phantom: from="B" (the model actually loaded), to="A".
		useModelSwapStore.getState().beginSwap("main", "B", "A");
		expect(useModelSwapStore.getState().activeMain).toBe("A");

		await new Promise((resolve) => setTimeout(resolve, 40));

		// No model_swap_started arrived → phantom heals instead of spinning forever.
		expect(useModelSwapStore.getState().activeMain).toBeNull();
		expect(useModelSwapStore.getState().fromMain).toBeNull();
	});

	test("a beginSwap confirmed by model_swap_started does NOT self-clear", async () => {
		resetStore();
		_setOptimisticSwapStaleMsForTests(15);
		const unsub = initModelSwapStore();

		useModelSwapStore.getState().beginSwap("main", "A", "B");
		emitStarted({ kind: "main", name: "B" }); // real swap confirmed by the server

		await new Promise((resolve) => setTimeout(resolve, 40));

		expect(useModelSwapStore.getState().activeMain).toBe("B");
		unsub();
	});

	test("model_swap_started arriving BEFORE the optimistic beginSwap stays confirmed (cross-window race)", async () => {
		resetStore();
		_setOptimisticSwapStaleMsForTests(15);
		const unsub = initModelSwapStore();

		// Non-initiating window: the broadcast `model_swap_started` lands first,
		// then the settings-change-driven optimistic beginSwap. The second must
		// not re-arm a self-heal that would clear an already-confirmed swap.
		emitStarted({ kind: "main", name: "B" });
		useModelSwapStore.getState().beginSwap("main", "A", "B");

		await new Promise((resolve) => setTimeout(resolve, 40));

		expect(useModelSwapStore.getState().activeMain).toBe("B");
		expect(useModelSwapStore.getState().fromMain).toBe("A");
		unsub();
	});

	test("realtime optimistic swaps self-heal independently of main", async () => {
		resetStore();
		_setOptimisticSwapStaleMsForTests(15);
		useModelSwapStore.getState().beginSwap("realtime", "small", "base");

		await new Promise((resolve) => setTimeout(resolve, 40));

		expect(useModelSwapStore.getState().activeRealtime).toBeNull();
		expect(useModelSwapStore.getState().fromRealtime).toBeNull();
	});
});
