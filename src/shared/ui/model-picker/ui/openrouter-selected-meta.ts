import {
	BookOpen02Icon,
	DashboardSpeed02Icon,
	Image01Icon,
	Mic01Icon,
	Target02Icon,
} from "@hugeicons/core-free-icons";
import type { OpenRouterModel } from "@/shared/api/models";
import { formatContextLength } from "../lib/model-selector-display-utils";
import type { SelectedModelMetaItem } from "./SelectedModelSummary";

function scorePercent(score: number): number {
	return Math.round(Math.max(0, Math.min(1, score)) * 100);
}

/**
 * The connected spec badge for a selected OpenRouter model — the SAME
 * icon+label segment vocabulary the STT and Ollama triggers use, so every
 * closed picker reads identically. Only facts the catalog actually carries
 * become segments: input-modality capabilities first (icon-only), then the
 * transcription accuracy / speed guidance scores (the OpenRouter STT rows),
 * then the context window (LLM rows). A field that is absent is simply
 * skipped, so an ordinary chat model shows a leaner badge than a scored STT
 * model rather than a row of empty slots.
 */
export function openrouterSelectedMeta(
	model: OpenRouterModel,
): SelectedModelMetaItem[] {
	const items: SelectedModelMetaItem[] = [];
	const inputs = model.architecture?.input_modalities ?? [];
	if (inputs.includes("audio")) {
		items.push({
			key: "audio",
			label: "",
			icon: Mic01Icon,
			tone: "teal",
			title: "Speech-to-text",
			description: "Transcribes spoken audio into text.",
		});
	}
	if (inputs.includes("image")) {
		items.push({
			key: "vision",
			label: "",
			icon: Image01Icon,
			tone: "accent",
			title: "Vision",
			description: "Accepts image input alongside text.",
		});
	}
	if (typeof model.accuracy_score === "number" && model.accuracy_score > 0) {
		items.push({
			key: "accuracy",
			// The target/bullseye glyph carries the "accuracy" meaning — a bare
			// "A88" leaned on an opaque letter prefix, so show just the score.
			label: `${scorePercent(model.accuracy_score)}%`,
			icon: Target02Icon,
			tone: "accent",
			title: "Accuracy score",
			description:
				"Relative transcription-accuracy guidance (higher is better).",
		});
	}
	if (typeof model.speed_score === "number" && model.speed_score > 0) {
		items.push({
			key: "speed",
			// The speedometer glyph carries the "speed" meaning — no "S" prefix.
			label: `${scorePercent(model.speed_score)}%`,
			icon: DashboardSpeed02Icon,
			tone: "success",
			title: "Speed score",
			description: "Relative throughput guidance (higher is faster).",
		});
	}
	if (typeof model.context_length === "number" && model.context_length > 0) {
		items.push({
			key: "context",
			label: formatContextLength(model.context_length),
			icon: BookOpen02Icon,
			tone: "neutral",
			title: "Context window",
		});
	}
	return items;
}
