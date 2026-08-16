import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { commands } from "@/bindings";
import { CONTEXT_PLAYGROUND_ENABLED } from "@/shared/config/debug-flags";
import { TrayMenu } from "./TrayMenu";

interface OpenWindowCall {
	height: number | null;
	name: string;
	width: number | null;
	x: number | null;
	y: number | null;
}

const originalOpenWindow = commands.openWindow;
let openWindowCalls: OpenWindowCall[] = [];

beforeEach(() => {
	openWindowCalls = [];
	commands.openWindow = (async (name, x, y, width, height) => {
		openWindowCalls.push({ name, x, y, width, height });
		return { status: "ok", data: null };
	}) satisfies typeof commands.openWindow;
});

afterEach(() => {
	commands.openWindow = originalOpenWindow;
});

describe("TrayMenu", () => {
	test("renders without crashing", () => {
		const { container } = render(
			<IntlProvider>
				<TrayMenu />
			</IntlProvider>,
		);
		expect(container.firstElementChild).not.toBeNull();
	});

	test("renders window actions and debug context when enabled", () => {
		const { container } = render(
			<IntlProvider>
				<TrayMenu />
			</IntlProvider>,
		);
		const text = container.textContent ?? "";

		expect(text).not.toContain("Open Logs Folder");
		expect(text).not.toContain("Save Diagnostic Bundle");
		if (CONTEXT_PLAYGROUND_ENABLED) {
			expect(text).toContain("Context Playground (debug)");
		} else {
			expect(text).not.toContain("Context Playground");
		}
		expect(text).not.toContain("Ctrl");
		expect(text).not.toContain("Shift");
		expect(text).toContain("Show Window");
		expect(text).toContain("Settings");
		expect(text).toContain("Show WindowW");
		expect(text).toContain("Settings,");
		expect(text).toContain("Transcribe File...T");
		expect(text).toContain("QuitQ");
	});

	test("renders action icons without adding icons to recording modes", () => {
		render(
			<IntlProvider>
				<TrayMenu />
			</IntlProvider>,
		);

		for (const name of [
			/^Show Window/,
			/^Settings/,
			/^Copy Last Transcript/,
			/^Transcribe File/,
			/^Check for Updates/,
			/^Quit/,
		]) {
			expect(
				screen.getByRole("button", { name }).querySelector("svg"),
			).not.toBe(null);
		}

		// The modes moved behind the "Recording mode" row.
		fireEvent.click(screen.getByRole("button", { name: /^Recording mode/ }));
		for (const name of ["PTT", "Toggle", "Listen", "Wake Word"]) {
			expect(
				screen.getByRole("button", { name }).querySelector("svg"),
			).toBeNull();
		}
	});

	test("recording mode and microphone are drill-down rows", () => {
		render(
			<IntlProvider>
				<TrayMenu />
			</IntlProvider>,
		);

		// Both summarise their current value on the root menu...
		const modeRow = screen.getByRole("button", { name: /^Recording mode/ });
		expect(modeRow.textContent).toContain("PTT");
		expect(screen.queryByRole("button", { name: "Toggle" })).toBeNull();

		// ...and open a view with a back button that returns to the menu.
		fireEvent.click(modeRow);
		expect(screen.getByRole("button", { name: "Toggle" })).not.toBeNull();
		expect(screen.queryByRole("button", { name: /^Quit/ })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Back to menu" }));
		expect(screen.getByRole("button", { name: /^Quit/ })).not.toBeNull();
	});

	test("Escape backs out of a view before it closes the menu", () => {
		render(
			<IntlProvider>
				<TrayMenu />
			</IntlProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: /^Recording mode/ }));

		fireEvent.keyDown(window, { key: "Escape" });
		expect(screen.getByRole("button", { name: /^Quit/ })).not.toBeNull();
		expect(screen.queryByRole("button", { name: "Toggle" })).toBeNull();
	});

	test("letter accelerators are inert inside a sub-view", () => {
		render(
			<IntlProvider>
				<TrayMenu />
			</IntlProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: /^Recording mode/ }));

		// "W" would show the main window from the root menu; the row it belongs
		// to is not on screen here.
		fireEvent.keyDown(window, { key: "w" });
		expect(screen.getByRole("button", { name: "Toggle" })).not.toBeNull();
	});

	test("microphone selection stays inside the tray window", () => {
		const { container } = render(
			<IntlProvider>
				<TrayMenu />
			</IntlProvider>,
		);

		// At rest the device is a summary on its row, not an open control.
		expect(container.textContent?.match(/System Default/g)?.length ?? 0).toBe(
			1,
		);

		// Drilling in lists the devices in place — no portalled popup that the
		// ~192px OS window would clip, and no second window.
		fireEvent.click(screen.getByRole("button", { name: /^Input Device/ }));
		expect(openWindowCalls).toHaveLength(0);
		expect(screen.getByRole("group", { name: "Input Device" })).not.toBeNull();
		expect(container.firstElementChild?.className).toContain("w-[196px]");
		expect(container.firstElementChild?.className).not.toContain(
			"flex-row-reverse",
		);
	});

	test("replays entrance animation when the tray window open event arrives", () => {
		const { container } = render(
			<IntlProvider>
				<TrayMenu />
			</IntlProvider>,
		);
		const root = container.firstElementChild as HTMLElement;

		expect(root.classList.contains("tray-menu-open-shell")).toBe(true);
		expect(root.classList.contains("tray-menu-open-enter")).toBe(false);
		window.dispatchEvent(new Event("winstt:tray-menu-opened"));
		expect(root.classList.contains("tray-menu-open-enter")).toBe(true);
		window.dispatchEvent(new Event("winstt:tray-menu-hidden"));
		expect(root.classList.contains("tray-menu-open-enter")).toBe(false);
	});
});
