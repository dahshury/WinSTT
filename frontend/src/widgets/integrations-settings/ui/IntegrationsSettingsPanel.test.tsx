import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useSettingsStore } from "@/entities/setting";
import { IntegrationsSettingsPanel } from "./IntegrationsSettingsPanel";

const initial = useSettingsStore.getState().settings;

beforeEach(() => {
	useSettingsStore.setState({ settings: { ...initial } });
});

afterEach(() => {
	useSettingsStore.setState({ settings: initial });
});

describe("IntegrationsSettingsPanel", () => {
	test("groups keys under the LLM and Cloud STT capability sections", () => {
		// The panel must make it unambiguous which key unlocks which feature:
		// OpenRouter/Ollama sit under "Language Models (LLM)", while the
		// OpenAI/ElevenLabs cloud-STT keys sit under "Cloud Speech-to-Text".
		// A user who adds only an OpenRouter key should see it grouped away
		// from the STT section — that's the whole point of the split.
		const { getByText } = render(
			<IntlProvider>
				<IntegrationsSettingsPanel />
			</IntlProvider>
		);
		expect(getByText("Language Models (LLM)")).toBeDefined();
		expect(getByText("Cloud Speech-to-Text")).toBeDefined();
		// The STT caption points the user at the Model-tab Cloud source so
		// they know where the key takes effect.
		expect(
			getByText(
				"Transcribe with a cloud provider instead of a local model. Add a key here to unlock the Cloud source in the Model tab."
			)
		).toBeDefined();
	});

	test("renders the Ollama endpoint and OpenRouter API key inputs", () => {
		useSettingsStore.setState({
			settings: {
				...initial,
				llm: {
					...initial.llm,
					endpoint: "http://localhost:11434",
					openrouterApiKey: "sk-or-test",
				},
			},
		});
		const { container } = render(
			<IntlProvider>
				<IntegrationsSettingsPanel />
			</IntlProvider>
		);
		const inputs = container.querySelectorAll("input");
		// One TextField + one PasswordField rendered.
		expect(inputs.length).toBeGreaterThanOrEqual(2);
		const values = Array.from(inputs).map((i) => i.value);
		expect(values).toContain("http://localhost:11434");
		expect(values).toContain("sk-or-test");
	});

	test("typing in the endpoint field writes to settings.llm.endpoint", () => {
		const { container } = render(
			<IntlProvider>
				<IntegrationsSettingsPanel />
			</IntlProvider>
		);
		const endpointInput = container.querySelector(
			'input[placeholder="http://localhost:11434"]'
		) as HTMLInputElement | null;
		expect(endpointInput).not.toBeNull();
		if (endpointInput) {
			fireEvent.change(endpointInput, { target: { value: "http://example.com:9999" } });
			expect(useSettingsStore.getState().settings.llm.endpoint).toBe("http://example.com:9999");
		}
	});

	test("typing in the OpenRouter key field persists immediately, before verification", () => {
		// Persistence is no longer gated on verification — every keystroke
		// writes through to settings.llm.openrouterApiKey so a tab switch
		// before the debounced verify completes can never lose the key.
		// The verify probe (debounced) only drives the status pill.
		const { container } = render(
			<IntlProvider>
				<IntegrationsSettingsPanel />
			</IntlProvider>
		);
		const keyInput = container.querySelector(
			'input[placeholder^="sk-or-"]'
		) as HTMLInputElement | null;
		expect(keyInput).not.toBeNull();
		if (keyInput) {
			fireEvent.change(keyInput, { target: { value: "sk-or-new-key" } });
			// Local input reflects the typed value (controlled).
			expect(keyInput.value).toBe("sk-or-new-key");
			// Settings store reflects the typed value synchronously.
			expect(useSettingsStore.getState().settings.llm.openrouterApiKey).toBe("sk-or-new-key");
		}
	});
});
