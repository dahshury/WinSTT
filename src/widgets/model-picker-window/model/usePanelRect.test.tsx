import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { commands } from "@/bindings";
import { NATIVE_EVENTS } from "@/shared/api/native-events";
import { usePanelRect } from "./usePanelRect";

const originalBridge = window.nativeBridge;
const originalReady = commands.windowModelPickerReady;
const originalRequestAnimationFrame = window.requestAnimationFrame;
const originalCancelAnimationFrame = window.cancelAnimationFrame;

let lifecycle: string[];

beforeEach(() => {
	lifecycle = [];
	window.nativeBridge = {
		...originalBridge,
		on: (channel: string) => {
			lifecycle.push(`listen:${channel}`);
			return () => undefined;
		},
	};
	// Model a native-hidden WebView whose animation frames are suspended. The
	// readiness handshake must not depend on a frame that cannot arrive yet.
	window.requestAnimationFrame = () => 1;
	window.cancelAnimationFrame = () => undefined;
	commands.windowModelPickerReady = async () => {
		lifecycle.push("ready");
		return { status: "ok", data: null };
	};
});

afterEach(() => {
	cleanup();
	window.nativeBridge = originalBridge;
	window.requestAnimationFrame = originalRequestAnimationFrame;
	window.cancelAnimationFrame = originalCancelAnimationFrame;
	commands.windowModelPickerReady = originalReady;
});

describe("usePanelRect readiness handshake", () => {
	test("requests the anchor immediately after both native listeners install", async () => {
		renderHook(() => usePanelRect(false));

		await waitFor(() => {
			expect(lifecycle).toEqual([
				`listen:${NATIVE_EVENTS.MODEL_PICKER_ANCHOR}`,
				`listen:${NATIVE_EVENTS.MODEL_PICKER_CLOSING}`,
				"ready",
			]);
		});
	});
});
