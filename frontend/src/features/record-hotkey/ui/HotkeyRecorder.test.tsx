import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { formatCombo, HotkeyRecorder, resolveDisplayText } from "./HotkeyRecorder";

const startCalls: number[] = [];
const stopCalls: number[] = [];
let savedApi: typeof window.electronAPI;

beforeEach(() => {
	savedApi = window.electronAPI;
	startCalls.length = 0;
	stopCalls.length = 0;
	window.electronAPI = {
		getPathForFile: () => "",
		secureInvoke: () => Promise.resolve(undefined),
		on: () => () => {
			/* noop unsubscribe */
		},
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
	window.electronAPI = savedApi;
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

describe("formatCombo", () => {
	test("formats a single key", () => {
		expect(formatCombo("A")).toBe("A");
	});
	test("joins multiple keys with ' + '", () => {
		expect(formatCombo("LCtrl+LMeta")).toBe("L Ctrl + L Win");
	});
});

describe("resolveDisplayText", () => {
	test("when not recording returns formatted currentKey", () => {
		expect(resolveDisplayText(false, [], "LCtrl+A", "Press keys")).toBe("L Ctrl + A");
	});
	test("when recording with liveKeys returns them joined with ' + '", () => {
		const result = resolveDisplayText(true, ["LCtrl", "A"], "LCtrl+A", "Press keys");
		expect(result).toContain("L Ctrl");
		expect(result).toContain("A");
	});
	test("when recording with no liveKeys returns pressKeysLabel", () => {
		expect(resolveDisplayText(true, [], "LCtrl+A", "Press keys...")).toBe("Press keys...");
	});
});

describe("HotkeyRecorder", () => {
	test("displays the current key formatted with formatKeyName", () => {
		renderIt("LCtrl+A");
		expect(screen.getByText(/L Ctrl/)).toBeDefined();
	});

	test("the record button is initially in the idle (Record) state", () => {
		renderIt();
		// Idle state: button is aria-labelled "Record" (icon-only).
		const recBtn = screen.getByRole("button", { name: /record/i });
		expect(recBtn).toBeDefined();
	});

	test("clicking the record button calls hotkeyStartRecording (via window.electronAPI.invoke)", () => {
		renderIt();
		const recBtn = screen.getByRole("button", { name: /record/i });
		fireEvent.click(recBtn);
		expect(startCalls.length).toBe(1);
	});
});
