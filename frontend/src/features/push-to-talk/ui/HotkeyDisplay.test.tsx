import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useHotkeyStore } from "../model/hotkey-store";
import { HotkeyDisplay, resolveKbdClass } from "./HotkeyDisplay";

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

describe("resolveKbdClass", () => {
	test("returns disconnected class when isConnected=false", () => {
		const cls = resolveKbdClass(false, false);
		expect(cls).toContain("opacity-60");
	});
	test("returns disconnected class even when isPressed=true and not connected", () => {
		const cls = resolveKbdClass(false, true);
		expect(cls).toContain("opacity-60");
	});
	test("returns pressed class when connected and pressed", () => {
		const cls = resolveKbdClass(true, true);
		expect(cls).toContain("bg-orange-dim");
	});
	test("returns idle class when connected and not pressed", () => {
		const cls = resolveKbdClass(true, false);
		expect(cls).toContain("bg-surface-tertiary");
		expect(cls).not.toContain("opacity-60");
	});
});

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
