import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useHotkeyStore } from "../model/hotkey-store";
import { HotkeyDisplay } from "./HotkeyDisplay";

beforeEach(() => {
	useHotkeyStore.setState({
		isPressed: false,
		isActive: false,
		accelerator: "LCtrl+LMeta",
	});
});

afterEach(() => {
	useHotkeyStore.setState({
		isPressed: false,
		isActive: false,
		accelerator: "LCtrl+LMeta",
	});
});

function renderIt(isConnected: boolean) {
	return render(
		<IntlProvider>
			<HotkeyDisplay isConnected={isConnected} />
		</IntlProvider>
	);
}

describe("HotkeyDisplay", () => {
	test("renders each accelerator part formatted via formatKeyName", () => {
		useHotkeyStore.setState({ accelerator: "LCtrl+A" });
		renderIt(true);
		expect(screen.getByText("L Ctrl")).toBeDefined();
		expect(screen.getByText("A")).toBeDefined();
	});

	test("renders '+' separator between keys", () => {
		useHotkeyStore.setState({ accelerator: "LCtrl+A" });
		renderIt(true);
		expect(screen.getAllByText("+").length).toBeGreaterThan(0);
	});

	test("applies the connected styling when isConnected=true and not pressed", () => {
		const { container } = renderIt(true);
		const kbd = container.querySelector("kbd") as HTMLElement;
		expect(kbd.className).toContain("border-border");
		expect(kbd.className).not.toContain("opacity-60");
	});

	test("applies dimmed styling when not connected", () => {
		const { container } = renderIt(false);
		const kbd = container.querySelector("kbd") as HTMLElement;
		expect(kbd.className).toContain("opacity-60");
	});

	test("renders the recording pulse dot when isPressed AND connected", () => {
		useHotkeyStore.setState({ isPressed: true });
		const { container } = renderIt(true);
		const pulse = container.querySelector(".animate-recording-pulse");
		expect(pulse).not.toBeNull();
	});

	test("does not render the pulse dot when not connected", () => {
		useHotkeyStore.setState({ isPressed: true });
		const { container } = renderIt(false);
		const pulse = container.querySelector(".animate-recording-pulse");
		expect(pulse).toBeNull();
	});
});
