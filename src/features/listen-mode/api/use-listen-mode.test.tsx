import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import {
	useCatalogStore,
	useModelStateStore,
	type ModelInfo,
} from "@/entities/model-catalog";
import { commands } from "@/bindings";
import { _resetOutputDevicesCacheForTests } from "@/entities/audio-device/model/use-output-devices";
import { useConnectionStore } from "@/entities/connection";
import { useSettingsStore } from "@/entities/setting";
import { useTranscriptionStore } from "@/entities/transcription";
import { IPC } from "@/shared/api/ipc-channels";
import { useListenStore } from "../model/listen-store";
import {
	applyLoopbackTransition,
	handleLoopbackListError,
	resolveOutputLoopbackDeviceIndex,
	useListenMode,
	validateDevices,
} from "./use-listen-mode";

const originalApi = window.nativeBridge;
const initialSettings = useSettingsStore.getState().settings;
const STREAMING_MODEL_ID = "streaming-nemo-ctc-en-1040ms";
const tauriCalls: Array<{
	args: Record<string, unknown> | undefined;
	cmd: string;
}> = [];
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
const originalCommands = {
	getAudioOutputDevices: commands.getAudioOutputDevices,
	loopbackListDevices: commands.loopbackListDevices,
	refreshAudioOutputDevices: commands.refreshAudioOutputDevices,
	startListen: commands.startListen,
	stopListen: commands.stopListen,
	sttListModelsWithState: commands.sttListModelsWithState,
};

mock.module("@tauri-apps/api/core", () => ({
	invoke: (cmd: string, args?: Record<string, unknown>) => {
		tauriCalls.push({ cmd, args });
		if (cmd === "loopback_list_devices") {
			return Promise.resolve([
				{
					id: "endpoint-speakers",
					index: 0,
					name: "Speakers",
					defaultSampleRate: 48_000,
					maxOutputChannels: 2,
					isDefault: true,
				},
				{
					id: "endpoint-headset",
					index: 3,
					name: "Headset",
					defaultSampleRate: 48_000,
					maxOutputChannels: 2,
					isDefault: false,
				},
			]);
		}
		if (
			cmd === "get_audio_output_devices" ||
			cmd === "refresh_audio_output_devices"
		) {
			return Promise.resolve([
				{ index: 0, isDefault: true, name: "Speakers" },
				{ index: 1, isDefault: false, name: "Headset" },
			]);
		}
		if (cmd === "stt_list_models_with_state") {
			return Promise.resolve({
				models: [],
				states: [streamingModelState],
				system_info: { gpus: [], total_ram_bytes: 0 },
			});
		}
		return Promise.resolve(undefined);
	},
	Channel: class {},
}));

const streamingModel: ModelInfo = {
	accuracyScore: 0.8,
	available: true,
	availableQuantizations: ["int8"],
	backend: "onnx_asr",
	description: "Streaming model",
	displayName: "Streaming NeMo CTC",
	errorMessage: "",
	family: "nemo",
	finalReuseSafe: true,
	id: STREAMING_MODEL_ID,
	languages: ["en"],
	localPath: null,
	nativeStreaming: true,
	onnxModelName: "streaming-nemo-ctc-en-1040ms",
	previewCapable: true,
	sizeBytesByQuantization: { int8: 1 },
	sizeLabel: "100M",
	speedScore: 0.9,
	supportsLanguageDetection: false,
	supportsRealtime: true,
};

const streamingModelState = {
	available_quantizations: ["int8"],
	cache: {
		downloaded_bytes: 1,
		progress: 1,
		state: "cached" as const,
		total_bytes: 1,
	},
	cache_by_quantization: {
		int8: {
			downloaded_bytes: 1,
			progress: 1,
			state: "cached" as const,
			total_bytes: 1,
		},
	},
	comfortable_on_cpu: true,
	comfortable_on_gpu: true,
	effective_quantization: "int8",
	estimated_bytes: 1,
	id: STREAMING_MODEL_ID,
};

function tauriCommandNames(): string[] {
	return tauriCalls.map((call) => call.cmd);
}

function loopbackDevicesPayload() {
	return [
		{
			id: "endpoint-speakers",
			index: 0,
			name: "Speakers",
			defaultSampleRate: 48_000,
			maxOutputChannels: 2,
			isDefault: true,
		},
		{
			id: "endpoint-headset",
			index: 3,
			name: "Headset",
			defaultSampleRate: 48_000,
			maxOutputChannels: 2,
			isDefault: false,
		},
	];
}

function audioOutputDevicesPayload() {
	return [
		{ index: 0, isDefault: true, name: "Speakers" },
		{ index: 1, isDefault: false, name: "Headset" },
	];
}

function modelsWithStatePayload() {
	return {
		models: [],
		states: [streamingModelState],
		system_info: { gpus: [], total_ram_bytes: 0 },
	};
}

function recordTauriCommand(
	cmd: string,
	args: Record<string, unknown> | undefined,
): void {
	tauriCalls.push({ cmd, args });
}

function makeApi() {
	listeners.clear();
	tauriCalls.length = 0;
	return {
		...originalApi,
		invoke: async (channel: string) => {
			if (channel === IPC.LOOPBACK_LIST_DEVICES) {
				return loopbackDevicesPayload();
			}
			if (
				channel === IPC.AUDIO_GET_OUTPUT_DEVICES ||
				channel === IPC.AUDIO_REFRESH_OUTPUT_DEVICES
			) {
				return audioOutputDevicesPayload();
			}
			if (channel === IPC.STT_LIST_MODELS_WITH_STATE) {
				return modelsWithStatePayload();
			}
			return undefined;
		},
		send: (channel: string, payload?: Record<string, unknown>) => {
			if (channel === IPC.LOOPBACK_START) {
				recordTauriCommand("start_listen", payload);
			}
			if (channel === IPC.LOOPBACK_STOP) {
				recordTauriCommand("stop_listen", undefined);
			}
		},
		on: (channel: string, cb: (...args: unknown[]) => void) => {
			const list = listeners.get(channel) ?? [];
			list.push(cb);
			listeners.set(channel, list);
			return () => {
				listeners.set(
					channel,
					(listeners.get(channel) ?? []).filter((x) => x !== cb),
				);
			};
		},
	};
}

beforeEach(() => {
	commands.startListen = async (deviceIndex: number, modelId: string) => {
		recordTauriCommand("start_listen", { deviceIndex, modelId });
		return { status: "ok", data: null };
	};
	commands.stopListen = async () => {
		recordTauriCommand("stop_listen", undefined);
	};
	commands.loopbackListDevices = async () => loopbackDevicesPayload();
	commands.getAudioOutputDevices = async () => audioOutputDevicesPayload();
	commands.refreshAudioOutputDevices = async () => audioOutputDevicesPayload();
	commands.sttListModelsWithState = async () => ({
		status: "ok",
		data: modelsWithStatePayload(),
	});
	_resetOutputDevicesCacheForTests();
	useCatalogStore.setState({
		getFamilies: useCatalogStore.getState().getFamilies,
		getModel: useCatalogStore.getState().getModel,
		isLoaded: true,
		models: [streamingModel],
		setModels: useCatalogStore.getState().setModels,
	});
	useModelStateStore.setState({
		isLoaded: true,
		statesById: { [STREAMING_MODEL_ID]: streamingModelState },
		systemInfo: null,
	});
	useSettingsStore.setState({
		settings: {
			...initialSettings,
			model: {
				...initialSettings.model,
				realtimeModel: STREAMING_MODEL_ID,
			},
			general: {
				...initialSettings.general,
				onboarded: true,
				onboardedAt: 1,
			},
		},
	});
	useConnectionStore.setState({ connectionStatus: "disconnected" });
	useListenStore.setState({ isListening: false, deviceName: "", devices: [] });
	useTranscriptionStore.setState({
		items: [],
		currentRealtime: "",
		ephemeral: null,
		isRecordingActive: false,
		isTranscribing: false,
		processingPhase: null,
		recordingSessionId: 0,
		transcribingStartedAt: null,
	});
});

afterEach(() => {
	commands.startListen = originalCommands.startListen;
	commands.stopListen = originalCommands.stopListen;
	commands.loopbackListDevices = originalCommands.loopbackListDevices;
	commands.getAudioOutputDevices = originalCommands.getAudioOutputDevices;
	commands.refreshAudioOutputDevices =
		originalCommands.refreshAudioOutputDevices;
	commands.sttListModelsWithState = originalCommands.sttListModelsWithState;
	window.nativeBridge = originalApi;
	useSettingsStore.setState({ settings: initialSettings });
	useConnectionStore.setState({ connectionStatus: "disconnected" });
	useCatalogStore.setState({ isLoaded: false, models: [] });
	useModelStateStore.setState({
		isLoaded: false,
		statesById: {},
		systemInfo: null,
	});
	_resetOutputDevicesCacheForTests();
});

function fire(channel: string, ...args: unknown[]) {
	for (const cb of listeners.get(channel) ?? []) {
		cb(...args);
	}
}

async function flushAsyncHookEffects() {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

function seedTranscription(text = "stale transcript") {
	useTranscriptionStore.setState({
		items: [{ id: "old", type: "final", text, timestamp: 1 }],
		currentRealtime: "stale realtime",
		ephemeral: { text: "stale status", timestamp: 1 },
		isRecordingActive: true,
		isTranscribing: true,
		processingPhase: "transcribing",
		recordingSessionId: 9,
		transcribingStartedAt: 1,
	});
}

function setRecordingMode(
	recordingMode: "ptt" | "toggle" | "listen" | "wakeword",
) {
	useSettingsStore.setState({
		settings: {
			...initialSettings,
			model: {
				...initialSettings.model,
				realtimeModel: STREAMING_MODEL_ID,
			},
			general: {
				...initialSettings.general,
				onboarded: true,
				onboardedAt: 1,
				recordingMode,
				loopbackDeviceIndex: 3,
			},
		},
	});
}

describe("validateDevices", () => {
	test("returns valid devices from a raw array", () => {
		const raw = [
			{
				index: 0,
				name: "Speakers",
				defaultSampleRate: 48_000,
				maxOutputChannels: 2,
			},
			{
				index: 1,
				name: "Mic",
				defaultSampleRate: 44_100,
				maxOutputChannels: 0,
			},
		];
		const result = validateDevices(raw);
		expect(result).toHaveLength(2);
		expect(result[0]?.name).toBe("Speakers");
	});

	test("drops entries that fail Zod validation", () => {
		const raw = [
			{
				index: 0,
				name: "Valid",
				defaultSampleRate: 48_000,
				maxOutputChannels: 2,
			},
			{ index: "bad", name: 42 }, // invalid
		];
		const result = validateDevices(raw);
		expect(result).toHaveLength(1);
		expect(result[0]?.name).toBe("Valid");
	});

	test("returns empty array for empty input", () => {
		expect(validateDevices([])).toEqual([]);
	});
});

describe("applyLoopbackTransition", () => {
	test("calls loopbackStart when mode=listen, device set, and model selected", () => {
		window.nativeBridge = makeApi();
		applyLoopbackTransition("listen", false, 3, STREAMING_MODEL_ID);
		expect(tauriCommandNames()).toContain("start_listen");
		expect(tauriCalls).toContainEqual({
			cmd: "start_listen",
			args: { deviceIndex: 3, modelId: STREAMING_MODEL_ID },
		});
	});

	test("does not call loopbackStart when device index is null", () => {
		window.nativeBridge = makeApi();
		applyLoopbackTransition("listen", false, null, STREAMING_MODEL_ID);
		expect(tauriCommandNames()).not.toContain("start_listen");
	});

	test("does not call loopbackStart when the streaming model is missing", () => {
		window.nativeBridge = makeApi();
		applyLoopbackTransition("listen", false, 3, null);
		expect(tauriCommandNames()).not.toContain("start_listen");
	});

	test("restarts loopback when the selected output device changes", () => {
		window.nativeBridge = makeApi();
		applyLoopbackTransition(
			"listen",
			true,
			4,
			STREAMING_MODEL_ID,
			3,
			STREAMING_MODEL_ID,
		);
		expect(tauriCommandNames()).toEqual(["stop_listen", "start_listen"]);
		expect(tauriCalls[1]).toEqual({
			cmd: "start_listen",
			args: { deviceIndex: 4, modelId: STREAMING_MODEL_ID },
		});
	});

	test("calls loopbackStop when transitioning away from listen mode", () => {
		window.nativeBridge = makeApi();
		applyLoopbackTransition("ptt", true, null, null);
		expect(tauriCommandNames()).toContain("stop_listen");
	});

	test("calls loopbackStop when leaving listen even if connection display is stale", () => {
		window.nativeBridge = makeApi();
		useConnectionStore.setState({ connectionStatus: "disconnected" });
		applyLoopbackTransition("ptt", true, null, null);
		expect(tauriCommandNames()).toContain("stop_listen");
	});
});

describe("resolveOutputLoopbackDeviceIndex", () => {
	const loopbackDevices = [
		{
			id: "endpoint-speakers",
			index: 0,
			name: "Speakers",
			defaultSampleRate: 48_000,
			maxOutputChannels: 2,
			isDefault: true,
		},
		{
			id: "endpoint-headset",
			index: 3,
			name: "Headset",
			defaultSampleRate: 48_000,
			maxOutputChannels: 2,
			isDefault: false,
		},
	];
	const outputDevices = [
		{ deviceId: "default", isDefault: true, label: "Speakers" },
		{ deviceId: "headset-sink", isDefault: false, label: "Headset" },
	];

	test("uses the default output loopback when no output device is selected", () => {
		expect(
			resolveOutputLoopbackDeviceIndex(loopbackDevices, outputDevices, ""),
		).toBe(0);
	});

	test("maps the selected output device to the matching loopback endpoint", () => {
		expect(
			resolveOutputLoopbackDeviceIndex(
				loopbackDevices,
				outputDevices,
				"headset-sink",
			),
		).toBe(3);
	});

	test("falls back to the default loopback when the selected output device has no match", () => {
		expect(
			resolveOutputLoopbackDeviceIndex(
				loopbackDevices,
				[{ deviceId: "hdmi-sink", isDefault: false, label: "HDMI" }],
				"hdmi-sink",
			),
		).toBe(0);
	});
});

describe("handleLoopbackListError", () => {
	const originalError = console.error;
	let calls: unknown[][] = [];

	beforeEach(() => {
		calls = [];
		console.error = (...args: unknown[]) => {
			calls.push(args);
		};
	});

	afterEach(() => {
		console.error = originalError;
	});

	test("logs the error when the effect was not cancelled", () => {
		const err = new Error("boom");
		handleLoopbackListError(err, false);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[1]).toBe(err);
	});

	test("logs non-Error rejection values", () => {
		handleLoopbackListError("string-rejection", false);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[1]).toBe("string-rejection");
	});

	test("does not log when the effect was cancelled", () => {
		handleLoopbackListError(new Error("ignored"), true);
		expect(calls).toHaveLength(0);
	});
});

describe("useListenMode", () => {
	test("subscribes to loopback started/stopped events", async () => {
		window.nativeBridge = makeApi();
		renderHook(() => useListenMode());
		await flushAsyncHookEffects();
		expect(listeners.has(IPC.STT_LOOPBACK_STARTED)).toBe(true);
		expect(listeners.has(IPC.STT_LOOPBACK_STOPPED)).toBe(true);
	});

	test("loopback-started event sets isListening true with the device name", async () => {
		window.nativeBridge = makeApi();
		renderHook(() => useListenMode());
		await flushAsyncHookEffects();
		act(() => {
			fire(IPC.STT_LOOPBACK_STARTED, { deviceName: "Speakers" });
		});
		const state = useListenStore.getState();
		expect(state.isListening).toBe(true);
		expect(state.deviceName).toBe("Speakers");
	});

	test("loopback-stopped event sets isListening false", async () => {
		window.nativeBridge = makeApi();
		renderHook(() => useListenMode());
		await flushAsyncHookEffects();
		useListenStore.setState({ isListening: true, deviceName: "Speakers" });
		act(() => {
			fire(IPC.STT_LOOPBACK_STOPPED);
		});
		expect(useListenStore.getState().isListening).toBe(false);
	});

	test("entering listen mode clears stale transcription feed", async () => {
		window.nativeBridge = makeApi();
		setRecordingMode("ptt");
		seedTranscription();
		renderHook(() => useListenMode());
		await flushAsyncHookEffects();

		act(() => setRecordingMode("listen"));
		await flushAsyncHookEffects();

		const state = useTranscriptionStore.getState();
		expect(state.items).toEqual([]);
		expect(state.currentRealtime).toBe("");
		expect(state.ephemeral).toBeNull();
		expect(state.isRecordingActive).toBe(false);
		expect(state.isTranscribing).toBe(false);
	});

	test("leaving listen mode clears listen transcript scrollback", async () => {
		window.nativeBridge = makeApi();
		setRecordingMode("listen");
		renderHook(() => useListenMode());
		await flushAsyncHookEffects();
		seedTranscription("listen transcript");

		act(() => setRecordingMode("ptt"));
		await flushAsyncHookEffects();

		const state = useTranscriptionStore.getState();
		expect(state.items).toEqual([]);
		expect(state.currentRealtime).toBe("");
		expect(state.ephemeral).toBeNull();
	});

	test("loopback lifecycle preserves listen captions while mode boundaries clear them", async () => {
		window.nativeBridge = makeApi();
		setRecordingMode("listen");
		renderHook(() => useListenMode());
		await flushAsyncHookEffects();
		seedTranscription("listen transcript");

		act(() => {
			fire(IPC.STT_LOOPBACK_STOPPED);
		});
		expect(useTranscriptionStore.getState().items.map((i) => i.text)).toEqual([
			"listen transcript",
		]);

		act(() => setRecordingMode("ptt"));
		await flushAsyncHookEffects();
		expect(useTranscriptionStore.getState().items).toEqual([]);
	});

	test("starts loopback with the default output device and streaming model", async () => {
		window.nativeBridge = makeApi();
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				model: {
					...initialSettings.model,
					realtimeModel: STREAMING_MODEL_ID,
				},
				general: {
					...initialSettings.general,
					onboarded: true,
					onboardedAt: 1,
					recordingMode: "listen",
					outputDeviceId: "",
				},
			},
		});
		renderHook(() => useListenMode());
		await flushAsyncHookEffects();
		expect(tauriCalls).toContainEqual({
			cmd: "start_listen",
			args: { deviceIndex: 0, modelId: STREAMING_MODEL_ID },
		});
	});

	test("starts loopback with the selected output tab device", async () => {
		window.nativeBridge = makeApi();
		useSettingsStore.setState({
			settings: {
				...initialSettings,
				model: {
					...initialSettings.model,
					realtimeModel: STREAMING_MODEL_ID,
				},
				general: {
					...initialSettings.general,
					onboarded: true,
					onboardedAt: 1,
					recordingMode: "listen",
					outputDeviceId: "headset-sink",
				},
			},
		});
		useConnectionStore.setState({ connectionStatus: "connecting" });
		renderHook(() => useListenMode());
		await flushAsyncHookEffects();
		expect(tauriCalls).toContainEqual({
			cmd: "start_listen",
			args: { deviceIndex: 3, modelId: STREAMING_MODEL_ID },
		});
	});
});
