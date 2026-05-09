import { beforeEach, describe, expect, test } from "bun:test";
import { useConnectionStore } from "./connection-store";

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
