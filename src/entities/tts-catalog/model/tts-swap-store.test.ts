import { afterEach, describe, expect, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";
import type { TtsInstallStatusPayload } from "@/shared/api/ipc-client";

// Per-test capture of the install-lifecycle callbacks `initTtsSwapStore` wires
// up. Bun's `mock.module` cache is process-global, so we route through the real
// ipc-client fake plus the two overrides this suite drives.
const ipcOverrides: {
	statusCb: ((p: TtsInstallStatusPayload) => void) | null;
	failedCb: (() => void) | null;
} = {
	statusCb: null,
	failedCb: null,
};

mock.module("@/shared/api/ipc-client", () => ({
	...ipcClientMock(),
	onTtsInstallStatus: (cb: (p: TtsInstallStatusPayload) => void) => {
		ipcOverrides.statusCb = cb;
		return () => {
			ipcOverrides.statusCb = null;
		};
	},
	onTtsInstallFailed: (cb: () => void) => {
		ipcOverrides.failedCb = cb;
		return () => {
			ipcOverrides.failedCb = null;
		};
	},
}));

const {
	useTtsSwapStore,
	initTtsSwapStore,
	_setTtsSwapStaleMsForTests,
	_resetTtsSwapForTests,
} = await import("./tts-swap-store");

function emitStatus(phase: TtsInstallStatusPayload["phase"]): void {
	ipcOverrides.statusCb?.({ phase });
}

const SWAP = {
	fromModelId: "qwen3-tts",
	toModelId: "qwen3-tts",
	fromQuant: "int4",
	toQuant: "fp16",
} as const;

afterEach(() => {
	useTtsSwapStore.getState().clear();
	_resetTtsSwapForTests();
	ipcOverrides.statusCb = null;
	ipcOverrides.failedCb = null;
});

describe("useTtsSwapStore", () => {
	test("begin opens the transition; clear closes it", () => {
		useTtsSwapStore.getState().begin({ ...SWAP });
		expect(useTtsSwapStore.getState().active).toEqual({ ...SWAP });
		useTtsSwapStore.getState().clear();
		expect(useTtsSwapStore.getState().active).toBeNull();
	});

	test("install-status 'ready' clears an open swap", () => {
		const dispose = initTtsSwapStore();
		useTtsSwapStore.getState().begin({ ...SWAP });
		emitStatus("ready");
		expect(useTtsSwapStore.getState().active).toBeNull();
		dispose();
	});

	test("install-status 'model' confirms so the self-heal can't strand it", async () => {
		_setTtsSwapStaleMsForTests(20);
		const dispose = initTtsSwapStore();
		useTtsSwapStore.getState().begin({ ...SWAP });
		emitStatus("model"); // confirm — cancels the self-heal timer
		await new Promise((r) => setTimeout(r, 40));
		// Still open: a confirmed swap waits for ready/failed, however long.
		expect(useTtsSwapStore.getState().active).not.toBeNull();
		emitStatus("ready");
		expect(useTtsSwapStore.getState().active).toBeNull();
		dispose();
	});

	test("an unconfirmed swap self-heals after the stale window", async () => {
		_setTtsSwapStaleMsForTests(15);
		useTtsSwapStore.getState().begin({ ...SWAP });
		await new Promise((r) => setTimeout(r, 35));
		expect(useTtsSwapStore.getState().active).toBeNull();
	});

	test("install-failed clears an open swap", () => {
		const dispose = initTtsSwapStore();
		useTtsSwapStore.getState().begin({ ...SWAP });
		ipcOverrides.failedCb?.();
		expect(useTtsSwapStore.getState().active).toBeNull();
		dispose();
	});

	test("lifecycle pushes are ignored when no swap is open", () => {
		const dispose = initTtsSwapStore();
		emitStatus("ready");
		ipcOverrides.failedCb?.();
		expect(useTtsSwapStore.getState().active).toBeNull();
		dispose();
	});
});
