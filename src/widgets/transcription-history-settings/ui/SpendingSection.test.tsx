import { describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach } from "bun:test";
import { IntlProvider } from "@/app/providers/IntlProvider";
import type { CostAnalytics } from "../lib/cost-analytics";
import { SpendingSection } from "./SpendingSection";

afterEach(cleanup);

const ANALYTICS: CostAnalytics = {
	total: 0.001_13,
	estimated: true,
	stt: 0.0005,
	llm: 0.0006,
	tts: 0.000_03,
	byModality: [
		{
			key: "llm",
			label: "Language model",
			cost: 0.0006,
			pct: 53,
			estimate: false,
			color: "var(--color-activity)",
		},
		{
			key: "stt",
			label: "Speech-to-text",
			cost: 0.0005,
			pct: 44,
			estimate: false,
			color: "var(--color-history-stt)",
		},
		{
			key: "tts",
			label: "Text-to-speech",
			cost: 0.000_03,
			pct: 3,
			estimate: true,
			color: "var(--color-history-tts)",
		},
	],
	byProvider: [
		{
			key: "openrouter",
			label: "OpenRouter",
			cost: 0.0011,
			pct: 97,
			estimate: false,
			color: "var(--color-activity)",
		},
		{
			key: "elevenlabs",
			label: "ElevenLabs",
			cost: 0.000_03,
			pct: 3,
			estimate: true,
			color: "color-mix(in oklch, var(--color-activity) 56%, black)",
		},
	],
	byModel: [
		{
			key: "openrouter:openai/gpt-4o-mini",
			label: "openai/gpt-4o-mini",
			cost: 0.0006,
			pct: 53,
			estimate: false,
		},
		{
			key: "openrouter:openai/whisper-1",
			label: "openai/whisper-1",
			cost: 0.0005,
			pct: 44,
			estimate: false,
		},
	],
	byMaker: [],
	daily: [0.0005, 0.0006, 0.000_03],
};

describe("SpendingSection", () => {
	test("renders the total, modality legend, and the estimated hint", () => {
		render(
			<IntlProvider>
				<SpendingSection analytics={ANALYTICS} />
			</IntlProvider>,
		);
		// Total appears with the estimate tilde (in the card + both donut centers).
		expect(screen.getAllByText("~$0.0011").length).toBeGreaterThan(0);
		// Modality + provider donuts render as labelled charts.
		expect(screen.getByLabelText("Spend by type")).not.toBeNull();
		expect(screen.getByLabelText("Spend by provider")).not.toBeNull();
		// Legend shows both providers.
		expect(screen.getByText("OpenRouter")).not.toBeNull();
		expect(screen.getByText("ElevenLabs")).not.toBeNull();
		// Cost-by-model bar shows the bare model id.
		expect(screen.getByText("openai/whisper-1")).not.toBeNull();
		// Estimated footnote is present.
		expect(screen.getByText(/estimated/i, { exact: false })).not.toBeNull();
	});

	test("collapses redundant breakdowns when spend has a single source", () => {
		// One modality, one provider, one model → every breakdown would be a
		// 100% slice echoing the total, so only the Total card should render.
		const single: CostAnalytics = {
			total: 0.0065,
			estimated: false,
			stt: 0.0065,
			llm: 0,
			tts: 0,
			byModality: [
				{
					key: "stt",
					label: "Speech-to-text",
					cost: 0.0065,
					pct: 100,
					estimate: false,
					color: "var(--color-history-stt)",
				},
			],
			byProvider: [
				{
					key: "openrouter",
					label: "OpenRouter",
					cost: 0.0065,
					pct: 100,
					estimate: false,
					color: "var(--color-activity)",
				},
			],
			byModel: [
				{
					key: "openrouter:microsoft/mai-transcribe-1.5",
					label: "microsoft/mai-transcribe-1.5",
					cost: 0.0065,
					pct: 100,
					estimate: false,
				},
			],
			byMaker: [],
			daily: [0.0065],
		};
		render(
			<IntlProvider>
				<SpendingSection analytics={single} />
			</IntlProvider>,
		);
		// The Total card is present…
		expect(screen.getAllByText("$0.0065").length).toBeGreaterThan(0);
		// …but the single-slice donuts and the model bars are omitted.
		expect(screen.queryByLabelText("Spend by type")).toBeNull();
		expect(screen.queryByLabelText("Spend by provider")).toBeNull();
		expect(screen.queryByText("microsoft/mai-transcribe-1.5")).toBeNull();
		// No per-type subtotal row either — it would just repeat the total.
		expect(screen.queryByText("OpenRouter")).toBeNull();
	});

	test("omits a modality subtotal row when that stage had no spend", () => {
		const noTts: CostAnalytics = {
			...ANALYTICS,
			tts: 0,
			byModality: ANALYTICS.byModality.filter((s) => s.key !== "tts"),
		};
		render(
			<IntlProvider>
				<SpendingSection analytics={noTts} />
			</IntlProvider>,
		);
		// The Text-to-speech subtotal row (in the summary card) is gone, but the
		// modality label may still appear elsewhere — assert the card subtotal
		// specifically by its icon-labelled row absence via the donut legend only.
		expect(screen.queryByText("Text-to-speech")).toBeNull();
	});
});
