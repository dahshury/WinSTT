import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { HotkeyRecorder } from "./HotkeyRecorder";

const startCalls: number[] = [];
const stopCalls: number[] = [];
const originalApi = window.electronAPI;

beforeEach(() => {
	startCalls.length = 0;
	stopCalls.length = 0;
	window.electronAPI = {
		...originalApi,
		invoke: async (channel: string) => {
			if (channel === "hotkey:start-recording") {
				startCalls.push(1);
				return false;
			}
			return;
		},
		send: (channel: string) => {
			if (channel === "hotkey:stop-recording") {
				stopCalls.push(1);
			}
		},
	};
});

afterEach(() => {
	window.electronAPI = originalApi;
});

function renderIt(currentKey = "LCtrl+LMeta") {
	const onKeyRecorded = mock(() => undefined);
	return {
		...render(
			<IntlProvider>
				<HotkeyRecorder currentKey={currentKey} onKeyRecorded={onKeyRecorded} />
			</IntlProvider>
		),
		onKeyRecorded,
	};
}

describe("HotkeyRecorder", () => {
	test("displays the current key formatted with formatKeyName", () => {
		renderIt("LCtrl+A");
		expect(screen.getByText(/L Ctrl/)).toBeDefined();
	});

	test("the record button is initially in 'Record' state", () => {
		renderIt();
		const buttons = screen.getAllByRole("button");
		const recBtn = buttons.find((b) => /record/i.test(b.textContent ?? ""));
		expect(recBtn).toBeDefined();
	});

	test("clicking 'Record' calls hotkeyStartRecording (via window.electronAPI.invoke)", () => {
		renderIt();
		const buttons = screen.getAllByRole("button");
		const recBtn = buttons.find((b) => /record/i.test(b.textContent ?? ""));
		fireEvent.click(recBtn!);
		expect(startCalls.length).toBe(1);
	});
});
