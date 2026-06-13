import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useSettingsStore } from "@/entities/setting";
import { IntegrationsSettingsPanel } from "./IntegrationsSettingsPanel";

const initial = useSettingsStore.getState().settings;
const SECRET_PRESENT_SENTINEL = "__WINSTT_SECRET_PRESENT__";

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
		// ElevenLabs cloud-STT key sits under "Cloud Speech-to-Text" (OpenAI was
		// removed as a direct cloud STT provider). A user who adds only an
		// OpenRouter key should see it grouped away from the STT section — that's
		// the whole point of the split.
		const { getAllByRole, getByText, queryByText } = render(
			<IntlProvider>
				<IntegrationsSettingsPanel />
			</IntlProvider>,
		);
		expect(getByText("Language Models (LLM)")).toBeDefined();
		expect(getByText("Cloud Speech-to-Text")).toBeDefined();
		// Section help copy is kept behind info pills so it remains discoverable
		// without adding static body text to the settings page.
		expect(
			queryByText(
				"Transcribe with a cloud provider instead of a local model. Add a key here to unlock the Cloud source in the Transcription tab.",
			),
		).toBeNull();
		expect(
			getAllByRole("button", { name: "More info" }).length,
		).toBeGreaterThan(0);
	});

	test("renders the Ollama endpoint and locks a saved OpenRouter API key", () => {
		useSettingsStore.setState({
			settings: {
				...initial,
				llm: {
					...initial.llm,
					endpoint: "http://localhost:11434",
					openrouterApiKey: SECRET_PRESENT_SENTINEL,
				},
			},
		});
		const { container, getAllByRole } = render(
			<IntlProvider>
				<IntegrationsSettingsPanel />
			</IntlProvider>,
		);
		const inputs = container.querySelectorAll("input");
		expect(inputs.length).toBeGreaterThanOrEqual(2);
		const values = Array.from(inputs).map((i) => i.value);
		expect(values).toContain("http://localhost:11434");
		expect(values).not.toContain(SECRET_PRESENT_SENTINEL);
		const openrouterInput = container.querySelector(
			'input[aria-label="OpenRouter API Key"]',
		) as HTMLInputElement | null;
		expect(openrouterInput?.disabled).toBe(true);
		expect(openrouterInput?.value).toBe("********");
		expect(getAllByRole("button", { name: "Remove key" }).length).toBe(1);
		expect(getAllByRole("button", { name: "Get a key" }).length).toBe(1);
	});

	test("typing in the endpoint field writes to settings.llm.endpoint", () => {
		const { container } = render(
			<IntlProvider>
				<IntegrationsSettingsPanel />
			</IntlProvider>,
		);
		const endpointInput = container.querySelector(
			'input[placeholder="http://localhost:11434"]',
		) as HTMLInputElement | null;
		expect(endpointInput).not.toBeNull();
		if (endpointInput) {
			fireEvent.change(endpointInput, {
				target: { value: "http://example.com:9999" },
			});
			expect(useSettingsStore.getState().settings.llm.endpoint).toBe(
				"http://example.com:9999",
			);
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
			</IntlProvider>,
		);
		const keyInput = container.querySelector(
			'input[placeholder^="sk-or-"]',
		) as HTMLInputElement | null;
		expect(keyInput).not.toBeNull();
		if (keyInput) {
			fireEvent.change(keyInput, { target: { value: "sk-or-new-key" } });
			// Local input reflects the typed value (controlled).
			expect(keyInput.value).toBe("sk-or-new-key");
			// Settings store reflects the typed value synchronously.
			expect(useSettingsStore.getState().settings.llm.openrouterApiKey).toBe(
				"sk-or-new-key",
			);
		}
	});

	test("OpenRouter key input locks after active editing ends", () => {
		const { container } = render(
			<IntlProvider>
				<IntegrationsSettingsPanel />
			</IntlProvider>,
		);
		const keyInput = container.querySelector(
			'input[placeholder^="sk-or-"]',
		) as HTMLInputElement | null;
		expect(keyInput).not.toBeNull();
		if (keyInput) {
			fireEvent.change(keyInput, { target: { value: "sk-or-new-key" } });
			expect(keyInput.disabled).toBe(false);
			expect(keyInput.value).toBe("sk-or-new-key");

			fireEvent.blur(keyInput);
			const lockedInput = container.querySelector(
				'input[aria-label="OpenRouter API Key"]',
			) as HTMLInputElement | null;
			expect(lockedInput?.disabled).toBe(true);
			expect(lockedInput?.value).toBe("********");
		}
	});

	test("locks a saved ElevenLabs API key", () => {
		useSettingsStore.setState({
			settings: {
				...initial,
				integrations: {
					...initial.integrations,
					elevenlabs: {
						...initial.integrations.elevenlabs,
						apiKey: SECRET_PRESENT_SENTINEL,
					},
				},
			},
		});
		const { container, getAllByRole } = render(
			<IntlProvider>
				<IntegrationsSettingsPanel />
			</IntlProvider>,
		);
		const elevenlabsInput = container.querySelector(
			'input[aria-label="ElevenLabs API Key"]',
		) as HTMLInputElement | null;
		expect(elevenlabsInput?.disabled).toBe(true);
		expect(elevenlabsInput?.value).toBe("********");
		expect(
			Array.from(container.querySelectorAll("input")).map((i) => i.value),
		).not.toContain(SECRET_PRESENT_SENTINEL);
		expect(getAllByRole("button", { name: "Remove key" }).length).toBe(1);
		expect(getAllByRole("button", { name: "Get a key" }).length).toBe(1);
	});
});
