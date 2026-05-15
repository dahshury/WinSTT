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

	test.each<[string, WindowTelemetryEventName]>([
		["move", "moved"],
		["resize", "resized"],
		["focus", "focused"],
		["blur", "blurred"],
		["show", "shown"],
		["hide", "hidden"],
		["minimize", "minimized"],
		["restore", "restored"],
		["maximize", "maximized"],
		["unmaximize", "unmaximized"],
	])("electron event %s maps to telemetry event %s", (electronEvent, telemetryEvent) => {
		const fakeWindow = createFakeWindow();
		const emitted: WindowTelemetryEventName[] = [];
		const cleanup = registerWindowTelemetry(fakeWindow, (p) => emitted.push(p.event));
		fakeWindow.emit(electronEvent);
		expect(emitted).toEqual([telemetryEvent]);
		cleanup();
	});

	test("registers exactly one listener per electron event and removes them all on cleanup", () => {
		const fakeWindow = createFakeWindow();
		const cleanup = registerWindowTelemetry(fakeWindow, () => undefined);
		const electronEvents = [
			"move",
			"resize",
			"focus",
			"blur",
			"show",
			"hide",
			"minimize",
			"restore",
			"maximize",
			"unmaximize",
		];
		for (const ev of electronEvents) {
			expect(fakeWindow.listenerCount(ev)).toBe(1);
		}
		cleanup();
		for (const ev of electronEvents) {
			expect(fakeWindow.listenerCount(ev)).toBe(0);
		}
	});

	test("forwards live window bounds at the time the event fires", () => {
		const bounds = { x: 1, y: 2, width: 3, height: 4 };
		const fakeWindow = createFakeWindow(bounds);
		const payloads: Array<{ event: WindowTelemetryEventName; bounds: typeof bounds }> = [];
		const cleanup = registerWindowTelemetry(fakeWindow, (p) =>
			payloads.push({ event: p.event, bounds: p.bounds })
		);
		// Mutate bounds before emit — getBounds returns the live reference.
		bounds.x = 99;
		bounds.width = 200;
		fakeWindow.emit("resize");
		expect(payloads[0]?.bounds).toEqual({ x: 99, y: 2, width: 200, height: 4 });
		cleanup();
	});
});

describe("createWindowTelemetryPayload (mutation guard)", () => {
	test("never returns a reference to the input bounds (defensive copy guard)", () => {
		// The implementation builds a new object: `bounds: { x, y, width, height }`.
		// If any field were stripped from the literal, the test would fail.
		const input = { x: 1, y: 2, width: 3, height: 4 };
		const payload = createWindowTelemetryPayload("moved", input);
		expect(payload.bounds).toEqual(input);
		expect(payload.bounds).not.toBe(input);
		// Each field is independently copied — verify all four exist.
		expect(payload.bounds.x).toBe(1);
		expect(payload.bounds.y).toBe(2);
		expect(payload.bounds.width).toBe(3);
		expect(payload.bounds.height).toBe(4);
	});
});
