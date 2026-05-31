import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useConnectionStore } from "@/entities/connection";
import { resolveConnectionChip, resolveGpuChipConfig } from "../lib/connection-indicator-helpers";
import { ConnectionIndicator } from "./ConnectionIndicator";

const initial = useConnectionStore.getState();

beforeEach(() => {
	useConnectionStore.setState({
		connectionStatus: "disconnected",
		gpuInfo: null,
		serverStatus: "idle",
	});
});

afterEach(() => {
	useConnectionStore.setState(initial);
});

function renderIt() {
	return render(
		<IntlProvider>
			<ConnectionIndicator />
		</IntlProvider>
	);
}

describe("resolveConnectionChip", () => {
	test("returns 'connecting' when connection status is connecting", () => {
		expect(resolveConnectionChip("connecting", "idle", null)).toBe("connecting");
	});
	test("returns 'error' when connection status is error", () => {
		expect(resolveConnectionChip("error", "idle", null)).toBe("error");
	});
	test("returns 'offline' when connection status is disconnected", () => {
		expect(resolveConnectionChip("disconnected", "idle", null)).toBe("offline");
	});
	test("returns 'connecting' when connected but runtimeIsGpu unknown yet", () => {
		// runtime_info hasn't arrived from the server yet — chip waits.
		expect(resolveConnectionChip("connected", "running", null)).toBe("connecting");
	});
	test("returns 'connecting' when WS connected but server is still warming up", () => {
		// Recorder still loading models — chip must NOT show green yet.
		expect(resolveConnectionChip("connected", "idle", true)).toBe("connecting");
	});
	test("returns 'gpu' when fully connected AND server reports GPU runtime", () => {
		expect(resolveConnectionChip("connected", "running", true)).toBe("gpu");
	});
	test("returns 'gpu' when fully connected AND server reports CPU runtime", () => {
		// Same chip name (rendered with CPU label internally) — the boolean
		// controls the icon/color, not the chip slot.
		expect(resolveConnectionChip("connected", "running", false)).toBe("gpu");
	});
});

describe("resolveGpuChipConfig", () => {
	test("returns GPU label and success color for isGpu=true", () => {
		const cfg = resolveGpuChipConfig(true);
		expect(cfg.label).toBe("GPU");
		expect(cfg.colorClass).toContain("success");
	});
	test("returns CPU label and dim color for isGpu=false", () => {
		const cfg = resolveGpuChipConfig(false);
		expect(cfg.label).toBe("CPU");
		expect(cfg.colorClass).toContain("dim");
	});
});

describe("ConnectionIndicator", () => {
	test("shows the offline state when disconnected", () => {
		useConnectionStore.setState({ connectionStatus: "disconnected", gpuInfo: null });
		renderIt();
		const out = screen.getByRole("status");
		expect(out.textContent?.toLowerCase()).toContain("offline");
	});

	test("shows the connecting state in warning color", () => {
		useConnectionStore.setState({ connectionStatus: "connecting" });
		renderIt();
		const out = screen.getByRole("status");
		expect(out.textContent?.toLowerCase()).toContain("connect");
	});

	test("shows the error state", () => {
		useConnectionStore.setState({ connectionStatus: "error" });
		renderIt();
		const out = screen.getByRole("status");
		expect(out.textContent?.toLowerCase()).toContain("error");
	});

	test("shows only the GPU label when server reports GPU runtime (name is in tooltip)", () => {
		useConnectionStore.setState({
			connectionStatus: "connected",
			serverStatus: "running",
			gpuInfo: { name: "NVIDIA GeForce RTX 4090", available: true },
			runtimeInfo: {
				device: "cuda",
				providers: ["CUDAExecutionProvider", "CPUExecutionProvider"],
				is_gpu: true,
				model: "onnx-community/whisper-base",
				realtime_model: "onnx-community/whisper-tiny",
			},
		});
		renderIt();
		expect(screen.getByText("GPU")).toBeDefined();
		// Device name is no longer rendered inline — only "GPU" / "CPU" appears.
		const text = document.body.textContent ?? "";
		expect(text).not.toContain("RTX");
		expect(text).not.toContain("NVIDIA");
	});

	test("shows only the CPU label when server reports CPU-only runtime", () => {
		useConnectionStore.setState({
			connectionStatus: "connected",
			serverStatus: "running",
			gpuInfo: { name: "NVIDIA GeForce RTX 4090", available: true },
			runtimeInfo: {
				device: "cuda",
				providers: ["CPUExecutionProvider"],
				is_gpu: false,
				model: "onnx-community/whisper-base",
				realtime_model: null,
			},
		});
		renderIt();
		expect(screen.getByText("CPU")).toBeDefined();
		const text = document.body.textContent ?? "";
		expect(text).not.toContain("Intel");
		expect(text).not.toContain("12700K");
	});

	test("stays in 'connecting' state while WS is open but recorder is warming up", () => {
		// Server has accepted the WebSocket but has not yet sent server_ready
		// — recorder is loading models / warming CUDA kernels.  User must NOT
		// see a green light.
		useConnectionStore.setState({
			connectionStatus: "connected",
			serverStatus: "idle",
			gpuInfo: { name: "NVIDIA GeForce RTX 4090", available: true },
		});
		renderIt();
		const out = screen.getByRole("status");
		expect(out.textContent?.toLowerCase()).toContain("connect");
	});
});
