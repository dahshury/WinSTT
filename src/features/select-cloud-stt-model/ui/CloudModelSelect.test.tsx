import { afterEach, describe, expect, mock, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "@/app/providers/IntlProvider";
import { useSettingsStore } from "@/entities/setting";
import { CloudModelSelect } from "./CloudModelSelect";

const initialSettings = useSettingsStore.getState().settings;

function setKeys(openai: string, elevenlabs: string): void {
	useSettingsStore.setState({
		settings: {
			...initialSettings,
			integrations: {
				openai: { apiKey: openai, verified: null, lastVerifiedAt: null },
				elevenlabs: {
					apiKey: elevenlabs,
					verified: null,
					lastVerifiedAt: null,
				},
			},
		},
	});
}

afterEach(() => {
	useSettingsStore.setState({ settings: initialSettings });
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
		setKeys("", "");
		renderIt();
		expect(screen.getByRole("button").textContent ?? "").toContain(
			"Configure key",
		);
	});

	test("renders the static cloud catalog when a provider key is present", () => {
		setKeys("sk-openai", "");
		// The catalog is built at module load from the AI SDK's generated ids +
		// curated metadata — no fetch, so the picker renders synchronously.
		expect(() => renderIt("openai:gpt-4o-mini-transcribe")).not.toThrow();
	});

	test("self-heals a persisted model that's no longer in the catalog", async () => {
		setKeys("sk-openai", "");
		const onSelect = mock(() => undefined);
		// A dated gpt-4o snapshot the generator now filters out (it 400s on the
		// AI SDK's verbose_json) — the picker must auto-pick the working default.
		render(
			<IntlProvider>
				<CloudModelSelect
					onSelect={onSelect}
					selectedId="openai:gpt-4o-mini-transcribe-2025-12-15"
				/>
			</IntlProvider>,
		);
		await waitFor(() =>
			expect(onSelect).toHaveBeenCalledWith("openai:gpt-4o-mini-transcribe"),
		);
	});
});
