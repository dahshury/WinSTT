import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { IPC } from "@/shared/api/ipc-channels";
import { TitleBar } from "./TitleBar";

const originalApi = window.nativeBridge;
let sendCalls: Array<{ channel: string; args: unknown[] }>;

beforeEach(() => {
	sendCalls = [];
	window.nativeBridge = {
		...originalApi,
		send: (channel: string, ...args: unknown[]) => {
			sendCalls.push({ channel, args });
		},
	};
});

afterEach(() => {
	window.nativeBridge = originalApi;
});

function renderWithIntl() {
	return render(
		<IntlProvider>
			<TitleBar />
		</IntlProvider>
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
		const buttons = screen.getAllByRole("button");
		expect(buttons.length).toBeGreaterThanOrEqual(3);
	});

	test("clicking the settings button sends WINDOW_OPEN_SETTINGS", () => {
		renderWithIntl();
		const buttons = screen.getAllByRole("button");
		fireEvent.click(buttons[0]!);
		expect(sendCalls.some((c) => c.channel === IPC.WINDOW_OPEN_SETTINGS)).toBe(true);
	});

	test("clicking minimize and close sends their channels", () => {
		renderWithIntl();
		const buttons = screen.getAllByRole("button");
		fireEvent.click(buttons[1]!);
		fireEvent.click(buttons[2]!);
		expect(sendCalls.some((c) => c.channel === IPC.WINDOW_MINIMIZE)).toBe(true);
		expect(sendCalls.some((c) => c.channel === IPC.WINDOW_CLOSE)).toBe(true);
	});

	test("touch tapping minimize and close sends their channels without a synthesized click", () => {
		renderWithIntl();
		const buttons = screen.getAllByRole("button");
		touchTap(buttons[1]!, 1);
		fireEvent.click(buttons[1]!);
		touchTap(buttons[2]!, 2);
		fireEvent.click(buttons[2]!);
		expect(sendCalls.some((c) => c.channel === IPC.WINDOW_MINIMIZE)).toBe(true);
		expect(sendCalls.some((c) => c.channel === IPC.WINDOW_CLOSE)).toBe(true);
		expect(sendCalls.filter((c) => c.channel === IPC.WINDOW_MINIMIZE)).toHaveLength(1);
		expect(sendCalls.filter((c) => c.channel === IPC.WINDOW_CLOSE)).toHaveLength(1);
	});
});
