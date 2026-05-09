import { describe, expect, test } from "bun:test";
import {
	audioGetDevices,
	autostartGet,
	clipboardReadText,
	contextMenuShow,
	dialogOpenFile,
	fetchModelCatalog,
	fileTranscribe,
	gpuGetInfo,
	hotkeyRegister,
	hotkeyStartRecording,
	loopbackListDevices,
	processWithLlm,
	settingsLoad,
	sttGetParameter,
	sttIsConnected,
	sttServerStatus,
	updaterClearStatusHistory,
	updaterGetStatusHistory,
} from "./ipc-client";

describe("ipc-client non-electron fallbacks", () => {
	test("returns stable fallback values for getters", async () => {
		expect(await settingsLoad()).toBeDefined();
		expect((await settingsLoad()).general.recordingMode).toBe("ptt");
		expect(await sttGetParameter("model")).toBeNull();
		expect(await hotkeyRegister("Ctrl+Shift+R")).toBe(false);
		expect(await hotkeyStartRecording()).toBe(false);
		expect(await autostartGet()).toBe(false);
		expect(await audioGetDevices()).toEqual([]);
		expect(await gpuGetInfo()).toBeNull();
		expect(await sttIsConnected()).toBe(false);
		expect(await sttServerStatus()).toBe("idle");
		expect(await fetchModelCatalog()).toEqual([]);
		expect(await loopbackListDevices()).toEqual([]);
		expect(await dialogOpenFile()).toBeNull();
		expect(await contextMenuShow([])).toEqual({ selectedId: null });
		expect(await updaterGetStatusHistory()).toEqual([]);
		expect(await updaterClearStatusHistory()).toEqual({ cleared: true });
		expect(await fileTranscribe("C:\\test.wav")).toEqual({ requestId: "" });
		expect(await clipboardReadText()).toBe("");
		expect(await processWithLlm("hello")).toBe("hello");
	});
});
