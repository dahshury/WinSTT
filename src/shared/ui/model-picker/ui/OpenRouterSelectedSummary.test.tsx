import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import type { OpenRouterModel } from "@/shared/api/models";
import { openrouterSelectedMeta } from "./openrouter-selected-meta";
import { OpenRouterSelectedSummary } from "./OpenRouterSelectedSummary";

const base: OpenRouterModel = {
	id: "microsoft/mai-transcribe-1.5",
	name: "Microsoft: MAI-Transcribe 1.5",
	maker: "microsoft",
	model_name: "mai-transcribe-1.5",
};

describe("openrouterSelectedMeta", () => {
	test("STT row → audio capability + accuracy + speed segments", () => {
		const meta = openrouterSelectedMeta({
			...base,
			architecture: {
				input_modalities: ["audio"],
				output_modalities: ["transcription"],
			},
			accuracy_score: 0.88,
			speed_score: 0.72,
		});
		expect(meta.map((m) => m.key)).toEqual(["audio", "accuracy", "speed"]);
		// The icon carries the accuracy/speed meaning, so the label is just the
		// score — no opaque "A"/"S" prefix. The glyph disambiguates the two.
		const accuracy = meta.find((m) => m.key === "accuracy");
		const speed = meta.find((m) => m.key === "speed");
		expect(accuracy?.label).toBe("88%");
		expect(accuracy?.icon).toBeDefined();
		expect(accuracy?.tone).toBe("accent");
		expect(speed?.label).toBe("72%");
		expect(speed?.icon).toBeDefined();
		expect(speed?.tone).toBe("success");
	});

	test("chat row with vision + context → vision + context, no scores", () => {
		const meta = openrouterSelectedMeta({
			id: "google/gemma",
			name: "Gemma",
			maker: "google",
			architecture: {
				input_modalities: ["text", "image"],
				output_modalities: ["text"],
			},
			context_length: 131_072,
		});
		expect(meta.map((m) => m.key)).toEqual(["vision", "context"]);
	});

	test("scores of 0 or missing are skipped (no empty segments)", () => {
		expect(openrouterSelectedMeta(base)).toEqual([]);
		expect(
			openrouterSelectedMeta({ ...base, accuracy_score: 0, speed_score: 0 }),
		).toEqual([]);
	});
});

describe("OpenRouterSelectedSummary", () => {
	test("renders the maker, formatted name and score badges", () => {
		const { container } = render(
			<OpenRouterSelectedSummary
				model={{
					...base,
					architecture: {
						input_modalities: ["audio"],
						output_modalities: ["transcription"],
					},
					accuracy_score: 0.88,
					speed_score: 0.72,
				}}
			/>,
		);
		const text = container.textContent ?? "";
		expect(text).toContain("Microsoft");
		expect(text).toContain("88%");
		expect(text).toContain("72%");
		// The maker logo pill resolves a bundled provider icon.
		const logo = container.querySelector("img");
		expect(logo?.getAttribute("src")).toContain("microsoft");
	});
});
