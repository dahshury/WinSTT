import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { commands } from "@/bindings";
import { closeModelPicker, openModelPickerAtRect } from "./model-picker-window";
import {
	setModelPickerWindowOpen,
	useModelPickerWindowOpen,
} from "./model-picker-window-state";
import { NATIVE_EVENTS } from "./native-events";

const anchor = { x: 10, y: 20, width: 300, height: 40 };
const originalBridge = window.nativeBridge;
let restoreCommand: (() => void) | undefined;

afterEach(() => {
	act(() => setModelPickerWindowOpen(false));
	restoreCommand?.();
	restoreCommand = undefined;
	window.nativeBridge = originalBridge;
});

describe("detached model picker hover state", () => {
	test("suppresses hover immediately and restores it when the native picker closes", () => {
		let closing: (() => void) | undefined;
		window.nativeBridge = {
			...originalBridge,
			on: (channel, callback) => {
				if (channel === NATIVE_EVENTS.MODEL_PICKER_CLOSING) {
					closing = callback;
				}
				return () => undefined;
			},
		};
		const command = spyOn(commands, "openWindow").mockResolvedValue({
			status: "ok",
			data: null,
		});
		restoreCommand = () => command.mockRestore();
		const { result } = renderHook(useModelPickerWindowOpen);
		act(() => openModelPickerAtRect(anchor, { pickerKind: "tts" }));
		expect(result.current).toBe(true);
		expect(command).toHaveBeenCalledWith(
			"model-picker",
			10,
			20,
			300,
			40,
			"tts",
			null,
			null,
		);
		expect(closing).toBeDefined();
		act(() => closing?.());
		expect(result.current).toBe(false);
	});

	test("restores hover when opening the picker fails", async () => {
		const command = spyOn(commands, "openWindow").mockResolvedValue({
			status: "error",
			error: "Window unavailable",
		});
		restoreCommand = () => command.mockRestore();
		const { result } = renderHook(useModelPickerWindowOpen);
		await act(async () => openModelPickerAtRect(anchor));
		expect(result.current).toBe(false);
	});

	test("explicit close restores hover", () => {
		const command = spyOn(commands, "closeWindow").mockResolvedValue({
			status: "ok",
			data: null,
		});
		restoreCommand = () => command.mockRestore();
		const { result } = renderHook(useModelPickerWindowOpen);
		act(() => setModelPickerWindowOpen(true));
		act(() => closeModelPicker());
		expect(result.current).toBe(false);
	});
});
