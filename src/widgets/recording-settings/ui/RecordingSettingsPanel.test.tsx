import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, type RenderResult } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import { RecordingSettingsPanel } from "./RecordingSettingsPanel";

let rendered: RenderResult | null = null;

function renderPanel() {
	rendered = render(
		<IntlProvider>
			<RecordingSettingsPanel />
		</IntlProvider>
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

beforeEach(() => {
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
	test("shows a silence-stop slider under Toggle mode when hotkey-only stop is disabled", () => {
		seedToggleMode(false);
		renderPanel();

		const slider = screen.getByRole("slider", { name: "Post-Speech Silence" });

		expect(slider.getAttribute("aria-valuenow")).toBe("1.4");
		expect(slider.getAttribute("aria-valuetext")).toBe("1.4s");
	});

	test("hides the silence-stop slider when Toggle mode stops only on hotkey press", () => {
		seedToggleMode(true);
		renderPanel();

		expect(screen.queryByRole("slider", { name: "Post-Speech Silence" })).toBeNull();
	});

	test("updates the silence-stop duration from the toggle-mode slider", () => {
		seedToggleMode(false);
		renderPanel();

		const slider = screen.getByRole("slider", { name: "Post-Speech Silence" });
		fireEvent.keyDown(slider, { key: "ArrowRight" });

		expect(useSettingsStore.getState().settings.audio.postSpeechSilenceDuration).toBe(1.5);
	});
});
