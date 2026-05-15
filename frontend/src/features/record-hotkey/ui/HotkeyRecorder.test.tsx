import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import {
	formatCombo,
	HotkeyRecorder,
	resolveDisplayText,
	resolveRecorderState,
} from "./HotkeyRecorder";

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

describe("resolveRecorderState", () => {
	const stop = () => undefined;
	const start = () => undefined;
	test("returns recording classes when recording=true", () => {
		const s = resolveRecorderState(true, stop, start, "Stop", "Record");
		expect(s.displayClass).toContain("bg-orange-dim");
		expect(s.btnClass).toContain("bg-error-dim");
		expect(s.btnLabel).toBe("Stop");
		expect(s.btnAction).toBe(stop);
	});
	test("returns idle classes when recording=false", () => {
		const s = resolveRecorderState(false, stop, start, "Stop", "Record");
		expect(s.displayClass).toContain("bg-surface-tertiary");
		expect(s.btnClass).not.toContain("bg-error-dim");
		expect(s.btnLabel).toBe("Record");
		expect(s.btnAction).toBe(start);
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
