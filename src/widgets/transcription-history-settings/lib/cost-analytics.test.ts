import { describe, expect, test } from "bun:test";
import {
	type CostAnalyticsLabels,
	computeCostAnalytics,
	type ResolveMaker,
} from "./cost-analytics";
import type {
	TranscriptionHistoryEntry,
	TtsHistoryEntry,
} from "../model/history-store";

const LABELS: CostAnalyticsLabels = {
	speechToText: "Speech-to-text",
	languageModel: "Language model",
	textToSpeech: "Text-to-speech",
	other: "Other",
};

// Maker resolver mirroring the panel's: strip cloud prefix, map the vendor.
const resolveMaker: ResolveMaker = (modelId) => {
	if (modelId.startsWith("elevenlabs:")) {
		return { author: "ElevenLabs", logoSrc: "/el.svg" };
	}
	const bare = modelId.replace(/^openrouter:/, "");
	const vendor = bare.split("/")[0] ?? "";
	if (!vendor) {
		return null;
	}
	return { author: vendor, logoSrc: `/${vendor}.svg` };
};

function stt(
	id: string,
	sttCostUsd: number,
	extra: Partial<TranscriptionHistoryEntry> = {},
): TranscriptionHistoryEntry {
	return {
		durationMs: 1000,
		id,
		sttCostUsd,
		sttModel: "openrouter:openai/whisper-1",
		text: `t-${id}`,
		timestamp: Date.UTC(2026, 0, 2),
		wordCount: 3,
		...extra,
	};
}

function ttsRun(
	id: string,
	costUsd: number,
	extra: Partial<TtsHistoryEntry> = {},
): TtsHistoryEntry {
	return {
		characters: 40,
		costUsd,
		id,
		model: "openrouter:hexgrad/kokoro-82m",
		text: `tts-${id}`,
		timestamp: Date.UTC(2026, 0, 3),
		wordCount: 2,
		...extra,
	};
}

describe("computeCostAnalytics", () => {
	test("returns an empty analytics with total 0 for local-only history", () => {
		const local: TranscriptionHistoryEntry = {
			durationMs: 1000,
			id: "local",
			text: "local",
			timestamp: 1,
			wordCount: 1,
		};
		const a = computeCostAnalytics([local], [], resolveMaker, LABELS);
		expect(a.total).toBe(0);
		expect(a.byModality).toEqual([]);
		expect(a.byModel).toEqual([]);
		expect(a.daily).toEqual([]);
	});

	test("sums STT + LLM + TTS into the modality split and total", () => {
		const entries = [
			stt("a", 0.0005, {
				llmCostUsd: 0.0006,
				llmModel: "openai/gpt-4o-mini",
			}),
		];
		const tts = [ttsRun("t", 0.000_03)];
		const a = computeCostAnalytics(entries, tts, resolveMaker, LABELS);
		expect(a.total).toBeCloseTo(0.001_13, 8);
		expect(a.stt).toBeCloseTo(0.0005, 8);
		expect(a.llm).toBeCloseTo(0.0006, 8);
		expect(a.tts).toBeCloseTo(0.000_03, 8);
		// Modality slices sorted by cost desc, all three present.
		expect(a.byModality.map((s) => s.key)).toEqual(["llm", "stt", "tts"]);
		// Percentages are whole numbers of the total.
		const llmSlice = a.byModality.find((s) => s.key === "llm");
		expect(llmSlice?.pct).toBe(53);
	});

	test("attributes providers from the model prefix (LLM path is OpenRouter)", () => {
		const entries = [
			stt("a", 0.0005, { llmCostUsd: 0.0006, llmModel: "openai/gpt-4o-mini" }),
		];
		const tts = [
			ttsRun("t", 0.0002, {
				model: "elevenlabs:scribe_v1",
				costUsd: 0.0002,
				costIsEstimate: true,
			}),
		];
		const a = computeCostAnalytics(entries, tts, resolveMaker, LABELS);
		const providers = Object.fromEntries(
			a.byProvider.map((p) => [p.label, p.cost]),
		);
		expect(providers["OpenRouter"]).toBeCloseTo(0.0011, 8); // STT + LLM
		expect(providers["ElevenLabs"]).toBeCloseTo(0.0002, 8);
	});

	test("marks estimated components with the estimate flag", () => {
		const entries = [stt("a", 0.0005, { sttCostIsEstimate: true })];
		const a = computeCostAnalytics(entries, [], resolveMaker, LABELS);
		expect(a.estimated).toBe(true);
		expect(a.byModality[0]?.estimate).toBe(true);
	});

	test("groups spend by model and rolls the tail past six into Other", () => {
		const entries = Array.from({ length: 8 }, (_, i) =>
			stt(`m${i}`, (i + 1) / 100_000, {
				sttModel: `openrouter:vendor${i}/model${i}`,
			}),
		);
		const a = computeCostAnalytics(entries, [], resolveMaker, LABELS);
		expect(a.byModel).toHaveLength(6);
		expect(a.byModel.at(-1)?.key).toBe("__other__");
		// Bare model label drops the cloud prefix.
		expect(a.byModel[0]?.label).toBe("vendor7/model7");
	});

	test("groups spend by maker for the radar (cost as the magnitude)", () => {
		const entries = [
			stt("a", 0.001, { sttModel: "openrouter:openai/whisper-1" }),
		];
		const tts = [ttsRun("t", 0.0004)]; // hexgrad
		const a = computeCostAnalytics(entries, tts, resolveMaker, LABELS);
		const byMaker = Object.fromEntries(
			a.byMaker.map((m) => [m.label, m.count]),
		);
		expect(byMaker["openai"]).toBeCloseTo(0.001, 8);
		expect(byMaker["hexgrad"]).toBeCloseTo(0.0004, 8);
	});

	test("daily totals are chronological and sum every stage per day", () => {
		const entries = [
			stt("a", 0.001, { timestamp: Date.UTC(2026, 0, 2) }),
			stt("b", 0.002, {
				timestamp: Date.UTC(2026, 0, 4),
				llmCostUsd: 0.001,
				llmModel: "openai/gpt-4o-mini",
			}),
		];
		const a = computeCostAnalytics(entries, [], resolveMaker, LABELS);
		// Two distinct days; day 2 = 0.001, day 4 = 0.003.
		expect(a.daily).toHaveLength(2);
		expect(a.daily[0]).toBeCloseTo(0.001, 8);
		expect(a.daily[1]).toBeCloseTo(0.003, 8);
	});
});
