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

		for (const name of ["PTT", "Toggle", "Listen", "Wake Word"]) {
			expect(
				screen.getByRole("button", { name }).querySelector("svg"),
			).toBeNull();
		}
	});

	test("renders microphone selection inline", () => {
		const { container } = render(
			<IntlProvider>
				<TrayMenu />
			</IntlProvider>,
		);

		expect(container.textContent?.match(/System Default/g)?.length ?? 0).toBe(
			1,
		);
		fireEvent.click(screen.getByText("System Default"));
		expect(openWindowCalls).toHaveLength(0);
		expect(container.textContent?.match(/System Default/g)?.length ?? 0).toBe(
			1,
		);
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
