import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { resolveTone } from "../lib/hotkey-display-helpers";
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

describe("resolveTone", () => {
	test("returns 'muted' when disconnected", () => {
		expect(resolveTone(false, false)).toBe("muted");
		expect(resolveTone(false, true)).toBe("muted");
	});
	test("returns 'active' when connected and pressed", () => {
		expect(resolveTone(true, true)).toBe("active");
	});
	test("returns 'default' when connected and idle", () => {
		expect(resolveTone(true, false)).toBe("default");
	});
});

describe("HotkeyDisplay", () => {
	test("renders each accelerator part formatted via formatKeyName", () => {
		useHotkeyStore.setState({ accelerator: "LCtrl+A" });
		renderIt(true);
		expect(screen.getByText("L Ctrl")).toBeDefined();
		expect(screen.getByText("A")).toBeDefined();
	});

	test("renders a separator between keys", () => {
		useHotkeyStore.setState({ accelerator: "LCtrl+A" });
		renderIt(true);
		// Separator is a stylised full-width plus (U+FF0B) for visual
		// hierarchy; what matters is that *something* lives between keys.
		expect(screen.getAllByText(/[+＋]/).length).toBeGreaterThan(0);
	});

	test("group exposes the idle tone when connected and not pressed", () => {
		const { container } = renderIt(true);
		const group = container.querySelector("kbd[data-tone]") as HTMLElement;
		expect(group).not.toBeNull();
		expect(group.dataset.tone).toBe("default");
		expect(group.dataset.disconnected).toBeUndefined();
		expect(group.dataset.pressed).toBeUndefined();
	});

	test("group exposes the muted tone when disconnected", () => {
		const { container } = renderIt(false);
		const group = container.querySelector("kbd[data-tone]") as HTMLElement;
		expect(group.dataset.tone).toBe("muted");
		expect(group.dataset.disconnected).toBe("true");
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
