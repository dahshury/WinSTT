import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { IPC } from "@/shared/api/ipc-channels";
import { TitleBar } from "./TitleBar";

// next/image fails under happy-dom (Invalid URL on relative src). Stub it.
mock.module("next/image", () => ({
	__esModule: true,
	default: (props: Record<string, unknown>) => {
		const { alt, ...rest } = props as { alt?: string } & Record<string, unknown>;
		return <img alt={alt ?? ""} {...rest} />;
	},
}));

const originalApi = window.electronAPI;
let sendCalls: Array<{ channel: string; args: unknown[] }>;

beforeEach(() => {
	sendCalls = [];
	window.electronAPI = {
		...originalApi,
		send: (channel: string, ...args: unknown[]) => {
			sendCalls.push({ channel, args });
		},
	};
});

afterEach(() => {
	window.electronAPI = originalApi;
});

function renderWithIntl() {
	return render(
		<IntlProvider>
			<TitleBar />
		</IntlProvider>
	);
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
});
