import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, render } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { commands } from "@/bindings";
import { DevicePickerWindow } from "./DevicePickerWindow";

const originalStart = commands.startMicrophoneLevelMonitor;
const originalStop = commands.stopMicrophoneLevelMonitor;
let startCalls = 0;
let stopCalls = 0;

beforeEach(() => {
	startCalls = 0;
	stopCalls = 0;
	commands.startMicrophoneLevelMonitor = (async () => {
		startCalls += 1;
	}) satisfies typeof commands.startMicrophoneLevelMonitor;
	commands.stopMicrophoneLevelMonitor = (async () => {
		stopCalls += 1;
	}) satisfies typeof commands.stopMicrophoneLevelMonitor;
});

afterEach(() => {
	commands.startMicrophoneLevelMonitor = originalStart;
	commands.stopMicrophoneLevelMonitor = originalStop;
});

describe("DevicePickerWindow", () => {
	test("does NOT start the mic level monitor while hidden (prewarmed at boot)", () => {
		render(
			<IntlProvider>
				<DevicePickerWindow />
			</IntlProvider>,
		);
		expect(startCalls).toBe(0);
	});

	test("starts metering when shown and stops when hidden again", () => {
		render(
			<IntlProvider>
				<DevicePickerWindow />
			</IntlProvider>,
		);
		act(() => {
			window.dispatchEvent(new Event("winstt:device-picker-shown"));
		});
		expect(startCalls).toBeGreaterThan(0);
		expect(stopCalls).toBe(0);
		act(() => {
			window.dispatchEvent(new Event("winstt:device-picker-hidden"));
		});
		expect(stopCalls).toBeGreaterThan(0);
	});
});
