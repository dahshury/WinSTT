import { beforeEach, describe, expect, test } from "bun:test";
import { useHotkeyStore } from "./hotkey-store";

beforeEach(() => {
	useHotkeyStore.setState({
		isPressed: false,
		isActive: false,
		accelerator: "LCtrl+LMeta",
	});
});

describe("useHotkeyStore", () => {
	test("initial state has the default LCtrl+LMeta accelerator", () => {
		const state = useHotkeyStore.getState();
		expect(state.isPressed).toBe(false);
		expect(state.isActive).toBe(false);
		expect(state.accelerator).toBe("LCtrl+LMeta");
	});

	test("setPressed toggles only isPressed", () => {
		useHotkeyStore.getState().setActive(true);
		useHotkeyStore.getState().setPressed(true);
		const state = useHotkeyStore.getState();
		expect(state.isPressed).toBe(true);
		expect(state.isActive).toBe(true);
	});

	test("setActive toggles only isActive", () => {
		useHotkeyStore.getState().setPressed(true);
		useHotkeyStore.getState().setActive(true);
		const state = useHotkeyStore.getState();
		expect(state.isActive).toBe(true);
		expect(state.isPressed).toBe(true);
	});

	test("setAccelerator updates the accelerator string", () => {
		useHotkeyStore.getState().setAccelerator("F2");
		expect(useHotkeyStore.getState().accelerator).toBe("F2");
	});
});
