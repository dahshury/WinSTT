import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import type { OpenRouterModel } from "@/shared/api/models";
import { CloudSelectedSummary } from "./CloudSelectedSummary";

const openrouterModels: OpenRouterModel[] = [
	{
		id: "microsoft/mai-transcribe-1.5",
		name: "Microsoft: MAI-Transcribe 1.5",
		maker: "microsoft",
		model_name: "mai-transcribe-1.5",
		architecture: {
			input_modalities: ["audio"],
			output_modalities: ["transcription"],
		},
		accuracy_score: 0.88,
		speed_score: 0.72,
	},
];

describe("CloudSelectedSummary", () => {
	test("OpenRouter selection renders the rich maker + score card", () => {
		const { container } = render(
			<CloudSelectedSummary
				models={openrouterModels}
				placeholder="Select a model"
				selectedId="openrouter:microsoft/mai-transcribe-1.5"
			/>,
		);
		const text = container.textContent ?? "";
		expect(text).toContain("Microsoft");
		expect(text).toContain("88%");
		expect(text).toContain("72%");
		expect(text).not.toContain("Select a model");
	});

	test("ElevenLabs selection renders the ElevenLabs maker + model name", () => {
		const { container } = render(
			<CloudSelectedSummary
				models={openrouterModels}
				placeholder="Select a model"
				selectedId="elevenlabs:scribe_v1"
			/>,
		);
		const text = container.textContent ?? "";
		expect(text).toContain("ElevenLabs");
		expect(text).toContain("Scribe v1");
	});

	test("falls back to the placeholder when the selection can't be resolved", () => {
		// OpenRouter id not present in the (empty here) live-scan list — e.g. the
		// scan hasn't landed yet.
		const { container } = render(
			<CloudSelectedSummary
				models={[]}
				placeholder="Select a model"
				selectedId="openrouter:microsoft/mai-transcribe-1.5"
			/>,
		);
		expect(container.textContent).toContain("Select a model");
	});
});
