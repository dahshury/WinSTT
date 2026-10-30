import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useSettingsStore } from "@/entities/setting";
import { AsrPromptControls } from "./AsrPromptControls";
import { useSeparateCleanupConfirmation } from "./use-separate-cleanup-confirmation";

const initial = useSettingsStore.getState().settings;
afterEach(() => {
	cleanup();
	useSettingsStore.setState({ settings: initial });
});

function seed(
	model: string,
	source: "off" | "custom" | "cleanupPresets" = "off",
) {
	useSettingsStore.setState({
		settings: {
			...initial,
			model: {
				...initial.model,
				model,
				asrPromptSource: source,
				asrPromptModel: model,
				asrInstruction: "Omit fillers.",
				asrAllowSeparateCleanup: false,
			},
			llm: {
				...initial.llm,
				dictation: { ...initial.llm.dictation, enabled: true },
			},
		},
	});
}

function Guard({ action }: { action: () => void }) {
	const guard = useSeparateCleanupConfirmation();
	return (
		<>
			<button onClick={() => guard.request(action)} type="button">
				Enable second model
			</button>
			{guard.dialog}
		</>
	);
}

describe("audio instruction controls", () => {
	test("an empty custom instruction keeps the existing cleanup pass available", () => {
		seed("nemotron-3.5-transcribe-30b-a4b");
		const state = useSettingsStore.getState().settings;
		useSettingsStore.setState({
			settings: { ...state, model: { ...state.model, asrInstruction: "" } },
		});
		render(
			<IntlProvider>
				<AsrPromptControls />
			</IntlProvider>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Custom instruction", exact: true }),
		);
		expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(
			true,
		);
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "Remove verbal fillers." },
		});
		expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(
			false,
		);
	});
	test("Whisper does not acquire a misleading cleanup instruction control", () => {
		seed("tiny");
		render(
			<IntlProvider>
				<AsrPromptControls />
			</IntlProvider>,
		);
		expect(screen.queryByText("Direct ASR prompting")).toBeNull();
	});
	test("Granite exposes task instructions but not cleanup presets", () => {
		seed("granite-speech-4.1-2b-plus");
		render(
			<IntlProvider>
				<AsrPromptControls />
			</IntlProvider>,
		);
		expect(screen.queryByText("Use cleanup presets")).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: "Custom instruction", exact: true }),
		);
		expect(useSettingsStore.getState().settings.llm.dictation.enabled).toBe(
			true,
		);
		expect(
			screen.getByLabelText("Instruction to the speech model"),
		).toBeTruthy();
	});
	test("using cleanup presets preserves those presets and disables the extra model", () => {
		seed("nemotron-3.5-transcribe-30b-a4b");
		const presets = useSettingsStore.getState().settings.llm.dictation.presets;
		render(
			<IntlProvider>
				<AsrPromptControls />
			</IntlProvider>,
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Use cleanup presets", exact: true }),
		);
		const state = useSettingsStore.getState().settings;
		expect(state.model.asrPromptSource).toBe("cleanupPresets");
		expect(state.llm.dictation.enabled).toBe(false);
		expect(state.llm.dictation.presets).toEqual(presets);
	});
	test("cancelling a second-pass warning does not enable or acknowledge it", () => {
		seed("nemotron-3.5-transcribe-30b-a4b", "cleanupPresets");
		const action = mock(() => undefined);
		render(
			<IntlProvider>
				<Guard action={action} />
			</IntlProvider>,
		);
		fireEvent.click(screen.getByText("Enable second model"));
		expect(action).not.toHaveBeenCalled();
		fireEvent.click(screen.getByText("Cancel"));
		expect(action).not.toHaveBeenCalled();
		expect(
			useSettingsStore.getState().settings.model.asrAllowSeparateCleanup,
		).toBe(false);
	});
	test("the second model is enabled only after explicit consent", () => {
		seed("nemotron-3.5-transcribe-30b-a4b", "cleanupPresets");
		const action = mock(() => undefined);
		render(
			<IntlProvider>
				<Guard action={action} />
			</IntlProvider>,
		);
		fireEvent.click(screen.getByText("Enable second model"));
		expect(action).not.toHaveBeenCalled();
		fireEvent.click(screen.getByText("Use separate cleanup anyway"));
		expect(action).toHaveBeenCalledTimes(1);
		expect(
			useSettingsStore.getState().settings.model.asrAllowSeparateCleanup,
		).toBe(true);
	});
});
