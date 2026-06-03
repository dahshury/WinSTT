import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IPC } from "@/shared/api/ipc-channels";
import { initDiarizationToggleStore, useDiarizationToggleStore } from "./diarization-toggle-store";
import { useSettingsStore } from "./settings-store";

const originalApi = window.nativeBridge;
const initialSettings = useSettingsStore.getState().settings;
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

function installListeningApi() {
	listeners.clear();
	window.nativeBridge = {
		...originalApi,
		on: (channel: string, cb: (...args: unknown[]) => void) => {
			const list = listeners.get(channel) ?? [];
			list.push(cb);
			listeners.set(channel, list);
			return () => {
				listeners.set(
					channel,
					(listeners.get(channel) ?? []).filter((x) => x !== cb)
				);
			};
		},
	};
}

function fire(channel: string, ...args: unknown[]) {
	for (const cb of listeners.get(channel) ?? []) {
		cb(...args);
	}
}

beforeEach(() => {
	useDiarizationToggleStore.setState({ pending: false, lastError: null });
	useSettingsStore.setState({ settings: initialSettings, isLoaded: false });
	installListeningApi();
});

afterEach(() => {
	window.nativeBridge = originalApi;
});

describe("useDiarizationToggleStore actions", () => {
	test("begin sets pending=true and clears lastError", () => {
		useDiarizationToggleStore.setState({
			pending: false,
			lastError: { category: "unknown", detail: "old", enabled: true, reason: "old" },
		});
		useDiarizationToggleStore.getState().begin();
		expect(useDiarizationToggleStore.getState()).toMatchObject({
			pending: true,
			lastError: null,
		});
	});

	test("finish clears pending", () => {
		useDiarizationToggleStore.setState({ pending: true, lastError: null });
		useDiarizationToggleStore.getState().finish();
		expect(useDiarizationToggleStore.getState().pending).toBe(false);
	});

	test("fail records the error and clears pending", () => {
		useDiarizationToggleStore.setState({ pending: true, lastError: null });
		const info = {
			category: "out_of_memory" as const,
			detail: "OOM raw",
			enabled: true,
			reason: "Out of memory",
		};
		useDiarizationToggleStore.getState().fail(info);
		expect(useDiarizationToggleStore.getState()).toMatchObject({
			pending: false,
			lastError: info,
		});
	});
});

describe("initDiarizationToggleStore", () => {
	test("wires started → begin", () => {
		initDiarizationToggleStore();
		fire(IPC.STT_DIARIZATION_TOGGLE_STARTED);
		expect(useDiarizationToggleStore.getState().pending).toBe(true);
	});

	test("wires completed → finish", () => {
		useDiarizationToggleStore.setState({ pending: true, lastError: null });
		initDiarizationToggleStore();
		fire(IPC.STT_DIARIZATION_TOGGLE_COMPLETED);
		expect(useDiarizationToggleStore.getState().pending).toBe(false);
	});

	test("wires failed → fail with revert of the optimistic settings flip", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: { ...initialSettings.general, speakerDiarization: true },
			},
			isLoaded: true,
		});
		initDiarizationToggleStore();
		fire(IPC.STT_DIARIZATION_TOGGLE_FAILED, {
			category: "model_not_found",
			detail: "no model",
			enabled: true,
			reason: "no model",
		});
		const after = useSettingsStore.getState();
		// The optimistic toggle (true) is reverted to false because info.enabled === true
		expect(after.settings.general?.speakerDiarization).toBe(false);
		expect(useDiarizationToggleStore.getState().lastError?.reason).toBe("no model");
	});

	test("failed event does NOT touch settings when current state already differs", () => {
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				general: { ...initialSettings.general, speakerDiarization: false },
			},
			isLoaded: true,
		});
		initDiarizationToggleStore();
		// Server reports failure for an "enable" attempt — settings show
		// disabled so the optimistic flip already settled; revert path skips.
		fire(IPC.STT_DIARIZATION_TOGGLE_FAILED, {
			category: "model_not_found",
			detail: "no model",
			enabled: true,
			reason: "no model",
		});
		expect(useSettingsStore.getState().settings.general?.speakerDiarization).toBe(false);
	});

	test("unsub returned by initDiarizationToggleStore unwires every listener", () => {
		const unsub = initDiarizationToggleStore();
		unsub();
		// After unsub, firing the events should be no-ops.
		fire(IPC.STT_DIARIZATION_TOGGLE_STARTED);
		expect(useDiarizationToggleStore.getState().pending).toBe(false);
	});
});
