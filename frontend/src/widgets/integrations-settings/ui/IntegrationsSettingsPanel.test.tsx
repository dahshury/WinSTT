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

	test("typing in the OpenRouter key field does NOT persist until verification succeeds", () => {
		// Auto-validate behavior: typing only updates the local input value
		// and schedules a debounced verify probe. The settings store stays
		// untouched until the probe completes — synchronously, right after
		// the change event, settings.llm.openrouterApiKey is still empty.
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
			// Settings store is NOT yet written — verify probe is debounced
			// and hasn't fired (let alone resolved).
			expect(useSettingsStore.getState().settings.llm.openrouterApiKey).toBe("");
		}
	});
});
