import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useConnectionStore } from "@/entities/connection";
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

	test("shows only the GPU label when connected with GPU available (name is in tooltip)", () => {
		useConnectionStore.setState({
			connectionStatus: "connected",
			gpuInfo: { name: "NVIDIA GeForce RTX 4090", available: true },
		});
		renderIt();
		expect(screen.getByText("GPU")).toBeDefined();
		// Device name is no longer rendered inline — only "GPU" / "CPU" appears.
		const text = document.body.textContent ?? "";
		expect(text).not.toContain("RTX");
		expect(text).not.toContain("NVIDIA");
	});

	test("shows only the CPU label when connected with no GPU available", () => {
		useConnectionStore.setState({
			connectionStatus: "connected",
			gpuInfo: { name: "Intel Core i7-12700K", available: false },
		});
		renderIt();
		expect(screen.getByText("CPU")).toBeDefined();
		const text = document.body.textContent ?? "";
		expect(text).not.toContain("Intel");
		expect(text).not.toContain("12700K");
	});
});
