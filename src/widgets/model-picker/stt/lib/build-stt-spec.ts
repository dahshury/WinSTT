import {
	DashboardSpeed02Icon,
	GlobeIcon,
	LanguageSkillIcon,
	LiveStreaming02Icon,
	NeuralNetworkIcon,
	Target02Icon,
} from "@hugeicons/core-free-icons";
import {
	type ModelInfo,
	supportsTranslateToEnglish,
} from "@/entities/model-catalog";
import { publicAsset } from "@/shared/lib/public-asset";
import type {
	ModelSpec,
	ModelSpecFact,
	ModelSpecFeature,
	ModelSpecStat,
} from "@/shared/ui/model-spec-card";
import { formatLanguageSummary, specStat } from "../../lib/model-spec-format";
import { getAuthorLabel, getFamilyConfig } from "./family-helpers";
import { formatLanguages } from "./language-names";
import { variantMeta } from "./variant-helpers";

/**
 * Build the hover-card spec for an STT model from its catalog row. Local ONNX
 * models have no online benchmark source, so the perf bars (author-published
 * accuracy/speed) stand in for the cloud card's benchmark donuts.
 */
export function buildSttSpec(model: ModelInfo): ModelSpec {
	const config = getFamilyConfig(model.family);
	const { multilingual } = variantMeta(model);

	const features: ModelSpecFeature[] = [];
	if (multilingual) {
		features.push({
			key: "multilingual",
			icon: GlobeIcon,
			label: "Multilingual",
			description:
				model.languages.length > 0
					? `Supports ${model.languages.length} languages: ${formatLanguages(model.languages)}`
					: "Transcribes many languages, not just English.",
		});
	}
	if (model.nativeStreaming) {
		features.push({
			key: "streaming",
			icon: LiveStreaming02Icon,
			label: "Streaming",
			description: "Feeds live audio into a stateful streaming decoder.",
		});
	}
	if (supportsTranslateToEnglish(model)) {
		const canary = model.id.startsWith("nemo-canary-");
		features.push({
			key: "translate",
			icon: LanguageSkillIcon,
			label: "Translation",
			description: canary
				? "Translates speech between its languages in a single decode — pick the output language on the Transcriptions tab."
				: "Translates non-English speech to English in a single decode — enable it on the Transcriptions tab.",
		});
	}

	const facts: ModelSpecFact[] = [];
	const languageSummary = formatLanguageSummary(model.languages);
	if (languageSummary) {
		facts.push({
			key: "languages",
			label: "Languages",
			value: languageSummary,
			icon: GlobeIcon,
		});
	}
	if (model.sizeLabel) {
		facts.push({
			key: "params",
			label: "Parameters",
			value: model.sizeLabel,
			icon: NeuralNetworkIcon,
		});
	}

	const stats: ModelSpecStat[] = [];
	const accuracy = specStat(
		"accuracy",
		"Accuracy",
		model.accuracyScore,
		Target02Icon,
	);
	if (accuracy) {
		stats.push(accuracy);
	}
	const speed = specStat(
		"speed",
		"Speed",
		model.speedScore,
		DashboardSpeed02Icon,
	);
	if (speed) {
		stats.push(speed);
	}

	return {
		name: model.displayName,
		makerLabel: getAuthorLabel(model.family),
		makerLogoSrc: config.logoSrc ? publicAsset(config.logoSrc) : null,
		makerIcon: config.icon,
		description: model.description || undefined,
		features,
		facts,
		stats: stats.length > 0 ? stats : undefined,
	};
}
