import { beforeEach, describe, expect, test } from "bun:test";
// IMPORTANT: capture the *initial* store state via getInitialState() BEFORE
// any test runs setState(). The store is created at import time (top of this
// file) so the initial-state snapshot reflects the literals in the source.
import { useConnectionStore } from "./connection-store";

const INITIAL_STATE = useConnectionStore.getInitialState();

beforeEach(() => {
	useConnectionStore.setState({
		connectionStatus: "disconnected",
		serverStatus: "idle",
		gpuInfo: null,
	});
});

describe("useConnectionStore", () => {
	test("initial state defaults", () => {
		const state = useConnectionStore.getState();
		expect(state.connectionStatus).toBe("disconnected");
		expect(state.serverStatus).toBe("idle");
		expect(state.gpuInfo).toBeNull();
	});

	test("store factory's initial state has the documented literals (mutation guard)", () => {
		// Mutating the literals in the source ("connecting" → "" or "idle" → "")
		// is invisible if every test sets state in beforeEach. This assertion
		// reads the snapshot captured at module-load time, before any setState.
		// connectionStatus defaults to "connecting" (NOT "disconnected") on
		// purpose: the cold-start chip must read "CONNECTING…" not "OFFLINE"
		// while the stt-server binds its WS ports — see the rationale comment in
		// connection-store.ts. The beforeEach above resets the *live* store to
		// "disconnected" only as a per-test baseline; the factory initial here
		// is the real, intentional default.
		expect(INITIAL_STATE.connectionStatus).toBe("connecting");
		expect(INITIAL_STATE.serverStatus).toBe("idle");
		expect(INITIAL_STATE.gpuInfo).toBeNull();
	});

	test("setConnectionStatus updates the connectionStatus field only", () => {
		useConnectionStore.getState().setConnectionStatus("connected");
		const state = useConnectionStore.getState();
		expect(state.connectionStatus).toBe("connected");
		expect(state.serverStatus).toBe("idle");
	});

	test("setServerStatus updates the serverStatus field only", () => {
		useConnectionStore.getState().setServerStatus("running");
		const state = useConnectionStore.getState();
		expect(state.serverStatus).toBe("running");
		expect(state.connectionStatus).toBe("disconnected");
	});

	test("setGpuInfo accepts an object or null", () => {
		useConnectionStore.getState().setGpuInfo({ name: "RTX 4090", available: true });
		expect(useConnectionStore.getState().gpuInfo?.name).toBe("RTX 4090");
		useConnectionStore.getState().setGpuInfo(null);
		expect(useConnectionStore.getState().gpuInfo).toBeNull();
	});
});
