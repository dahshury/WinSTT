import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { asInvalid } from "@test/lib/cast";
import { IPC } from "./ipc-channels";
import * as ipc from "./ipc-client";

// ── Typed-transport seam (the `@/bindings` `commands.*` migration) ──────────────
//
// Migrated COMMAND-kind channels no longer cross `window.nativeBridge.invoke/send`
// — they call the generated `commands.METHOD()` from `@/bindings`, which bottoms
// out in `@tauri-apps/api/core` `invoke(snake_case_cmd, namedArgs)`. We mock THAT
// seam so the migrated wrappers assert the Rust command NAME + the named-args
// object (the real renderer↔Rust contract) instead of an opaque string channel.
//
// `commands.*` wraps fallible commands in a specta `Result` ({status:"ok",data})
// and returns infallible ones raw, then ipc-client's `unwrapResult` collapses
// that back to the bare value/throw. So the mock just resolves the RAW data
// (commands wraps it, unwrapResult unwraps it) — the value flows through
// unchanged for BOTH Result and raw commands. A thrown impl propagates as a
// rejected command (the specta wrapper rethrows `Error`s) → `invokeOrDefault`.
const tauriCalls: Array<{
	args: Record<string, unknown> | undefined;
	cmd: string;
}> = [];
let tauriInvokeImpl: (
	cmd: string,
	args?: Record<string, unknown>,
) => unknown = () => undefined;

mock.module("@tauri-apps/api/core", () => ({
	// `bindings.ts` imports `{ invoke as TAURI_INVOKE, Channel as TAURI_CHANNEL }`.
	invoke: (cmd: string, args?: Record<string, unknown>) => {
		tauriCalls.push({ cmd, args });
		return Promise.resolve(tauriInvokeImpl(cmd, args));
	},
	// `Channel` is imported by bindings.ts but unused on the command path — a bare
	// stub keeps the import binding satisfied.
	Channel: class {},
}));

/** Reset the recorded TAURI invokes + install a resolver for the typed-command seam. */
function setTauriInvoke(
	impl?: (cmd: string, args?: Record<string, unknown>) => unknown,
) {
	tauriCalls.length = 0;
	tauriInvokeImpl = impl ?? (() => undefined);
}

/** The single recorded `commands.*` → TAURI invoke for a migrated channel. */
function lastTauriCall(): {
	args: Record<string, unknown> | undefined;
	cmd: string;
} {
	const call = tauriCalls.at(-1);
	if (!call) {
		throw new Error(
			"expected a typed command (TAURI invoke) but none was recorded",
		);
	}
	return call;
}

const originalApi = window.nativeBridge;

interface MockApi {
	getPathForFile: ReturnType<typeof mock>;
	invoke: ReturnType<typeof mock>;
	listeners: Map<string, Array<(...args: unknown[]) => void>>;
	on: ReturnType<typeof mock>;
	secureInvoke: ReturnType<typeof mock>;
	send: ReturnType<typeof mock>;
}

// MockApi implements only the NativeBridge surface ipc-client.ts actually calls.
// The single boundary cast (mock → real NativeBridge) lives here instead of being
// repeated at every injection site — the runtime object is returned unchanged.
const asNativeBridge = (m: MockApi) =>
	m as unknown as typeof window.nativeBridge;

function installMockApi(opts?: {
	invokeImpl?: (channel: string, ...args: unknown[]) => unknown;
	secureInvokeImpl?: (channel: string, payload?: unknown) => unknown;
}): MockApi {
	const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
	const api: MockApi = {
		listeners,
		send: mock(() => undefined),
		invoke: mock(async (channel: string, ...args: unknown[]) => {
			if (opts?.invokeImpl) {
				return opts.invokeImpl(channel, ...args);
			}
			return;
		}),
		secureInvoke: mock(async (channel: string, payload?: unknown) => {
			if (opts?.secureInvokeImpl) {
				return opts.secureInvokeImpl(channel, payload);
			}
			return;
		}),
		on: mock((channel: string, cb: (...args: unknown[]) => void) => {
			const list = listeners.get(channel) ?? [];
			list.push(cb);
			listeners.set(channel, list);
			return () => {
				listeners.set(
					channel,
					(listeners.get(channel) ?? []).filter((x) => x !== cb),
				);
			};
		}),
		getPathForFile: mock(() => "/mock/path"),
	};
	window.nativeBridge = asNativeBridge(api);
	return api;
}

function fire(api: MockApi, channel: string, ...args: unknown[]) {
	for (const cb of api.listeners.get(channel) ?? []) {
		cb(...args);
	}
}

beforeEach(() => {
	// reset to clean baseline before each test
	window.nativeBridge = originalApi;
	// clear the typed-command seam so a prior test's recorded TAURI invokes /
	// resolver can't leak into the next.
	setTauriInvoke();
});

afterEach(() => {
	window.nativeBridge = originalApi;
});

describe("getFilePath", () => {
	test("delegates to nativeBridge.getPathForFile when in a bridge context", () => {
		const api = installMockApi();
		const file = new File(["hi"], "x.wav", { type: "audio/wav" });
		expect(ipc.getFilePath(file)).toBe("/mock/path");
		expect(api.getPathForFile).toHaveBeenCalledTimes(1);
	});

	test("returns empty string when outside a bridge context", () => {
		const previous = window.nativeBridge;
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		try {
			expect(ipc.getFilePath(new File([], "x.wav"))).toBe("");
		} finally {
			window.nativeBridge = previous;
		}
	});
});

// Migrated send-kind wrappers now route through the typed `commands.*` →
// `@tauri-apps/api/core` invoke seam (gated on hasNativeBridge()), so we assert the
// Rust command NAME + named args, not the nativeBridge string channel.
describe("send wrappers (migrated to typed commands)", () => {
	test("hotkeyUnregister calls hotkey_unregister with the accelerator", () => {
		installMockApi();
		ipc.hotkeyUnregister("Ctrl+S");
		expect(lastTauriCall()).toEqual({
			cmd: "hotkey_unregister",
			args: { accelerator: "Ctrl+S" },
		});
	});

	test("hotkeyStopRecording calls hotkey_stop_recording with no args", () => {
		installMockApi();
		ipc.hotkeyStopRecording();
		expect(lastTauriCall().cmd).toBe("hotkey_stop_recording");
	});

	test("settingsSave calls winstt_set_settings with the settings patch", () => {
		installMockApi();
		ipc.settingsSave({} as Parameters<typeof ipc.settingsSave>[0]);
		expect(lastTauriCall()).toEqual({
			cmd: "winstt_set_settings",
			args: { settings: {} },
		});
	});

	test("settingsSave uses the Vite dev bridge outside Tauri on the dev server", async () => {
		const originalFetch = globalThis.fetch;
		const previousLocation = Object.getOwnPropertyDescriptor(
			window,
			"location",
		);
		const maybeWindow = window as Window & { __TAURI_INTERNALS__?: unknown };
		const previousInternals = maybeWindow.__TAURI_INTERNALS__;
		const bridgeFetch = mock(async () => {
			return new Response(JSON.stringify({ settings: {} }), {
				headers: { "Content-Type": "application/json" },
				status: 200,
			});
		});

		try {
			globalThis.fetch = bridgeFetch as unknown as typeof fetch;
			Object.defineProperty(window, "location", {
				configurable: true,
				value: {
					...window.location,
					href: "http://127.0.0.1:1420/",
					port: "1420",
				},
			});
			maybeWindow.__TAURI_INTERNALS__ = undefined;
			installMockApi();

			ipc.settingsSave({
				dictionary: [{ id: "term-1", term: "WinSTT" }],
			} as Parameters<typeof ipc.settingsSave>[0]);
			await Promise.resolve();

			expect(bridgeFetch).toHaveBeenCalledTimes(1);
			const [, init] = bridgeFetch.mock.calls[0] ?? [];
			expect(init?.method).toBe("PATCH");
			expect(JSON.parse(String(init?.body))).toEqual({
				settings: { dictionary: [{ id: "term-1", term: "WinSTT" }] },
			});
			expect(tauriCalls).toEqual([]);
		} finally {
			globalThis.fetch = originalFetch;
			if (previousLocation) {
				Object.defineProperty(window, "location", previousLocation);
			}
			maybeWindow.__TAURI_INTERNALS__ = previousInternals;
		}
	});

	test("settingsLoad uses the Vite dev bridge outside Tauri on the dev server", async () => {
		const originalFetch = globalThis.fetch;
		const previousLocation = Object.getOwnPropertyDescriptor(
			window,
			"location",
		);
		const maybeWindow = window as Window & { __TAURI_INTERNALS__?: unknown };
		const previousInternals = maybeWindow.__TAURI_INTERNALS__;
		const bridgeFetch = mock(async () => {
			return new Response(
				JSON.stringify({
					settings: {
						dictionary: [{ id: "term-1", term: "central" }],
					},
				}),
				{
					headers: { "Content-Type": "application/json" },
					status: 200,
				},
			);
		});

		try {
			globalThis.fetch = bridgeFetch as unknown as typeof fetch;
			Object.defineProperty(window, "location", {
				configurable: true,
				value: {
					...window.location,
					href: "http://127.0.0.1:1420/",
					port: "1420",
				},
			});
			maybeWindow.__TAURI_INTERNALS__ = undefined;
			installMockApi();

			const settings = await ipc.settingsLoad();

			expect(settings.dictionary).toEqual([{ id: "term-1", term: "central" }]);
			expect(bridgeFetch).toHaveBeenCalledWith(
				"/__winstt/settings",
				expect.objectContaining({ headers: { Accept: "application/json" } }),
			);
			expect(tauriCalls).toEqual([]);
		} finally {
			globalThis.fetch = originalFetch;
			if (previousLocation) {
				Object.defineProperty(window, "location", previousLocation);
			}
			maybeWindow.__TAURI_INTERNALS__ = previousInternals;
		}
	});

	test("loopbackStart and loopbackStop route to start_listen / stop_listen", async () => {
		installMockApi();
		await ipc.loopbackStart(3, "streaming-nemo-ctc-en-1040ms");
		ipc.loopbackStop();
		expect(tauriCalls).toEqual([
			{
				cmd: "start_listen",
				args: { deviceIndex: 3, modelId: "streaming-nemo-ctc-en-1040ms" },
			},
			{ cmd: "stop_listen", args: undefined },
		]);
	});

	test("TTS media playback pause/resume requests route through backend commands", () => {
		installMockApi();
		ipc.ttsRequestPlaybackPause();
		ipc.ttsRequestPlaybackResume();
		expect(tauriCalls).toEqual([
			{ cmd: "tts_pause_playback", args: { reason: "media-session" } },
			{ cmd: "tts_resume_playback", args: { reason: "media-session" } },
		]);
	});

	test("sttSetParameter and sttCallMethod route to winstt_set_parameter / winstt_call_method", () => {
		installMockApi();
		ipc.sttSetParameter("model", "tiny");
		ipc.sttCallMethod("abort", [1, 2]);
		expect(tauriCalls).toEqual([
			{
				cmd: "winstt_set_parameter",
				args: { parameter: "model", value: "tiny" },
			},
			{ cmd: "winstt_call_method", args: { method: "abort", args: [1, 2] } },
		]);
	});

	test("sttReloadModel forwards the optional quantization override", () => {
		installMockApi();
		ipc.sttReloadModel("main", "streaming-nemotron-en-1120ms-int8", "int8");
		expect(lastTauriCall()).toEqual({
			cmd: "set_winstt_model",
			args: {
				kind: "main",
				name: "streaming-nemotron-en-1120ms-int8",
				quantization: "int8",
			},
		});
	});

	// audit-#13 regression: a fallible `commands.*` (e.g. winstt_set_settings) wraps
	// its result in a specta `Result`. When the backend returns `Err(String)`, the
	// @tauri-apps `invoke` rejects with a plain STRING (not an `Error`), so the
	// generated wrapper does NOT rethrow — it RESOLVES `{status:"error"}`. send()
	// must `.then(unwrapResult)` so that resolved error-Result becomes a rejection
	// the CRITICAL_SEND_CHANNELS `.catch` logs, instead of being silently swallowed.
	test("settingsSave (critical send) surfaces an Err(String) backend failure via console.error", async () => {
		installMockApi();
		// Simulate the Rust `Err("disk full")` → tauri invoke rejecting with a bare
		// string → specta wrapper RESOLVES `{status:"error", error:"disk full"}`.
		setTauriInvoke(() => {
			// Deliberately a NON-Error literal: reproduces the @tauri-apps
			// string-rejection path the specta wrapper does NOT rethrow (it only
			// rethrows `instanceof Error`), so the wrapper RESOLVES {status:"error"}.
			throw "disk full";
		});
		const originalError = console.error;
		const errorCalls: unknown[][] = [];
		console.error = (...a: unknown[]) => {
			errorCalls.push(a);
		};
		try {
			ipc.settingsSave({} as Parameters<typeof ipc.settingsSave>[0]);
			// Drain the send()'s internal promise chain (.then(unwrapResult).catch).
			await Promise.resolve();
			await Promise.resolve();
		} finally {
			console.error = originalError;
		}
		expect(lastTauriCall().cmd).toBe("winstt_set_settings");
		expect(errorCalls).toHaveLength(1);
		const [msg, err] = errorCalls[0];
		expect(String(msg)).toContain("critical send");
		expect(String(msg)).toContain(IPC.SETTINGS_SAVE);
		expect(err).toBe("disk full");
	});
});

// Non-migrated send-kind wrappers stay on the nativeBridge string-channel adapter
// path (plugin / window-family routes — deliberately excluded from the map).
describe("send wrappers (still on the adapter)", () => {
	test("autostartSet sends enabled flag (plugin route — not migrated)", () => {
		const api = installMockApi();
		ipc.autostartSet(true);
		expect(api.send).toHaveBeenCalledWith(IPC.AUTOSTART_SET, { enabled: true });
		expect(tauriCalls).toHaveLength(0);
	});

	test("window controls send their channels (window-op family — not migrated)", () => {
		const api = installMockApi();
		ipc.windowMinimize();
		ipc.windowMaximize();
		ipc.windowClose();
		const channels = (
			api.send as unknown as { mock: { calls: unknown[][] } }
		).mock.calls.map((c) => c[0]);
		expect(channels).toEqual([
			IPC.WINDOW_MINIMIZE,
			IPC.WINDOW_MAXIMIZE,
			IPC.WINDOW_CLOSE,
		]);
		// minimize/maximize/close are window-op routes (no backend command).
		expect(tauriCalls).toHaveLength(0);
	});

	test("windowOpenSettings routes through the typed open_window command", () => {
		const api = installMockApi();
		ipc.windowOpenSettings();
		// WINDOW_OPEN_SETTINGS is typed in COMMAND_INVOKERS → `open_window("settings")`;
		// the adapter string-channel send is bypassed.
		expect(api.send).not.toHaveBeenCalled();
		expect(lastTauriCall()).toEqual({
			cmd: "open_window",
			args: {
				name: "settings",
				x: null,
				y: null,
				width: null,
				height: null,
				pickerKind: null,
				pickerFeature: null,
				pickerTarget: null,
			},
		});
	});

	test("settingsWindowReady / windowCloseSelf route through typed commands", () => {
		const api = installMockApi();
		ipc.settingsWindowReady();
		ipc.windowCloseSelf();
		// Typed (COMMAND_INVOKERS) — the adapter string-channel send is bypassed.
		expect(api.send).not.toHaveBeenCalled();
		expect(tauriCalls.map((c) => c.cmd)).toEqual([
			"settings_window_ready",
			"close_self_window",
		]);
	});
});

// Wrappers RETIRED off the string-channel layer entirely: they call the generated
// `commands.*` directly (no IPC channel / ROUTE / COMMAND_INVOKERS entry), with a
// fallback preserved via `commandOrDefault` for the non-bridge / throw path.
describe("wrappers migrated to direct commands.* (no channel)", () => {
	test("aboutGetAppInfo calls about_get_app_info and returns the info", async () => {
		installMockApi();
		setTauriInvoke(() => ({ version: "1.2.3", copyright: "© WinSTT" }));
		const info = await ipc.aboutGetAppInfo();
		expect(lastTauriCall().cmd).toBe("about_get_app_info");
		expect(info).toEqual({ version: "1.2.3", copyright: "© WinSTT" });
	});

	test("aboutGetAppInfo falls back to empty info when the command throws", async () => {
		installMockApi();
		setTauriInvoke(() => {
			throw new Error("boom");
		});
		expect(await ipc.aboutGetAppInfo()).toEqual({ version: "", copyright: "" });
	});

	test("diagSaveBundle calls diag_save_bundle", async () => {
		installMockApi();
		setTauriInvoke(() => ({ ok: true, path: "C:\\bundle.zip" }));
		const result = await ipc.diagSaveBundle();
		expect(lastTauriCall().cmd).toBe("diag_save_bundle");
		expect(result.ok).toBe(true);
	});

	test("copyLastTranscript calls copy_last_transcript and returns the bool", async () => {
		installMockApi();
		setTauriInvoke(() => true);
		expect(await ipc.copyLastTranscript()).toBe(true);
		expect(lastTauriCall().cmd).toBe("copy_last_transcript");
	});

	test("copyLastTranscript falls back to false when the command throws", async () => {
		installMockApi();
		setTauriInvoke(() => {
			throw new Error("no db");
		});
		expect(await ipc.copyLastTranscript()).toBe(false);
	});

	test("webviewDiagLog forwards label/level/message to winstt_diag", () => {
		installMockApi();
		setTauriInvoke(() => undefined);
		ipc.webviewDiagLog("main", "warn", "hello");
		expect(lastTauriCall()).toEqual({
			cmd: "winstt_diag",
			args: { label: "main", level: "warn", message: "hello" },
		});
	});

	test("windowOpenContextPlayground opens the normal context debug window", async () => {
		installMockApi();
		setTauriInvoke(() => null);
		await ipc.windowOpenContextPlayground();
		expect(lastTauriCall()).toEqual({
			cmd: "open_window",
			args: {
				name: "context-playground",
				x: null,
				y: null,
				width: null,
				height: null,
				pickerKind: null,
				pickerFeature: null,
				pickerTarget: null,
			},
		});
	});

	test("wakewordModelStatus calls wakeword_model_status and returns the payload", async () => {
		installMockApi();
		setTauriInvoke(() => ({ available: true, downloading: false }));
		const status = await ipc.wakewordModelStatus();
		expect(lastTauriCall().cmd).toBe("wakeword_model_status");
		expect(status.available).toBe(true);
	});

	test("wakewordStartModelDownload calls wakeword_start_model_download", async () => {
		installMockApi();
		setTauriInvoke(() => ({ available: false, downloading: true }));
		await ipc.wakewordStartModelDownload();
		expect(lastTauriCall().cmd).toBe("wakeword_start_model_download");
	});

	test("wakewordModelStatus falls back to the default status when it throws", async () => {
		installMockApi();
		setTauriInvoke(() => {
			throw new Error("offline");
		});
		const status = await ipc.wakewordModelStatus();
		expect(status).toEqual({ available: false, downloading: false });
	});

	test("ttsOpenRouterPreview calls tts_preview_openrouter directly", async () => {
		const api = installMockApi();
		setTauriInvoke(() => ({ requestId: "tts-preview-1" }));

		await expect(
			ipc.ttsOpenRouterPreview({
				model: "openai/gpt-4o-mini-tts",
				voice: "alloy",
			}),
		).resolves.toEqual({ requestId: "tts-preview-1" });

		expect(lastTauriCall()).toEqual({
			cmd: "tts_preview_openrouter",
			args: {
				model: "openai/gpt-4o-mini-tts",
				voice: "alloy",
				speed: null,
			},
		});
		expect(api.invoke).not.toHaveBeenCalled();
	});

	test("retryLlmWarmup calls llm_retry_warmup and returns the latest snapshot", async () => {
		installMockApi();
		const snapshot = {
			endpoint: "http://localhost:11434",
			inProgress: false,
			models: [{ model: "gemma3:4b", outcome: "ok" }],
			ollamaInstalled: true,
			reachable: true,
			timestamp: 1_700_000_000_000,
		};
		setTauriInvoke(() => snapshot);

		await expect(ipc.retryLlmWarmup()).resolves.toEqual(snapshot);
		expect(lastTauriCall()).toEqual({
			cmd: "llm_retry_warmup",
			args: undefined,
		});
	});
});

// The contextBridge clone guard (`toCloneableArgs`) only runs on the nativeBridge
// adapter path — i.e. for channels NOT in COMMAND_INVOKERS. The original tests used
// `settings:save` / `history:get-all`, which are now migrated (shadowed by the typed
// map), so they'd never reach the clone guard. We exercise it through NON-migrated
// channels (`autostart:set` send / `autostart:get` invoke) instead — same guard,
// real adapter path.
describe("diagnostics wrappers", () => {
	test("diagOpenLogsFolder routes through the logs opener channel", async () => {
		const api = installMockApi({
			invokeImpl: (channel) =>
				channel === IPC.DIAG_OPEN_LOGS_FOLDER
					? { ok: true, path: "C:\\logs" }
					: undefined,
		});

		const result = await ipc.diagOpenLogsFolder();

		expect(api.invoke).toHaveBeenCalledWith(IPC.DIAG_OPEN_LOGS_FOLDER);
		expect(result).toEqual({ ok: true, path: "C:\\logs" });
	});
});

describe("toCloneableArgs (contextBridge clone guard)", () => {
	test("passes plain payloads through unchanged (structuredClone fast path)", () => {
		const api = installMockApi();
		ipc.ipcSend(IPC.AUTOSTART_SET, {
			settings: { a: 1, nested: { b: [2, 3] } },
		});
		expect(api.send).toHaveBeenCalledWith(IPC.AUTOSTART_SET, {
			settings: { a: 1, nested: { b: [2, 3] } },
		});
	});

	test("strips a non-cloneable function from a send payload instead of throwing", () => {
		const api = installMockApi();
		const poisoned = { settings: { ok: 1, fn: () => "boom" } };
		expect(() => ipc.ipcSend(IPC.AUTOSTART_SET, poisoned)).not.toThrow();
		expect(api.send).toHaveBeenCalledWith(IPC.AUTOSTART_SET, {
			settings: { ok: 1 },
		});
	});

	test("sanitizes a non-cloneable invoke argument and still resolves", async () => {
		const api = installMockApi({ invokeImpl: (_c, arg) => arg });
		const result = await ipc.ipcInvoke(IPC.AUTOSTART_GET, {
			id: "x",
			fn: () => 0,
		});
		expect(result).toEqual({ id: "x" });
		expect(api.invoke).toHaveBeenCalledWith(IPC.AUTOSTART_GET, { id: "x" });
	});

	test("drops to no args when the payload is circular (does not crash the renderer)", () => {
		const api = installMockApi();
		const circular: Record<string, unknown> = { fn: () => 0 };
		circular.self = circular;
		expect(() => ipc.ipcSend(IPC.AUTOSTART_SET, circular)).not.toThrow();
		expect(api.send).toHaveBeenCalledWith(IPC.AUTOSTART_SET);
	});
});

describe("invokeOrDefault wrappers", () => {
	test("returns the resolved value when invoke succeeds", async () => {
		installMockApi({
			invokeImpl: (channel) =>
				channel === IPC.AUTOSTART_GET ? true : undefined,
		});
		expect(await ipc.autostartGet()).toBe(true);
	});

	test("returns the fallback when invoke resolves undefined", async () => {
		installMockApi();
		expect(await ipc.autostartGet()).toBe(false);
	});

	test("returns the fallback when invoke throws", async () => {
		installMockApi({
			invokeImpl: () => {
				throw new Error("bad");
			},
		});
		expect(await ipc.autostartGet()).toBe(false);
	});

	test("hotkeyRegister calls hotkey_register and returns the result (migrated)", async () => {
		// `commands.hotkeyRegister` is a RAW (non-Result) command → the mock resolves
		// the bool directly.
		installMockApi();
		setTauriInvoke(() => true);
		expect(await ipc.hotkeyRegister("Ctrl+S")).toBe(true);
		expect(lastTauriCall()).toEqual({
			cmd: "hotkey_register",
			args: { accelerator: "Ctrl+S" },
		});
	});

	test("settingsLoad decodes the winstt_get_settings payload (migrated)", async () => {
		installMockApi();
		setTauriInvoke(() => ({ general: { recordingMode: "toggle" } }));
		const settings = await ipc.settingsLoad();
		expect(lastTauriCall().cmd).toBe("winstt_get_settings");
		expect(settings.general.recordingMode).toBe("toggle");
		// Other fields filled with defaults
		expect(settings.general.minimizeToTray).toBe(true);
	});

	test("removeApplicationData routes through remove_application_data", async () => {
		installMockApi();
		setTauriInvoke(() => ({
			deletePortableAppDir: true,
			deletedOllamaModels: ["gemma3:4b"],
			ollamaErrors: [],
			portable: true,
			scheduled: true,
		}));
		const result = await ipc.removeApplicationData(true);
		expect(lastTauriCall()).toEqual({
			cmd: "remove_application_data",
			args: { deleteOllamaModels: true },
		});
		expect(result.scheduled).toBe(true);
		expect(result.deletedOllamaModels).toEqual(["gemma3:4b"]);
	});

	test("removeDownloadedModels routes through remove_downloaded_models", async () => {
		installMockApi();
		setTauriInvoke(() => ({
			deletedModelCaches: 4,
			disabledFeatures: ["sttModel", "textToSpeech"],
			deletedOllamaModels: ["gemma3:4b"],
			ollamaErrors: [],
			errors: [],
		}));
		const result = await ipc.removeDownloadedModels(true);
		expect(lastTauriCall()).toEqual({
			cmd: "remove_downloaded_models",
			args: { deleteOllamaModels: true },
		});
		expect(result.deletedModelCaches).toBe(4);
		expect(result.disabledFeatures).toContain("sttModel");
	});

	test("deleteModelCache routes the legacy string id through delete_model_cache", async () => {
		const api = installMockApi();
		setTauriInvoke(() => null);

		await ipc.deleteModelCache("Systran/faster-whisper-large-v3");

		expect(lastTauriCall()).toEqual({
			cmd: "delete_model_cache",
			args: { modelId: "Systran/faster-whisper-large-v3" },
		});
		expect(api.invoke).not.toHaveBeenCalled();
	});

	test("deleteModelCache rejects Err(String) results instead of falling back", async () => {
		installMockApi();
		setTauriInvoke(() => {
			throw "cache busy";
		});
		const originalError = console.error;
		console.error = mock(() => undefined) as typeof console.error;
		try {
			await expect(
				ipc.deleteModelCache("Systran/faster-whisper-large-v3"),
			).rejects.toBe("cache busy");
		} finally {
			console.error = originalError;
		}
	});

	test("legacy string history wrappers route through typed commands", async () => {
		const api = installMockApi();
		const audio = "data:audio/wav;base64,AA==";
		const timings = [{ start: 0, end: 0.4, text: "hello" }];
		setTauriInvoke((cmd) => {
			if (cmd === "history_delete") {
				return { deleted: true };
			}
			if (cmd === "history_load_audio") {
				return audio;
			}
			if (cmd === "align_words") {
				return timings;
			}
			return undefined;
		});

		await expect(
			ipc.deleteTranscriptionHistoryEntry("entry-1"),
		).resolves.toEqual({
			deleted: true,
		});
		await expect(ipc.loadTranscriptionHistoryAudio("entry-2")).resolves.toBe(
			audio,
		);
		await expect(ipc.alignTranscriptionHistoryAudio("entry-3")).resolves.toBe(
			timings,
		);

		expect(tauriCalls).toEqual([
			{ cmd: "history_delete", args: { id: "entry-1" } },
			{ cmd: "history_load_audio", args: { id: "entry-2" } },
			{ cmd: "align_words", args: { entryId: "entry-3" } },
		]);
		expect(api.invoke).not.toHaveBeenCalled();
	});

	test("processWithLlm routes through process_text with an empty context", async () => {
		const api = installMockApi();
		setTauriInvoke(() => "processed!");
		expect(await ipc.processWithLlm("raw")).toBe("processed!");
		expect(lastTauriCall()).toEqual({
			cmd: "process_text",
			args: { text: "raw", context: "" },
		});
		expect(api.invoke).not.toHaveBeenCalled();
	});

	test("processWithLlm falls back to original text when invoke returns undefined", async () => {
		installMockApi();
		expect(await ipc.processWithLlm("raw")).toBe("raw");
	});

	test("dialogOpenFile passes filters and title", async () => {
		const api = installMockApi({
			invokeImpl: () => "C:\\foo.wav",
		});
		expect(
			await ipc.dialogOpenFile(
				[{ name: "Audio", extensions: ["wav"] }],
				"Pick",
			),
		).toBe("C:\\foo.wav");
		expect(api.invoke).toHaveBeenCalledWith(IPC.DIALOG_OPEN_FILE, {
			filters: [{ name: "Audio", extensions: ["wav"] }],
			title: "Pick",
		});
	});

	test("fetchOllamaModels returns scan result (migrated → ollama_refresh_models)", async () => {
		const fixture = { models: [{ name: "m" }], reachable: true };
		installMockApi();
		// `commands.ollamaRefreshModels` is a Result command; the mock resolves the RAW
		// data (commands wraps it {status:"ok",data}, unwrapResult unwraps it).
		setTauriInvoke(() => fixture);
		expect(await ipc.fetchOllamaModels()).toBe(fixture);
		expect(lastTauriCall().cmd).toBe("ollama_refresh_models");
	});

	test("fetchOllamaModels falls back to disconnected scan when the command rejects", async () => {
		installMockApi();
		setTauriInvoke(() => {
			throw new Error("nope");
		});
		const out = await ipc.fetchOllamaModels();
		expect(out.reachable).toBe(false);
		expect(out.models).toEqual([]);
	});

	test("detectOllama returns fallback when invoke unset", async () => {
		installMockApi();
		expect(await ipc.detectOllama()).toEqual({ installed: false });
	});

	test("startOllama returns fallback on no-bridge-path", async () => {
		installMockApi();
		const out = await ipc.startOllama();
		expect(out.started).toBe(false);
		expect(typeof out.error).toBe("string");
	});

	test("fetchOpenRouterModels returns fallback when invoke fails", async () => {
		installMockApi({
			invokeImpl: () => {
				throw new Error("offline");
			},
		});
		const out = await ipc.fetchOpenRouterModels();
		expect(out.reachable).toBe(false);
		expect(out.models).toEqual([]);
	});

	test("runLlmPreview rejects backend failures instead of returning the input", async () => {
		installMockApi();
		setTauriInvoke(() => {
			throw new Error("ollama HTTP 400");
		});

		await expect(
			ipc.runLlmPreview("unchanged sample", "dictation", {
				customModifiers: [],
				maxOutputTokens: null,
				model: "gemma3:4b",
				openrouterFallbackModel: "",
				openrouterModel: "",
				presets: [{ key: "neutral" }],
				provider: "ollama",
				reasoningEffort: "medium",
				thinkingEffort: "medium",
				verbosity: "medium",
			}),
		).rejects.toThrow("ollama HTTP 400");
		expect(lastTauriCall()).toEqual({
			cmd: "apply_transform_preview",
			args: {
				config: {
					customModifiers: [],
					maxOutputTokens: null,
					model: "gemma3:4b",
					openrouterFallbackModel: "",
					openrouterModel: "",
					presets: [{ key: "neutral" }],
					provider: "ollama",
					reasoningEffort: "medium",
					thinkingEffort: "medium",
					verbosity: "medium",
				},
				feature: "dictation",
				text: "unchanged sample",
			},
		});
	});

	test("cancelDownload resolves to undefined fallback", async () => {
		installMockApi();
		expect(await ipc.cancelDownload()).toBeUndefined();
	});
});

describe("invokeSecureOrDefault wrappers", () => {
	test("clipboardReadText returns the text from a readText response", async () => {
		const api = installMockApi({
			secureInvokeImpl: () => ({ operation: "readText", text: "hi" }),
		});
		expect(await ipc.clipboardReadText()).toBe("hi");
		expect(api.secureInvoke).toHaveBeenCalledWith(IPC.CLIPBOARD_OPERATE, {
			operation: "readText",
		});
	});

	test("clipboardReadText returns empty string if response is wrong shape", async () => {
		installMockApi({
			secureInvokeImpl: () => ({ operation: "writeText" }),
		});
		expect(await ipc.clipboardReadText()).toBe("");
	});

	test("clipboardReadText returns empty string when secureInvoke throws", async () => {
		installMockApi({
			secureInvokeImpl: () => {
				throw new Error("denied");
			},
		});
		expect(await ipc.clipboardReadText()).toBe("");
	});

	test("clipboardWriteText forwards the text payload", async () => {
		const api = installMockApi({
			secureInvokeImpl: () => ({ operation: "writeText" }),
		});
		await ipc.clipboardWriteText("hello");
		expect(api.secureInvoke).toHaveBeenCalledWith(IPC.CLIPBOARD_OPERATE, {
			operation: "writeText",
			text: "hello",
		});
	});

	test("clipboardClear sends a clear operation", async () => {
		const api = installMockApi({
			secureInvokeImpl: () => ({ operation: "clear" }),
		});
		await ipc.clipboardClear();
		expect(api.secureInvoke).toHaveBeenCalledWith(IPC.CLIPBOARD_OPERATE, {
			operation: "clear",
		});
	});

	test("updaterGetStatusHistory returns the array on success", async () => {
		const fixture = [{ status: "checking" as const, timestamp: 1 }];
		installMockApi({ secureInvokeImpl: () => fixture });
		expect(await ipc.updaterGetStatusHistory()).toBe(fixture);
	});

	test("updaterGetStatusHistory returns [] when secureInvoke fails", async () => {
		installMockApi({
			secureInvokeImpl: () => {
				throw new Error("blocked");
			},
		});
		expect(await ipc.updaterGetStatusHistory()).toEqual([]);
	});

	test("updaterClearStatusHistory returns ok on success", async () => {
		installMockApi({ secureInvokeImpl: () => ({ cleared: true }) });
		expect(await ipc.updaterClearStatusHistory()).toEqual({ cleared: true });
	});
});

describe("typed event subscriptions", () => {
	test("onRealtimeText extracts text and finality from realtime payload", () => {
		const api = installMockApi();
		const cb = mock(() => undefined);
		ipc.onRealtimeText(cb);
		fire(api, IPC.STT_REALTIME_TEXT, { text: "hi", is_final: true });
		expect(cb).toHaveBeenCalledWith({ text: "hi", isFinal: true });
	});

	test("onRealtimeText defaults old payloads to interim", () => {
		const api = installMockApi();
		const cb = mock(() => undefined);
		ipc.onRealtimeText(cb);
		fire(api, IPC.STT_REALTIME_TEXT, { text: "hi" });
		expect(cb).toHaveBeenCalledWith({ text: "hi", isFinal: false });
	});

	test("onFullSentence extracts text", () => {
		const api = installMockApi();
		const cb = mock(() => undefined);
		ipc.onFullSentence(cb);
		fire(api, IPC.STT_FULL_SENTENCE, { text: "ok" });
		expect(cb).toHaveBeenCalledWith("ok");
	});

	test("simple event subscriptions pass arguments through unchanged", () => {
		const api = installMockApi();
		const noAudio = mock(() => undefined);
		const recStart = mock(() => undefined);
		const recStop = mock(() => undefined);
		ipc.onNoAudioDetected(noAudio);
		ipc.onRecordingStart(recStart);
		ipc.onRecordingStop(recStop);
		fire(api, IPC.STT_NO_AUDIO_DETECTED);
		fire(api, IPC.STT_RECORDING_START);
		fire(api, IPC.STT_RECORDING_STOP);
		expect(noAudio).toHaveBeenCalled();
		expect(recStart).toHaveBeenCalled();
		expect(recStop).toHaveBeenCalled();
	});

	test("onTranscriptionStart extracts audioBase64", () => {
		const api = installMockApi();
		const cb = mock(() => undefined);
		ipc.onTranscriptionStart(cb);
		fire(api, IPC.STT_TRANSCRIPTION_START, { audioBase64: "abc" });
		expect(cb).toHaveBeenCalledWith("abc");
	});

	test("onConnectionChange extracts boolean", () => {
		const api = installMockApi();
		const cb = mock(() => undefined);
		ipc.onConnectionChange(cb);
		fire(api, IPC.STT_CONNECTION_CHANGE, { connected: true });
		expect(cb).toHaveBeenCalledWith(true);
	});

	test("onServerStatus extracts status", () => {
		const api = installMockApi();
		const cb = mock(() => undefined);
		ipc.onServerStatus(cb);
		fire(api, IPC.STT_SERVER_STATUS, { status: "ready" });
		expect(cb).toHaveBeenCalledWith("ready");
	});

	test("onHotkeyRecordingUpdate / onHotkeyRecordingDone extract their fields", () => {
		const api = installMockApi();
		const upd = mock(() => undefined);
		const done = mock(() => undefined);
		ipc.onHotkeyRecordingUpdate(upd);
		ipc.onHotkeyRecordingDone(done);
		fire(api, IPC.HOTKEY_RECORDING_UPDATE, { keys: ["LCtrl", "A"] });
		fire(api, IPC.HOTKEY_RECORDING_DONE, { combo: "LCtrl+A" });
		expect(upd).toHaveBeenCalledWith(["LCtrl", "A"]);
		expect(done).toHaveBeenCalledWith("LCtrl+A");
	});

	test("onSettingsChanged and onSettingsSaveError extract their fields", () => {
		const api = installMockApi();
		const changed = mock(() => undefined);
		const errCb = mock(() => undefined);
		ipc.onSettingsChanged(changed);
		ipc.onSettingsSaveError(errCb);
		fire(api, IPC.SETTINGS_CHANGED, { settings: { foo: 1 } });
		fire(api, IPC.SETTINGS_SAVE_ERROR, { error: "boom" });
		expect(changed).toHaveBeenCalledWith({ foo: 1 });
		expect(errCb).toHaveBeenCalledWith("boom");
	});

	test("onAudioLevel extracts level number", () => {
		const api = installMockApi();
		const cb = mock(() => undefined);
		ipc.onAudioLevel(cb);
		fire(api, IPC.STT_AUDIO_LEVEL, { level: 0.5 });
		expect(cb).toHaveBeenCalledWith(0.5);
	});

	test("onModelDownloadStart extracts (model, quantization) — quantization undefined for legacy events", () => {
		const api = installMockApi();
		const cb = mock(() => undefined);
		ipc.onModelDownloadStart(cb);
		fire(api, IPC.STT_MODEL_DOWNLOAD_START, { model: "tiny" });
		expect(cb).toHaveBeenCalledWith("tiny", undefined);
		fire(api, IPC.STT_MODEL_DOWNLOAD_START, {
			model: "tiny",
			quantization: "q4",
		});
		expect(cb).toHaveBeenCalledWith("tiny", "q4");
	});

	test("onModelDownloadProgress passes the full payload", () => {
		const api = installMockApi();
		const cb = mock(() => undefined);
		ipc.onModelDownloadProgress(cb);
		fire(api, IPC.STT_MODEL_DOWNLOAD_PROGRESS, {
			model: "tiny",
			progress: 0.5,
		});
		expect(cb).toHaveBeenCalledWith({ model: "tiny", progress: 0.5 });
	});

	test("onModelDownloadComplete passes (model, cancelled, quantization) — defaulting cancelled to false", () => {
		const api = installMockApi();
		const cb = mock(() => undefined);
		ipc.onModelDownloadComplete(cb);
		fire(api, IPC.STT_MODEL_DOWNLOAD_COMPLETE, { model: "tiny" });
		expect(cb).toHaveBeenCalledWith("tiny", false, undefined);
		fire(api, IPC.STT_MODEL_DOWNLOAD_COMPLETE, {
			model: "base",
			cancelled: true,
			quantization: "q4",
		});
		expect(cb).toHaveBeenCalledWith("base", true, "q4");
	});

	test("onModelCatalog (event) and fetchModelCatalog (migrated → list_models) handle models list", async () => {
		const api = installMockApi();
		const cb = mock(() => undefined);
		// onModelCatalog stays on the event/adapter path (nativeBridge.on).
		ipc.onModelCatalog(cb);
		fire(api, IPC.STT_MODEL_CATALOG, { models: [1, 2] });
		expect(cb).toHaveBeenCalledWith([1, 2]);
		// fetchModelCatalog is migrated → typed command (raw array, no Result wrap).
		setTauriInvoke(() => [{ name: "tiny" }]);
		expect(await ipc.fetchModelCatalog()).toEqual([{ name: "tiny" }]);
		expect(lastTauriCall().cmd).toBe("stt_list_models");
	});

	test("loopback events extract their fields", () => {
		const api = installMockApi();
		const started = mock(() => undefined);
		const stopped = mock(() => undefined);
		ipc.onLoopbackStarted(started);
		ipc.onLoopbackStopped(stopped);
		fire(api, IPC.STT_LOOPBACK_STARTED, { deviceName: "Speakers" });
		fire(api, IPC.STT_LOOPBACK_STOPPED);
		expect(started).toHaveBeenCalledWith("Speakers");
		expect(stopped).toHaveBeenCalled();
	});

	test("file-transcription events pass payload through unchanged", () => {
		const api = installMockApi();
		const onProgress = mock(() => undefined);
		const onComplete = mock(() => undefined);
		const onError = mock(() => undefined);
		ipc.onFileTranscriptionProgress(onProgress);
		ipc.onFileTranscriptionComplete(onComplete);
		ipc.onFileTranscriptionError(onError);
		fire(api, IPC.FILE_TRANSCRIPTION_PROGRESS, {
			fileName: "a",
			progress: 0.1,
			message: "x",
		});
		fire(api, IPC.FILE_TRANSCRIPTION_COMPLETE, {
			requestId: "r",
			fileName: "a",
			text: "t",
			outputPath: "/p",
		});
		fire(api, IPC.FILE_TRANSCRIPTION_ERROR, {
			requestId: "r",
			fileName: "a",
			error: "e",
		});
		expect(onProgress).toHaveBeenCalledWith({
			fileName: "a",
			progress: 0.1,
			message: "x",
		});
		expect(onComplete).toHaveBeenCalledWith({
			requestId: "r",
			fileName: "a",
			text: "t",
			outputPath: "/p",
		});
		expect(onError).toHaveBeenCalledWith({
			requestId: "r",
			fileName: "a",
			error: "e",
		});
	});

	test("onModelCacheChanged forwards modelId when payload.modelId is a string", () => {
		const api = installMockApi();
		const cb = mock(() => undefined);
		ipc.onModelCacheChanged(cb);
		fire(api, IPC.STT_MODEL_CACHE_CHANGED, { modelId: "tiny" });
		expect(cb).toHaveBeenCalledWith("tiny");
	});

	test("onModelCacheChanged ignores payload when modelId is missing or non-string", () => {
		const api = installMockApi();
		const cb = mock(() => undefined);
		ipc.onModelCacheChanged(cb);
		fire(api, IPC.STT_MODEL_CACHE_CHANGED, {});
		fire(api, IPC.STT_MODEL_CACHE_CHANGED, { modelId: 42 });
		fire(api, IPC.STT_MODEL_CACHE_CHANGED, { modelId: null });
		expect(cb).not.toHaveBeenCalled();
	});

	test("onUpdaterStatus passes payload through", () => {
		const api = installMockApi();
		const updater = mock(() => undefined);
		ipc.onUpdaterStatus(updater);
		fire(api, IPC.UPDATER_STATUS, { status: "downloaded", timestamp: 1 });
		expect(updater).toHaveBeenCalled();
	});

	test("onLlmCatalog returns no-op when outside a bridge context", () => {
		const previous = window.nativeBridge;
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		try {
			const cb = mock(() => undefined);
			const unsub = ipc.onLlmCatalog(cb);
			unsub();
			expect(cb).not.toHaveBeenCalled();
		} finally {
			window.nativeBridge = previous;
		}
	});

	test("onLlmCatalog subscribes when in a bridge context and extracts models array", () => {
		const api = installMockApi();
		const cb = mock(() => undefined);
		const unsub = ipc.onLlmCatalog(cb);
		fire(api, IPC.LLM_CATALOG, { models: [{ name: "a" }] });
		expect(cb).toHaveBeenCalledWith([{ name: "a" }]);
		unsub();
		fire(api, IPC.LLM_CATALOG, { models: [{ name: "b" }] });
		// after unsub, no further calls
		expect(
			(cb as unknown as { mock: { calls: unknown[][] } }).mock.calls.length,
		).toBe(1);
	});

	test("ipcOn returns a no-op unsubscribe when outside a bridge context", () => {
		const previous = window.nativeBridge;
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		try {
			const unsub = ipc.ipcOn("foo", () => undefined);
			expect(typeof unsub).toBe("function");
			unsub(); // should not throw
		} finally {
			window.nativeBridge = previous;
		}
	});

	test("ipcSend is a no-op when outside a bridge context", () => {
		const previous = window.nativeBridge;
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		try {
			expect(() => ipc.ipcSend("foo", 1, 2)).not.toThrow();
		} finally {
			window.nativeBridge = previous;
		}
	});

	test("ipcInvoke resolves to undefined when outside a bridge context", async () => {
		const previous = window.nativeBridge;
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		try {
			expect(await ipc.ipcInvoke("foo")).toBeUndefined();
		} finally {
			window.nativeBridge = previous;
		}
	});

	test("clipboardReadText returns empty string when outside a bridge context (secureInvoke fallback)", async () => {
		const previous = window.nativeBridge;
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		try {
			expect(await ipc.clipboardReadText()).toBe("");
		} finally {
			window.nativeBridge = previous;
		}
	});

	test("ipcSend on undefined nativeBridge is a no-op and does not throw (kills L30 hasNativeBridge `true` mutant — would call .send on undefined)", () => {
		const previous = window.nativeBridge;
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		try {
			expect(() => ipc.ipcSend("settings:save")).not.toThrow();
		} finally {
			window.nativeBridge = previous;
		}
	});

	test("ipcInvoke on undefined nativeBridge does not throw (kills L30 mutant where hasNativeBridge => true would call .invoke on undefined)", async () => {
		const previous = window.nativeBridge;
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		try {
			await expect(ipc.ipcInvoke("settings:load")).resolves.toBeUndefined();
		} finally {
			window.nativeBridge = previous;
		}
	});
});

describe("invokeOrDefault wrappers (mutation guard against `() => undefined` arrow body mutants)", () => {
	test("sttGetParameter calls winstt_get_parameter and returns result when in a bridge context", async () => {
		installMockApi();
		setTauriInvoke((_cmd, args) => {
			expect((args as { parameter: string }).parameter).toBe("model");
			return "tiny";
		});
		const result = await ipc.sttGetParameter("model");
		expect(result).toBe("tiny");
		expect(lastTauriCall()).toEqual({
			cmd: "winstt_get_parameter",
			args: { parameter: "model" },
		});
	});

	test("sttGetParameter falls back to null when outside a bridge context", async () => {
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		const result = await ipc.sttGetParameter("model");
		expect(result).toBeNull();
	});

	test("hotkeyStartRecording calls hotkey_start_recording and returns result", async () => {
		installMockApi();
		setTauriInvoke(() => true);
		expect(await ipc.hotkeyStartRecording()).toBe(true);
		expect(lastTauriCall().cmd).toBe("hotkey_start_recording");
	});

	test("hotkeyStartRecording falls back to false when outside a bridge context", async () => {
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		expect(await ipc.hotkeyStartRecording()).toBe(false);
	});

	test("autostartGet falls back to false when outside a bridge context", async () => {
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		expect(await ipc.autostartGet()).toBe(false);
	});

	test("audioGetDevices returns the get_audio_devices result when in a bridge context", async () => {
		const devices = [{ index: 0, name: "Mic", isDefault: true }];
		installMockApi();
		// `commands.getAudioDevices` is a Result command; mock resolves the raw array.
		setTauriInvoke(() => devices);
		const out = await ipc.audioGetDevices();
		expect(out).toEqual(
			devices as unknown as Awaited<ReturnType<typeof ipc.audioGetDevices>>,
		);
		expect(lastTauriCall().cmd).toBe("get_audio_devices");
	});

	test("audioGetDevices falls back to [] when outside a bridge context", async () => {
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		expect(await ipc.audioGetDevices()).toEqual([]);
	});

	test("gpuGetInfo returns the gpu_get_info result when in a bridge context", async () => {
		const info = [{ name: "RTX 4090", available: true }];
		installMockApi();
		// `commands.gpuGetInfo` is a RAW command (returns the array directly).
		setTauriInvoke(() => info);
		expect(await ipc.gpuGetInfo()).toEqual(info);
		expect(lastTauriCall().cmd).toBe("gpu_get_info");
	});

	test("gpuGetInfo falls back to [] when outside a bridge context", async () => {
		// NB: gpuGetInfo's declared fallback is `[]` (GpuInfo[]), not null — the prior
		// `toBeNull()` assertion was stale (it never matched the wrapper's `[]` default).
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		expect(await ipc.gpuGetInfo()).toEqual([]);
	});

	test("sttIsConnected falls back to false when outside a bridge context", async () => {
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		expect(await ipc.sttIsConnected()).toBe(false);
	});

	test("settingsSave forwards the full settings object to winstt_set_settings", () => {
		installMockApi();
		const settings = { model: { model: "tiny" } } as Parameters<
			typeof ipc.settingsSave
		>[0];
		ipc.settingsSave(settings);
		expect(lastTauriCall()).toEqual({
			cmd: "winstt_set_settings",
			args: { settings },
		});
	});

	test("autostartSet forwards enabled flag", () => {
		const api = installMockApi();
		ipc.autostartSet(true);
		expect(api.send).toHaveBeenCalledWith(IPC.AUTOSTART_SET, { enabled: true });
	});

	test("hotkeyStopRecording routes to hotkey_stop_recording with no args", () => {
		installMockApi();
		ipc.hotkeyStopRecording();
		expect(lastTauriCall().cmd).toBe("hotkey_stop_recording");
	});

	test("window controls send corresponding IPC channels with no payload", () => {
		const api = installMockApi();
		ipc.windowMinimize();
		ipc.windowMaximize();
		ipc.windowClose();
		expect(api.send).toHaveBeenCalledWith(IPC.WINDOW_MINIMIZE);
		expect(api.send).toHaveBeenCalledWith(IPC.WINDOW_MAXIMIZE);
		expect(api.send).toHaveBeenCalledWith(IPC.WINDOW_CLOSE);
		// windowOpenSettings is a typed open_window command — covered separately.
	});

	test("loopbackStart forwards device index to start_listen", async () => {
		installMockApi();
		await ipc.loopbackStart(7, "streaming-nemo-rnnt-en-1040ms");
		expect(lastTauriCall()).toEqual({
			cmd: "start_listen",
			args: { deviceIndex: 7, modelId: "streaming-nemo-rnnt-en-1040ms" },
		});
	});

	test("loopbackStop routes to stop_listen with no args", () => {
		installMockApi();
		ipc.loopbackStop();
		expect(lastTauriCall().cmd).toBe("stop_listen");
	});

	test("cancelDownload routes to winstt_cancel_download", async () => {
		installMockApi();
		await ipc.cancelDownload();
		expect(lastTauriCall().cmd).toBe("winstt_cancel_download");
	});

	test("fetchModelCatalog returns the stt_list_models result when in a bridge context", async () => {
		const models = [{ id: "tiny" }];
		installMockApi();
		setTauriInvoke(() => models);
		expect(await ipc.fetchModelCatalog()).toEqual(models);
		expect(lastTauriCall().cmd).toBe("stt_list_models");
	});

	test("fetchModelCatalog falls back to [] when outside a bridge context", async () => {
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		expect(await ipc.fetchModelCatalog()).toEqual([]);
	});

	test("LLM fallback shapes: fetchOllamaModels returns reachable=false sentinel when outside a bridge context", async () => {
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		const result = await ipc.fetchOllamaModels();
		expect(result.reachable).toBe(false);
		expect(result.models).toEqual([]);
		expect(result.error).toBe("IPC unavailable");
	});

	test("LLM fallback: detectOllama returns installed=false sentinel when outside a bridge context", async () => {
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		const result = await ipc.detectOllama();
		expect(result.installed).toBe(false);
	});

	test("LLM fallback: startOllama returns started=false sentinel when outside a bridge context", async () => {
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		const result = await ipc.startOllama();
		expect(result.started).toBe(false);
		expect(result.error).toBe("IPC unavailable");
	});

	test("LLM fallback: fetchOpenRouterModels returns reachable=false sentinel when outside a bridge context", async () => {
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		const result = await ipc.fetchOpenRouterModels();
		expect(result.reachable).toBe(false);
		expect(result.models).toEqual([]);
		expect(result.error).toBe("IPC unavailable");
	});

	test("LLM fallback: processWithLlm returns the original text when outside a bridge context", async () => {
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		expect(await ipc.processWithLlm("hello")).toBe("hello");
	});

	test("LLM fallback: pullOllamaModel returns success=false sentinel when outside a bridge context", async () => {
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		const result = await ipc.pullOllamaModel("llama3.2:1b");
		expect(result.success).toBe(false);
		expect(result.model).toBe("");
		expect(result.error).toBe("IPC unavailable");
	});

	test("LLM fallback: deleteOllamaModel returns success=false sentinel when outside a bridge context", async () => {
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		const result = await ipc.deleteOllamaModel("llama3.2:1b");
		expect(result.success).toBe(false);
		expect(result.model).toBe("");
		expect(result.error).toBe("IPC unavailable");
	});

	test("LLM fallback: cancelOllamaModelPull returns cancelled=false when outside a bridge context", async () => {
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		const result = await ipc.cancelOllamaModelPull("llama3.2:1b");
		expect(result.cancelled).toBe(false);
	});

	test("loopbackListDevices falls back to [] when outside a bridge context", async () => {
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		expect(await ipc.loopbackListDevices()).toEqual([]);
	});

	test("dialogOpenFile falls back to null when outside a bridge context", async () => {
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		expect(await ipc.dialogOpenFile()).toBeNull();
	});

	test("clipboardWriteText resolves to a writeText response (no throw, no bridge)", async () => {
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		const result = await ipc.clipboardWriteText("hello");
		expect((result as { operation: string }).operation).toBe("writeText");
	});

	test("clipboardClear resolves to a clear response (no throw, no bridge)", async () => {
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		const result = await ipc.clipboardClear();
		expect((result as { operation: string }).operation).toBe("clear");
	});

	test("updaterClearStatusHistory falls back to { cleared: true } when outside a bridge context", async () => {
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		const result = await ipc.updaterClearStatusHistory();
		expect(result.cleared).toBe(true);
	});

	test("updaterGetStatusHistory falls back to [] when outside a bridge context", async () => {
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		expect(await ipc.updaterGetStatusHistory()).toEqual([]);
	});

	test("onLlmCatalog returns a noop unsubscribe when outside a bridge context (kills L448 ConditionalExpression mutation)", () => {
		window.nativeBridge = asInvalid<typeof window.nativeBridge>(undefined);
		const unsub = ipc.onLlmCatalog(() => undefined);
		expect(typeof unsub).toBe("function");
		// Calling unsub should not throw.
		expect(() => unsub()).not.toThrow();
	});

	test("on-event subscribers attach the callback to the right channel", () => {
		const api = installMockApi();
		const cb1 = () => undefined;
		ipc.onRealtimeText(cb1);
		ipc.onFullSentence(cb1);
		ipc.onNoAudioDetected(cb1);
		ipc.onRecordingStart(cb1);
		ipc.onRecordingStop(cb1);
		ipc.onVadStart(cb1);
		ipc.onVadStop(cb1);
		ipc.onTranscriptionStart(cb1);
		ipc.onConnectionChange(cb1);
		ipc.onServerStatus(cb1);
		ipc.onHotkeyPressed(cb1);
		ipc.onHotkeyReleased(cb1);
		ipc.onHotkeyRecordingUpdate(cb1);
		ipc.onHotkeyRecordingDone(cb1);
		ipc.onSettingsChanged(cb1);
		ipc.onSettingsSaveError(cb1);
		ipc.onAudioLevel(cb1);
		ipc.onModelDownloadStart(cb1);
		ipc.onModelDownloadProgress(cb1);
		ipc.onModelDownloadComplete(cb1);
		ipc.onLoopbackStarted(cb1);
		ipc.onLoopbackStopped(cb1);
		ipc.onDeviceSwitchFailed(cb1);
		// Each on() registration should have been forwarded to nativeBridge.on.
		expect(api.on.mock.calls.length).toBeGreaterThanOrEqual(20);
	});
});
