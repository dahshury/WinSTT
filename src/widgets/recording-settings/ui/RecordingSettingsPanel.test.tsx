import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mock } from "bun:test";
import {
	act,
	fireEvent,
	render,
	screen,
	type RenderResult,
} from "@testing-library/react";
import { ipcClientMock } from "@test/mocks/ipc-client";
import type { WakewordModelStatusPayload } from "@/shared/api/ipc-client";

let wakewordStatus: WakewordModelStatusPayload = {
	available: false,
	downloading: false,
};
let wakewordDownloadCalls = {
	cancel: 0,
	pause: 0,
	resume: 0,
	start: 0,
};
const settingsSaveCalls: Array<{
	general?: {
		recordingMode?: string;
		recordingSound?: boolean;
	};
}> = [];
let wakewordStatusListener:
	| ((payload: WakewordModelStatusPayload) => void)
	| null = null;

mock.module("@/shared/api/ipc-client", () => ({
	...ipcClientMock(),
	wakewordModelStatus: () => Promise.resolve(wakewordStatus),
	wakewordStartModelDownload: () => {
		wakewordDownloadCalls.start += 1;
		return Promise.resolve(wakewordStatus);
	},
	wakewordPauseModelDownload: () => {
		wakewordDownloadCalls.pause += 1;
		return Promise.resolve(wakewordStatus);
	},
	wakewordResumeModelDownload: () => {
		wakewordDownloadCalls.resume += 1;
		return Promise.resolve(wakewordStatus);
	},
	wakewordCancelModelDownload: () => {
		wakewordDownloadCalls.cancel += 1;
		return Promise.resolve(wakewordStatus);
	},
	settingsSave: (settings: (typeof settingsSaveCalls)[number]) => {
		settingsSaveCalls.push(settings);
		return Promise.resolve();
	},
	onWakewordModelStatus: (
		cb: (payload: WakewordModelStatusPayload) => void,
	) => {
		wakewordStatusListener = cb;
		return () => {
			if (wakewordStatusListener === cb) {
				wakewordStatusListener = null;
			}
		};
	},
}));

const { IntlProvider } = await import("@/app/providers/IntlProvider");
const { DEFAULT_SETTINGS, useSettingsStore } = await import(
	"@/entities/setting"
);
const { RecordingSettingsPanel } = await import("./RecordingSettingsPanel");

let rendered: RenderResult | null = null;

function renderPanel() {
	rendered = render(
		<IntlProvider>
			<RecordingSettingsPanel />
		</IntlProvider>,
	);
}

function seedToggleMode(manualToggleStop: boolean): void {
	useSettingsStore.setState({
		settings: {
			...DEFAULT_SETTINGS,
			general: {
				...DEFAULT_SETTINGS.general,
				recordingMode: "toggle",
				manualToggleStop,
			},
			audio: {
				...DEFAULT_SETTINGS.audio,
				postSpeechSilenceDuration: 1.4,
			},
		},
	});
}

function seedWakewordMode(
	wakeWord = DEFAULT_SETTINGS.general.wakeWord,
	customWakeWords: string[] = [],
): void {
	useSettingsStore.setState({
		settings: {
			...DEFAULT_SETTINGS,
			general: {
				...DEFAULT_SETTINGS.general,
				recordingMode: "wakeword",
				wakeWord,
				customWakeWords,
			},
		},
	});
}

function seedListenMode(recordingSound: boolean): void {
	useSettingsStore.setState({
		settings: {
			...DEFAULT_SETTINGS,
			general: {
				...DEFAULT_SETTINGS.general,
				recordingMode: "listen",
				recordingSound,
			},
		},
	});
}

function setWakewordStatus(next: WakewordModelStatusPayload): void {
	wakewordStatus = next;
	wakewordStatusListener?.(next);
}

async function flushWakewordStatus(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
	});
}

function wakeWordComboboxTrigger(): HTMLElement {
	const trigger = screen
		.getAllByRole("button", { name: "Wake Word" })
		.find((button) => button.getAttribute("aria-haspopup") === "listbox");
	if (!trigger) {
		throw new Error("wake-word combobox trigger not found");
	}
	return trigger;
}

beforeEach(() => {
	setWakewordStatus({ available: false, downloading: false });
	wakewordDownloadCalls = { cancel: 0, pause: 0, resume: 0, start: 0 };
	settingsSaveCalls.length = 0;
	useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
});

afterEach(() => {
	if (rendered) {
		act(() => rendered?.unmount());
		rendered = null;
	}
	useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
});

describe("RecordingSettingsPanel", () => {
	test("shows a silence-stop slider under Toggle mode when hotkey-only stop is disabled", async () => {
		seedToggleMode(false);
		renderPanel();
		await flushWakewordStatus();

		const slider = screen.getByRole("slider", { name: "Post-Speech Silence" });

		expect(slider.getAttribute("aria-valuenow")).toBe("1.4");
		expect(slider.getAttribute("aria-valuetext")).toBe("1.4s");
	});

	test("hides the silence-stop slider when Toggle mode stops only on hotkey press", async () => {
		seedToggleMode(true);
		renderPanel();
		await flushWakewordStatus();

		expect(
			screen.queryByRole("slider", { name: "Post-Speech Silence" }),
		).toBeNull();
	});

	test("updates the silence-stop duration from the toggle-mode slider", async () => {
		seedToggleMode(false);
		renderPanel();
		await flushWakewordStatus();

		const slider = screen.getByRole("slider", { name: "Post-Speech Silence" });
		fireEvent.keyDown(slider, { key: "ArrowRight" });

		expect(
			useSettingsStore.getState().settings.audio.postSpeechSilenceDuration,
		).toBe(1.5);
	});

	test("persists recording mode immediately when leaving Listen mode", async () => {
		seedListenMode(true);
		renderPanel();
		await flushWakewordStatus();

		fireEvent.click(screen.getByRole("button", { name: "Push to Talk" }));

		expect(useSettingsStore.getState().settings.general.recordingMode).toBe(
			"ptt",
		);
		expect(settingsSaveCalls.at(-1)?.general?.recordingMode).toBe("ptt");
		expect(settingsSaveCalls.at(-1)?.general?.recordingSound).toBe(true);
	});

	test("downloads wake-word files before enabling Wake Word mode", async () => {
		renderPanel();
		await flushWakewordStatus();

		fireEvent.click(screen.getByRole("button", { name: "Wake Word" }));

		expect(screen.getByText("Download wake word files?")).toBeTruthy();
		expect(useSettingsStore.getState().settings.general.recordingMode).toBe(
			"ptt",
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Download and enable" }),
		);

		expect(wakewordDownloadCalls.start).toBe(1);
		expect(useSettingsStore.getState().settings.general.recordingMode).toBe(
			"ptt",
		);

		act(() => {
			setWakewordStatus({
				available: true,
				downloading: false,
				phase: "complete",
			});
		});

		expect(useSettingsStore.getState().settings.general.recordingMode).toBe(
			"wakeword",
		);
	});

	test("offers pause, resume, and cancel while wake-word files download", async () => {
		renderPanel();
		await flushWakewordStatus();

		fireEvent.click(screen.getByRole("button", { name: "Wake Word" }));
		fireEvent.click(
			screen.getByRole("button", { name: "Download and enable" }),
		);

		act(() => {
			setWakewordStatus({
				available: false,
				downloadedBytes: 512,
				downloading: true,
				phase: "downloading",
				progress: 0.5,
				totalBytes: 1024,
			});
		});

		fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
		expect(wakewordDownloadCalls.pause).toBe(1);

		act(() => {
			setWakewordStatus({
				available: false,
				downloadedBytes: 512,
				downloading: false,
				phase: "paused",
				progress: 0.5,
				totalBytes: 1024,
			});
		});

		fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
		expect(wakewordDownloadCalls.resume).toBe(1);

		fireEvent.click(screen.getByRole("button", { name: "Cancel download" }));
		expect(wakewordDownloadCalls.cancel).toBe(1);
		expect(useSettingsStore.getState().settings.general.recordingMode).toBe(
			"ptt",
		);
	});

	test("updates the wake word from the custom phrase input", async () => {
		setWakewordStatus({ available: true, downloading: false });
		seedWakewordMode();
		renderPanel();
		await flushWakewordStatus();

		const wakeWordCombobox = screen.getByPlaceholderText(
			"Select or type wake word",
		);
		fireEvent.click(wakeWordComboboxTrigger());
		fireEvent.change(wakeWordCombobox, { target: { value: "hey codex" } });
		fireEvent.click(await screen.findByText('Save "hey codex"'));

		expect(useSettingsStore.getState().settings.general.wakeWord).toBe(
			"hey codex",
		);
		expect(
			useSettingsStore.getState().settings.general.customWakeWords,
		).toEqual(["hey codex"]);
	});

	test("labels custom wake phrases as lower accuracy", async () => {
		setWakewordStatus({ available: true, downloading: false });
		seedWakewordMode("hey codex", ["hey codex"]);
		renderPanel();
		await flushWakewordStatus();

		expect(
			screen.getByText(/lower accuracy than built-in Porcupine phrases/i),
		).toBeTruthy();
	});

	test("preserves a custom wake phrase when switching into Wake Word mode", async () => {
		setWakewordStatus({ available: true, downloading: false });
		useSettingsStore.setState({
			settings: {
				...DEFAULT_SETTINGS,
				general: {
					...DEFAULT_SETTINGS.general,
					recordingMode: "ptt",
					wakeWord: "hey codex",
				},
			},
		});
		renderPanel();
		await flushWakewordStatus();

		fireEvent.click(screen.getByRole("button", { name: "Wake Word" }));

		expect(useSettingsStore.getState().settings.general.recordingMode).toBe(
			"wakeword",
		);
		expect(useSettingsStore.getState().settings.general.wakeWord).toBe(
			"hey codex",
		);
	});

	test("deletes a saved custom wake phrase from the combobox", async () => {
		setWakewordStatus({ available: true, downloading: false });
		seedWakewordMode("hey codex", ["hey codex"]);
		renderPanel();
		await flushWakewordStatus();

		fireEvent.click(wakeWordComboboxTrigger());
		fireEvent.click(
			await screen.findByRole("button", { name: "Delete custom wake word" }),
		);

		expect(useSettingsStore.getState().settings.general.wakeWord).toBe(
			DEFAULT_SETTINGS.general.wakeWord,
		);
		expect(
			useSettingsStore.getState().settings.general.customWakeWords,
		).toEqual([]);
	});
});
