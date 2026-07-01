import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { resolveTone } from "../lib/hotkey-display-helpers";
import { useHotkeyStore } from "../model/hotkey-store";
import { HotkeyDisplay } from "./HotkeyDisplay";

beforeEach(() => {
	useHotkeyStore.setState({
		micPhase: "idle",
		isActive: false,
		accelerator: "LCtrl+LMeta",
	});
});

afterEach(() => {
	useHotkeyStore.setState({
		micPhase: "idle",
		isActive: false,
		accelerator: "LCtrl+LMeta",
	});
});

function renderIt(isConnected: boolean) {
	return render(
		<IntlProvider>
			<HotkeyDisplay isConnected={isConnected} />
		</IntlProvider>,
	);
}

describe("resolveTone", () => {
	test("returns 'muted' when disconnected", () => {
		expect(resolveTone(false, false)).toBe("muted");
		expect(resolveTone(false, true)).toBe("muted");
	});
	test("returns 'active' when connected and armed (opening or live)", () => {
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

	test("group exposes the idle tone when connected and idle", () => {
		const { container } = renderIt(true);
		const group = container.querySelector("kbd[data-tone]") as HTMLElement;
		expect(group).not.toBeNull();
		expect(group.dataset["tone"]).toBe("default");
		expect(group.dataset["disconnected"]).toBeUndefined();
		expect(group.dataset["pressed"]).toBeUndefined();
	});

	test("group exposes the muted tone when disconnected", () => {
		const { container } = renderIt(false);
		const group = container.querySelector("kbd[data-tone]") as HTMLElement;
		expect(group.dataset["tone"]).toBe("muted");
		expect(group.dataset["disconnected"]).toBe("true");
	});

	// The 3 states are conveyed by the badge rectangle's LIGHTNESS only — no dots,
	// no motion. With the default surface substrate (1), the Elevated offset maps
	// idle→bg-surface-2, opening→bg-surface-3, live→bg-surface-5 (lighter = more
	// active). The badge div is the kbd's parent (Elevated renders a <div>).
	function badgeOf(container: HTMLElement): HTMLElement {
		const kbd = container.querySelector("kbd[data-tone]");
		const badge = kbd?.parentElement;
		if (!badge) {
			throw new Error("badge (Elevated) not found");
		}
		return badge;
	}

	test("never renders a pulse dot in any phase (no blinking indicators)", () => {
		for (const micPhase of ["idle", "opening", "live"] as const) {
			useHotkeyStore.setState({ micPhase });
			const { container, unmount } = renderIt(true);
			expect(container.querySelector('[data-slot="pulse-dot"]')).toBeNull();
			unmount();
		}
	});

	test("idle rests at the base surface lightness", () => {
		const { container } = renderIt(true);
		expect(badgeOf(container).className).toContain("bg-surface-2");
	});

	test("opening is one surface step lighter than idle", () => {
		useHotkeyStore.setState({ micPhase: "opening" });
		const { container } = renderIt(true);
		expect(badgeOf(container).className).toContain("bg-surface-3");
		const group = container.querySelector("kbd[data-tone]") as HTMLElement;
		expect(group.dataset["tone"]).toBe("active");
		expect(group.dataset["pressed"]).toBe("true");
	});

	test("live is the lightest (full-on) surface", () => {
		useHotkeyStore.setState({ micPhase: "live" });
		const { container } = renderIt(true);
		expect(badgeOf(container).className).toContain("bg-surface-5");
		const group = container.querySelector("kbd[data-tone]") as HTMLElement;
		expect(group.dataset["tone"]).toBe("active");
		expect(group.dataset["pressed"]).toBe("true");
	});

	test("disconnected stays at the idle lightness even while the phase is live", () => {
		useHotkeyStore.setState({ micPhase: "live" });
		const { container } = renderIt(false);
		const badge = badgeOf(container);
		expect(badge.className).toContain("bg-surface-2");
		expect(badge.className).not.toContain("bg-surface-5");
	});
});
