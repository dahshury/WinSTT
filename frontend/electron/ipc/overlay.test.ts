import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const storeData: Record<string, unknown> = {};
const storeChangeHandlers = new Map<string, Array<(value: unknown) => void>>();

import { storeMock } from "@test/mocks/store";

mock.module("../lib/store", () => ({
	...storeMock(),
	store: {
		onDidChange: (key: string, cb: (value: unknown) => void) => {
			const list = storeChangeHandlers.get(key) ?? [];
			list.push(cb);
			storeChangeHandlers.set(key, list);
			return () => {
				storeChangeHandlers.set(
					key,
					(storeChangeHandlers.get(key) ?? []).filter((x) => x !== cb)
				);
			};
		},
	},
	getStoreValue: (key: string) => {
		const [section, sub] = key.split(".");
		const top = section ? storeData[section] : undefined;
		if (top != null && typeof top === "object" && sub) {
			return (top as Record<string, unknown>)[sub];
		}
		return top;
	},
}));

import { electronMock } from "@test/mocks/electron";

mock.module("electron", () => ({
	...electronMock(),
	screen: {
		getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }),
	},
}));

const { setOverlayWindow, showOverlay, hideOverlay, setupOverlayHandlers } = await import(
	"./overlay"
);

interface MockWin {
	calls: string[];
	getSize: () => number[];
	hide: () => void;
	setPosition: (x: number, y: number) => void;
	showInactive: () => void;
}

function makeWindow(): MockWin {
	const calls: string[] = [];
	return {
		getSize: () => [800, 120],
		setPosition: () => {
			calls.push("setPosition");
		},
		showInactive: () => {
			calls.push("show");
		},
		hide: () => {
			calls.push("hide");
		},
		calls,
	};
}

beforeEach(() => {
	for (const k of Object.keys(storeData)) {
		delete storeData[k];
	}
	storeChangeHandlers.clear();
	storeData.general = {
		showRecordingOverlay: true,
		recordingMode: "ptt",
	};
});

afterEach(() => {
	for (const k of Object.keys(storeData)) {
		delete storeData[k];
	}
	storeChangeHandlers.clear();
});

describe("overlay handlers", () => {
	test("showOverlay is a no-op when no window has been registered", () => {
		// (no setOverlayWindow called)
		expect(() => showOverlay()).not.toThrow();
	});

	test("showOverlay positions and shows the window when enabled and not in listen mode", () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		showOverlay();
		expect(win.calls).toEqual(["setPosition", "show"]);
	});

	test("showOverlay does NOT show when overlay is disabled in settings", () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		(storeData.general as Record<string, unknown>).showRecordingOverlay = false;
		showOverlay();
		expect(win.calls).toEqual([]);
	});

	test("showOverlay does NOT show in listen recording mode", () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		(storeData.general as Record<string, unknown>).recordingMode = "listen";
		showOverlay();
		expect(win.calls).toEqual([]);
	});

	test("hideOverlay calls window.hide when registered", () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		hideOverlay();
		expect(win.calls).toContain("hide");
	});

	test("setupOverlayHandlers wires store change listeners and returns a disposer", () => {
		const dispose = setupOverlayHandlers();
		expect(storeChangeHandlers.has("general.showRecordingOverlay")).toBe(true);
		expect(storeChangeHandlers.has("general.recordingMode")).toBe(true);
		dispose();
		expect(storeChangeHandlers.get("general.showRecordingOverlay")?.length ?? 0).toBe(0);
		expect(storeChangeHandlers.get("general.recordingMode")?.length ?? 0).toBe(0);
	});

	test("disabling the overlay setting hides the window via the change handler", () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		setupOverlayHandlers();
		const handler = storeChangeHandlers.get("general.showRecordingOverlay")?.[0];
		expect(handler).toBeDefined();
		handler!(false);
		expect(win.calls).toContain("hide");
	});

	test("switching to listen recording mode hides the window", () => {
		const win = makeWindow();
		setOverlayWindow(win as unknown as Parameters<typeof setOverlayWindow>[0]);
		setupOverlayHandlers();
		const handler = storeChangeHandlers.get("general.recordingMode")?.[0];
		expect(handler).toBeDefined();
		handler!("listen");
		expect(win.calls).toContain("hide");
	});
});
