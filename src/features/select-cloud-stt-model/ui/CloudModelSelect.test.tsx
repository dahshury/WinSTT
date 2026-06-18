import { afterEach, describe, expect, mock, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useOpenRouterSttCatalogStore } from "@/entities/cloud-stt-provider";
import { useSettingsStore } from "@/entities/setting";
import { CloudModelSelect } from "./CloudModelSelect";

const initialSettings = useSettingsStore.getState().settings;
const LLM_OPENROUTER_UI_STORAGE_KEY = "winstt:model-picker:openrouter-ui";
const STT_OPENROUTER_UI_STORAGE_KEY = "winstt:model-picker:openrouter-stt-ui";

function setKeys(elevenlabs: string): void {
	useSettingsStore.setState({
		settings: {
			...initialSettings,
			integrations: {
				elevenlabs: {
					apiKey: elevenlabs,
					verified: null,
					lastVerifiedAt: null,
				},
			},
		},
	});
}

/** OpenRouter STT shares the single LLM key (not an integrations entry). */
function setOpenrouterKey(key: string): void {
	useSettingsStore.setState({
		settings: {
			...initialSettings,
			llm: { ...initialSettings.llm, openrouterApiKey: key },
		},
	});
}

/** Pre-seed the live OpenRouter STT scan store as already-loaded so the
 *  picker's mount-scan early-returns instead of hitting the (mock-less) IPC. */
function seedOpenrouterModels(
	models: {
		accuracy_score?: number;
		id: string;
		name: string;
		speed_score?: number;
	}[],
): void {
	useOpenRouterSttCatalogStore.setState({
		models: models.map((model) => ({
			...model,
			accuracy_score: model.accuracy_score ?? 0.5,
			speed_score: model.speed_score ?? 0.5,
		})),
		isLoaded: true,
		isScanning: false,
		isReachable: true,
		error: null,
	});
}

afterEach(() => {
	useSettingsStore.setState({ settings: initialSettings });
	useOpenRouterSttCatalogStore.setState({
		models: [],
		isLoaded: false,
		isScanning: false,
		isReachable: false,
		error: null,
	});
	window.localStorage.removeItem(LLM_OPENROUTER_UI_STORAGE_KEY);
	window.localStorage.removeItem(STT_OPENROUTER_UI_STORAGE_KEY);
});

function renderIt(selectedId = "") {
	return render(
		<IntlProvider>
			<CloudModelSelect onSelect={() => undefined} selectedId={selectedId} />
		</IntlProvider>,
	);
}

describe("CloudModelSelect", () => {
	test("shows the Configure-key affordance when no provider has a key", () => {
		setKeys("");
		renderIt();
		expect(screen.getByRole("button").textContent ?? "").toContain(
			"Configure key",
		);
	});

	test("emptyState='disabled' shows an inert selector instead of the Configure-key link", () => {
		// Onboarding sets the key on the same page, so the link-into-Settings
		// affordance is wrong there — a disabled selector should render instead.
		setKeys("");
		render(
			<IntlProvider>
				<CloudModelSelect
					emptyState="disabled"
					onSelect={() => undefined}
					selectedId=""
				/>
			</IntlProvider>,
		);
		expect(screen.queryByText(/Configure key/)).toBeNull();
		const input = screen.getByPlaceholderText("Cloud models");
		expect((input as HTMLInputElement).disabled).toBe(true);
	});

	test("renders the static cloud catalog when a provider key is present", () => {
		setKeys("sk-eleven");
		// The catalog is built at module load from the AI SDK's generated ids +
		// curated metadata — no fetch, so the picker renders synchronously.
		expect(() => renderIt("elevenlabs:scribe_v1")).not.toThrow();
	});

	test("renders OpenRouter rows from the live scan and self-heals the bare 'openrouter:' default", async () => {
		setOpenrouterKey("sk-or-test");
		seedOpenrouterModels([
			{ id: "microsoft/mai-transcribe-1.5", name: "MAI-Transcribe 1.5" },
			{ id: "nvidia/parakeet-tdt-0.6b-v3", name: "Parakeet TDT" },
		]);
		const onSelect = mock(() => undefined);
		const { container } = render(
			<IntlProvider>
				<CloudModelSelect onSelect={onSelect} selectedId="openrouter:" />
			</IntlProvider>,
		);
		expect(
			container.querySelector('[data-slot="openrouter-model-selector"]'),
		).not.toBeNull();
		// The bare prefix is not a concrete option, so the picker self-heals to the
		// first live-scanned transcription model.
		await waitFor(() =>
			expect(onSelect).toHaveBeenCalledWith(
				"openrouter:microsoft/mai-transcribe-1.5",
			),
		);
	});

	test("does not inherit LLM OpenRouter picker filters", async () => {
		window.localStorage.setItem(
			LLM_OPENROUTER_UI_STORAGE_KEY,
			JSON.stringify({
				searchQuery: "",
				selectedEndpointProvider: null,
				selectedMakers: ["openai"],
				selectedParameters: [],
				selectedVariant: null,
				sortKey: null,
			}),
		);
		setOpenrouterKey("sk-or-test");
		seedOpenrouterModels([
			{ id: "microsoft/mai-transcribe-1.5", name: "MAI-Transcribe 1.5" },
		]);
		render(
			<IntlProvider>
				<CloudModelSelect
					defaultOpen
					onSelect={() => undefined}
					selectedId="openrouter:microsoft/mai-transcribe-1.5"
				/>
			</IntlProvider>,
		);

		await waitFor(() => {
			const sttState = JSON.parse(
				window.localStorage.getItem(STT_OPENROUTER_UI_STORAGE_KEY) ?? "{}",
			);
			expect(sttState.selectedMakers).toEqual([]);
		});
		const llmState = JSON.parse(
			window.localStorage.getItem(LLM_OPENROUTER_UI_STORAGE_KEY) ?? "{}",
		);
		expect(llmState.selectedMakers).toEqual(["openai"]);
	});

	test("self-heals a persisted model that's no longer in the catalog", async () => {
		setKeys("sk-eleven");
		const onSelect = mock(() => undefined);
		// A persisted ElevenLabs id the curated/generated catalog no longer lists —
		// the picker must auto-pick the working default.
		render(
			<IntlProvider>
				<CloudModelSelect
					onSelect={onSelect}
					selectedId="elevenlabs:scribe_v0_retired"
				/>
			</IntlProvider>,
		);
		await waitFor(() =>
			expect(onSelect).toHaveBeenCalledWith("elevenlabs:scribe_v1"),
		);
	});
});
