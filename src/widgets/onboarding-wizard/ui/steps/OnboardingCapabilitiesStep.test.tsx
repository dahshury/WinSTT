import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	fireEvent,
	render,
	screen,
	type RenderResult,
} from "@testing-library/react";
import { commands } from "@/bindings";

const originalPatchSettings = commands.winsttPatchSettings;

const { IntlProvider } = await import("@/app/providers/IntlProvider");
const { DEFAULT_SETTINGS, useSettingsStore } = await import(
	"@/entities/setting"
);
const { OnboardingCapabilitiesStep } = await import(
	"./OnboardingCapabilitiesStep"
);

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
	commands.winsttPatchSettings = async (request) => {
		invocations.push({ cmd: "winstt_patch_settings", args: { request } });
		return {
			status: "ok",
			data: {
				applied: true,
				changedSections: ["general"],
				snapshot: { revision: 1, settings: DEFAULT_SETTINGS as never },
			},
		};
	};
	tauriInternals().invoke = (cmd, args) => {
		invocations.push({ cmd, args });
		if (cmd === "winstt_get_settings_snapshot") {
			return Promise.resolve({ revision: 0, settings: DEFAULT_SETTINGS });
		}
		if (cmd === "winstt_patch_settings") {
			return Promise.resolve({
				status: "ok",
				data: {
					applied: true,
					changedSections: ["general"],
					snapshot: { revision: 1, settings: DEFAULT_SETTINGS },
				},
			});
		}
		return Promise.resolve(undefined);
	};
});

afterEach(() => {
	rendered?.unmount();
	rendered = null;
	useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
	commands.winsttPatchSettings = originalPatchSettings;
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

	test("applies the recording mode immediately while persistence runs", () => {
		renderStep();

		fireEvent.click(screen.getByRole("button", { name: "Toggle" }));

		expect(useSettingsStore.getState().settings.general.recordingMode).toBe(
			"toggle",
		);
	});
});
