import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { TitleBar } from "./TitleBar";

const tauriCalls: Array<{ args: unknown; cmd: string }> = [];
const windowCalls: string[] = [];

mock.module("@tauri-apps/api/core", () => ({
	invoke: (cmd: string, args?: Record<string, unknown>) => {
		tauriCalls.push({ cmd, args });
		return Promise.resolve(undefined);
	},
	Channel: class {},
}));

mock.module("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({
		minimize: () => {
			windowCalls.push("minimize");
			return Promise.resolve();
		},
		hide: () => {
			windowCalls.push("hide");
			return Promise.resolve();
		},
	}),
}));

beforeEach(() => {
	tauriCalls.length = 0;
	windowCalls.length = 0;
});

function renderWithIntl() {
	return render(
		<IntlProvider>
			<TitleBar />
		</IntlProvider>,
	);
}

function touchTap(element: HTMLElement, pointerId: number): void {
	fireEvent.pointerDown(element, {
		button: 0,
		clientX: 4,
		clientY: 4,
		pointerId,
		pointerType: "touch",
	});
	fireEvent.pointerUp(element, {
		button: 0,
		clientX: 4,
		clientY: 4,
		pointerId,
		pointerType: "touch",
	});
}

describe("TitleBar", () => {
	test("renders the brand name from translations", () => {
		renderWithIntl();
		const banner = screen.getByRole("banner");
		expect(banner.textContent?.length).toBeGreaterThan(0);
	});

	test("renders three buttons (settings, minimize, close)", () => {
		renderWithIntl();
		expect(screen.getByRole("button", { name: /settings/i })).toBeTruthy();
		expect(screen.getByRole("button", { name: /minimize/i })).toBeTruthy();
		expect(screen.getByRole("button", { name: /close/i })).toBeTruthy();
	});

	test("centers the hotkey against the titlebar content area", () => {
		const { container } = renderWithIntl();
		const center = container.querySelector(
			'[data-slot="titlebar-hotkey-center"]',
		);
		expect(center?.className).toContain("top-0");
		expect(center?.className).toContain("bottom-px");
	});

	test("clicking the settings button opens the settings window", () => {
		renderWithIntl();
		fireEvent.click(screen.getByRole("button", { name: /settings/i }));
		// Typed command path: `open_window("settings")`, not a nativeBridge.send.
		expect(
			tauriCalls.some(
				(c) =>
					c.cmd === "open_window" &&
					(c.args as { name?: string }).name === "settings",
			),
		).toBe(true);
	});

	test("clicking minimize and close uses native window operations", async () => {
		renderWithIntl();
		fireEvent.click(screen.getByRole("button", { name: /minimize/i }));
		fireEvent.click(screen.getByRole("button", { name: /close/i }));
		await Promise.resolve();
		expect(windowCalls).toContain("minimize");
		expect(windowCalls).toContain("hide");
	});

	test("touch tapping minimize and close invokes each native operation once", async () => {
		renderWithIntl();
		const minimize = screen.getByRole("button", { name: /minimize/i });
		const close = screen.getByRole("button", { name: /close/i });
		touchTap(minimize, 1);
		fireEvent.click(minimize);
		touchTap(close, 2);
		fireEvent.click(close);
		await Promise.resolve();
		expect(
			windowCalls.filter((operation) => operation === "minimize"),
		).toHaveLength(1);
		expect(
			windowCalls.filter((operation) => operation === "hide"),
		).toHaveLength(1);
	});
});
