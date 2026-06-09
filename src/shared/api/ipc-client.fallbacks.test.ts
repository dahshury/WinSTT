import { describe, expect, test } from "bun:test";
import {
	audioGetDevices,
	autostartGet,
	clipboardReadText,
	dialogOpenFile,
	fetchModelCatalog,
	gpuGetInfo,
	hotkeyRegister,
	hotkeyStartRecording,
	loopbackListDevices,
	processWithLlm,
	settingsLoad,
	sttGetParameter,
	sttIsConnected,
	updaterClearStatusHistory,
	updaterGetStatusHistory,
} from "./ipc-client";

describe("ipc-client non-bridge fallbacks", () => {
	test("returns stable fallback values for getters", async () => {
		expect(await settingsLoad()).toBeDefined();
		expect((await settingsLoad()).general.recordingMode).toBe("ptt");
		expect(await sttGetParameter("model")).toBeNull();
		expect(await hotkeyRegister("Ctrl+Shift+R")).toBe(false);
		expect(await hotkeyStartRecording()).toBe(false);
		expect(await autostartGet()).toBe(false);
		expect(await audioGetDevices()).toEqual([]);
		// gpuGetInfo's declared fallback is `[]` (GpuInfo[]) — the prior `toBeNull()`
		// assertion was stale (never matched the wrapper's `[]` default).
		expect(await gpuGetInfo()).toEqual([]);
		expect(await sttIsConnected()).toBe(false);
		expect(await fetchModelCatalog()).toEqual([]);
		expect(await loopbackListDevices()).toEqual([]);
		expect(await dialogOpenFile()).toBeNull();
		expect(await updaterGetStatusHistory()).toEqual([]);
		expect(await updaterClearStatusHistory()).toEqual({ cleared: true });
		expect(await clipboardReadText()).toBe("");
		expect(await processWithLlm("hello")).toBe("hello");
	});
});
