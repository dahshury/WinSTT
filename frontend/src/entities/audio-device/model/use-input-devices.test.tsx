import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useInputDevices } from "./use-input-devices";

interface FakeMediaDevices {
	addEventListener: (type: string, handler: EventListener) => void;
	dispatchEvent: (event: Event) => boolean;
	removeEventListener: (type: string, handler: EventListener) => void;
}

function installFakeMediaDevices(): {
	mediaDevices: FakeMediaDevices;
	addedListeners: Map<string, EventListener[]>;
} {
	const target = new EventTarget();
	const added = new Map<string, EventListener[]>();
	const fake: FakeMediaDevices = {
		addEventListener: (type, handler) => {
			target.addEventListener(type, handler);
			const list = added.get(type) ?? [];
			list.push(handler);
			added.set(type, list);
		},
		removeEventListener: (type, handler) => {
			target.removeEventListener(type, handler);
			const list = added.get(type) ?? [];
			added.set(
				type,
				list.filter((l) => l !== handler)
			);
		},
		dispatchEvent: (event) => target.dispatchEvent(event),
	};
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		writable: true,
		value: fake,
	});
	return { mediaDevices: fake, addedListeners: added };
}

interface FakeApi {
	getPathForFile: () => string;
	invoke: (channel: string) => Promise<unknown>;
	on: () => () => void;
	secureInvoke: () => Promise<unknown>;
	send: () => void;
}

let invokeQueue: unknown[] = [];
let invokeCalls: string[] = [];

function installFakeElectron(): void {
	invokeQueue = [];
	invokeCalls = [];
	const api: FakeApi = {
		send: () => undefined,
		invoke: async (channel: string) => {
			invokeCalls.push(channel);
			const value = invokeQueue.shift();
			return value ?? [];
		},
		on: () => () => undefined,
		getPathForFile: () => "",
		secureInvoke: async () => undefined,
	};
	(window as unknown as { electronAPI: FakeApi }).electronAPI = api;
}

function queueDevices(devices: Array<{ index: number; name: string; isDefault: boolean }>): void {
	invokeQueue.push(devices);
}

beforeEach(() => {
	installFakeElectron();
});

afterEach(() => {
	(window as { electronAPI?: unknown }).electronAPI = undefined;
	try {
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			writable: true,
			value: undefined,
		});
	} catch {
		// ignore
	}
});

describe("useInputDevices", () => {
	test("fetches devices on mount and reports the default device", async () => {
		installFakeMediaDevices();
		queueDevices([
			{ index: 0, name: "Built-in Mic", isDefault: true },
			{ index: 1, name: "USB Mic", isDefault: false },
		]);
		const { result } = renderHook(() => useInputDevices());
		await waitFor(() => expect(result.current.devices.length).toBe(2));
		expect(result.current.defaultDevice?.name).toBe("Built-in Mic");
	});

	test("re-fetches when navigator.mediaDevices fires a devicechange event", async () => {
		const { mediaDevices } = installFakeMediaDevices();
		queueDevices([{ index: 0, name: "Built-in Mic", isDefault: true }]);
		const { result } = renderHook(() => useInputDevices());
		await waitFor(() => expect(result.current.devices.length).toBe(1));

		queueDevices([
			{ index: 0, name: "Built-in Mic", isDefault: true },
			{ index: 2, name: "Newly Plugged USB", isDefault: false },
		]);
		act(() => {
			mediaDevices.dispatchEvent(new Event("devicechange"));
		});
		await waitFor(() => expect(result.current.devices.length).toBe(2));
		expect(result.current.devices[1]?.name).toBe("Newly Plugged USB");
		// Two invocations: one on mount, one on devicechange.
		expect(invokeCalls.filter((c) => c === "audio:get-devices").length).toBe(2);
	});

	test("removes the devicechange listener on unmount", async () => {
		const { addedListeners } = installFakeMediaDevices();
		const { unmount } = renderHook(() => useInputDevices());
		await waitFor(() => expect(addedListeners.get("devicechange")?.length ?? 0).toBe(1));
		unmount();
		expect(addedListeners.get("devicechange")?.length ?? 0).toBe(0);
	});
});
