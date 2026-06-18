import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";
import { render, screen, waitFor } from "@testing-library/react";

type MockOllamaScanResult = {
	error?: string;
	models: Array<{ modifiedAt?: string; name: string; size?: number }>;
	reachable: boolean;
};

let detectOllamaResult = { installed: false };
let fetchOllamaModelsResult: MockOllamaScanResult = {
	models: [],
	reachable: false,
	error: "IPC unavailable",
};

const detectOllamaMock = mock(async () => detectOllamaResult);
const fetchOllamaModelsMock = mock(async () => fetchOllamaModelsResult);

mock.module("@/shared/api/ipc-client", () => ({
	...ipcClientMock(),
	detectOllama: detectOllamaMock,
	fetchOllamaModels: fetchOllamaModelsMock,
}));

const [{ IntlProvider }, { DEFAULT_SETTINGS, useSettingsStore }] =
	await Promise.all([
		import("@/app/providers/IntlProvider"),
		import("@/entities/setting"),
	]);
const [{ useLlmCatalogStore, useOllamaLibraryStore }, { useModelStateStore }] =
	await Promise.all([
		import("@/entities/llm-catalog"),
		import("@/entities/model-catalog"),
	]);
const { OnboardingLlmSetupStep } = await import("./OnboardingLlmSetupStep");

const LLM_CATALOG_INITIAL = useLlmCatalogStore.getInitialState();
const OLLAMA_LIBRARY_INITIAL = useOllamaLibraryStore.getInitialState();
const MODEL_STATE_INITIAL = useModelStateStore.getInitialState();

function freshSettings() {
	return structuredClone(DEFAULT_SETTINGS);
}

function renderStep() {
	return render(
		<IntlProvider>
			<OnboardingLlmSetupStep />
		</IntlProvider>,
	);
}

beforeEach(() => {
	detectOllamaResult = { installed: true };
	fetchOllamaModelsResult = { models: [], reachable: true };
	detectOllamaMock.mockClear();
	fetchOllamaModelsMock.mockClear();
	useSettingsStore.setState({ settings: freshSettings(), isLoaded: true });
	useLlmCatalogStore.setState(LLM_CATALOG_INITIAL, true);
	useOllamaLibraryStore.setState(OLLAMA_LIBRARY_INITIAL, true);
	useModelStateStore.setState(MODEL_STATE_INITIAL, true);
});

afterEach(() => {
	detectOllamaResult = { installed: false };
	fetchOllamaModelsResult = {
		models: [],
		reachable: false,
		error: "IPC unavailable",
	};
	useSettingsStore.setState({ settings: freshSettings(), isLoaded: true });
	useLlmCatalogStore.setState(LLM_CATALOG_INITIAL, true);
	useOllamaLibraryStore.setState(OLLAMA_LIBRARY_INITIAL, true);
	useModelStateStore.setState(MODEL_STATE_INITIAL, true);
});

describe("OnboardingLlmSetupStep", () => {
	test("keeps rendering when Ollama detection resolves as installed", async () => {
		renderStep();

		expect(screen.getByText(/Looking for Ollama/)).toBeDefined();

		await waitFor(() => {
			expect(screen.getByText("Ollama is running locally.")).toBeDefined();
		});
		expect(screen.getByText("Clean up dictation")).toBeDefined();
		expect(
			screen.getByText(
				"You can finish setup without it and enable LLM cleanup later from Settings.",
			),
		).toBeDefined();
	});
});
