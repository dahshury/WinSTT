import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	fireEvent,
	render,
	screen,
	type RenderResult,
} from "@testing-library/react";

const { IntlProvider } = await import("@/app/providers/IntlProvider");
const { DEFAULT_SETTINGS, useSettingsStore } =
	await import("@/entities/setting");
const { OnboardingCapabilitiesStep } =
	await import("./OnboardingCapabilitiesStep");

interface TauriInvocation {
	args?: unknown;
	cmd: string;
}

let invocations: TauriInvocation[] = [];
let rendered: RenderResult | null = null;

function tauriInternals(): {
	invoke: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
	transformCallback: (
		cb?: (payload: unknown) => void,
		once?: boolean,
	) => number;
} {
	return (
		window as unknown as {
			__TAURI_INTERNALS__: {
				invoke: (
					cmd: string,
					args?: unknown,
					options?: unknown,
				) => Promise<unknown>;
				transformCallback: (
					cb?: (payload: unknown) => void,
					once?: boolean,
				) => number;
			};
		}
	).__TAURI_INTERNALS__;
}

function renderStep(): void {
	rendered = render(
		<IntlProvider>
			<OnboardingCapabilitiesStep />
		</IntlProvider>,
	);
}

beforeEach(() => {
	invocations = [];
	useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
	tauriInternals().invoke = (cmd, args) => {
		invocations.push({ cmd, args });
		return Promise.resolve({ changedStartup: false });
	};
});

afterEach(() => {
	rendered?.unmount();
	rendered = null;
	useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
});

describe("OnboardingCapabilitiesStep", () => {
	test("renders the dictation demo as an editable textbox", () => {
		renderStep();

		const textbox = screen.getByRole("textbox", { name: "Try it out" });
		textbox.focus();
		fireEvent.change(textbox, { target: { value: "typed here" } });

		expect(document.activeElement).toBe(textbox);
		expect((textbox as HTMLTextAreaElement).value).toBe("typed here");
	});

	test("persists recording mode immediately through the generated settings command", () => {
		renderStep();

		fireEvent.click(screen.getByRole("button", { name: "Toggle" }));

		expect(useSettingsStore.getState().settings.general.recordingMode).toBe(
			"toggle",
		);
		const save = invocations.find((call) => call.cmd === "winstt_set_settings");
		expect(save).toBeDefined();
		expect(
			(save?.args as { settings?: { general?: { recordingMode?: string } } })
				.settings?.general?.recordingMode,
		).toBe("toggle");
	});
});
