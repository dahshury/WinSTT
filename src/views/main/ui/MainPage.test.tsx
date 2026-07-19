import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import { useTranscriptionStore } from "@/entities/transcription";
import { useVisualizerStore } from "@/features/audio-visualizer";
import { useListenStore } from "@/features/listen-mode";
import { MainPage } from "./MainPage";

function resetStores(): void {
	useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
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
	useVisualizerStore.setState({
		isRecording: false,
		isSpeaking: false,
		audioLevel: 0,
		sentencePulse: 0,
	});
	useListenStore.setState({
		isListening: false,
		deviceName: "",
		devices: [],
	});
}

function renderMainPage() {
	return render(
		<IntlProvider>
			<MainPage />
		</IntlProvider>,
	);
}

interface TauriInternals {
	invoke: (
		command: string,
		args?: unknown,
		options?: unknown,
	) => Promise<unknown>;
}

function getTauriInternals(): TauriInternals {
	return (window as unknown as { __TAURI_INTERNALS__: TauriInternals })
		.__TAURI_INTERNALS__;
}

beforeEach(resetStores);
afterEach(resetStores);

describe("MainPage", () => {
	test("renders without crashing", () => {
		const { container } = renderMainPage();
		expect(container.firstElementChild).not.toBeNull();
	});

	test("keeps the normal main-window shell while listen mode is idle", async () => {
		useSettingsStore.setState({
			settings: {
				...DEFAULT_SETTINGS,
				general: {
					...DEFAULT_SETTINGS.general,
					recordingMode: "listen",
				},
			},
		});

		renderMainPage();

		expect(screen.getByRole("region").className).toContain("rounded-lg");
		expect(await screen.findByText("Loopback Idle")).not.toBeNull();
		expect(
			screen.getByRole("button", { name: "Switch to Push-to-Talk" }),
		).not.toBeNull();
	});

	test("switches to the listen subtitle surface when loopback audio is active", () => {
		useSettingsStore.setState({
			settings: {
				...DEFAULT_SETTINGS,
				general: {
					...DEFAULT_SETTINGS.general,
					recordingMode: "listen",
				},
			},
		});
		useVisualizerStore.setState({
			isRecording: true,
			audioLevel: 0.02,
		});

		renderMainPage();

		expect(screen.getByRole("region").className).not.toContain("rounded-lg");
		expect(screen.queryByText("Loopback Idle")).toBeNull();
		expect(
			screen.getByRole("button", { name: "Switch to Push-to-Talk" }),
		).not.toBeNull();
	});

	test("switches from listen mode to push-to-talk on activation", async () => {
		useSettingsStore.setState({
			settings: {
				...DEFAULT_SETTINGS,
				general: {
					...DEFAULT_SETTINGS.general,
					recordingMode: "listen",
				},
			},
		});
		const tauriInternals = getTauriInternals();
		const originalInvoke = tauriInternals.invoke;
		let persisted = false;
		tauriInternals.invoke = async (command, args, options) => {
			if (command === "winstt_get_settings_snapshot") {
				return { revision: 0, settings: DEFAULT_SETTINGS };
			}
			if (command === "winstt_patch_settings") {
				persisted = true;
				return {
					applied: true,
					changedSections: ["general"],
					snapshot: {
						revision: 1,
						settings: useSettingsStore.getState().settings,
					},
				};
			}
			return originalInvoke(command, args, options);
		};

		try {
			renderMainPage();

			fireEvent.click(
				screen.getByRole("button", { name: "Switch to Push-to-Talk" }),
			);

			expect(useSettingsStore.getState().settings.general.recordingMode).toBe(
				"ptt",
			);
			expect(
				screen.queryByRole("button", { name: "Switch to Push-to-Talk" }),
			).toBeNull();
			await waitFor(() => expect(persisted).toBe(true));
		} finally {
			tauriInternals.invoke = originalInvoke;
		}
	});
});
