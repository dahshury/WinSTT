import { describe, expect, test } from "bun:test";
import {
	createWindowTelemetryPayload,
	registerWindowTelemetry,
	type WindowTelemetryEventName,
} from "./window-telemetry";

function createFakeWindow(bounds = { x: 10, y: 20, width: 420, height: 150 }) {
	const listeners = new Map<string, Array<() => void>>();
	return {
		getBounds: () => bounds,
		on(eventName: string, listener: () => void) {
			const existing = listeners.get(eventName) ?? [];
			existing.push(listener);
			listeners.set(eventName, existing);
		},
		off(eventName: string, listener: () => void) {
			const existing = listeners.get(eventName) ?? [];
			listeners.set(
				eventName,
				existing.filter((item) => item !== listener)
			);
		},
		emit(eventName: string) {
			for (const listener of listeners.get(eventName) ?? []) {
				listener();
			}
		},
		listenerCount(eventName: string) {
			return (listeners.get(eventName) ?? []).length;
		},
	};
}

describe("createWindowTelemetryPayload", () => {
	test("returns payload with event name and window bounds", () => {
		const payload = createWindowTelemetryPayload("moved", {
			x: 100,
			y: 200,
			width: 300,
			height: 400,
		});
		expect(payload).toEqual({
			event: "moved",
			bounds: { x: 100, y: 200, width: 300, height: 400 },
		});
	});
});

describe("registerWindowTelemetry", () => {
	test("forwards registered window events to callback and detaches on cleanup", () => {
		const fakeWindow = createFakeWindow();
		const emitted: WindowTelemetryEventName[] = [];

		const cleanup = registerWindowTelemetry(fakeWindow, (payload) => {
			emitted.push(payload.event);
		});

		fakeWindow.emit("move");
		fakeWindow.emit("resize");
		fakeWindow.emit("focus");

		expect(emitted).toEqual(["moved", "resized", "focused"]);
		expect(fakeWindow.listenerCount("move")).toBe(1);

		cleanup();
		expect(fakeWindow.listenerCount("move")).toBe(0);
	});
});
