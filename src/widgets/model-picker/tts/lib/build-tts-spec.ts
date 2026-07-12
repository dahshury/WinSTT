import {
	AudioWave02Icon,
	Copy01Icon,
	DashboardSpeed02Icon,
	GlobeIcon,
	NeuralNetworkIcon,
	SparklesIcon,
	StarIcon,
	UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import type { TtsModelInfo } from "@/entities/tts-catalog";
import { publicAsset } from "@/shared/lib/public-asset";
import type {
	ModelSpec,
	ModelSpecFact,
	ModelSpecFeature,
	ModelSpecStat,
} from "@/shared/ui/model-spec-card";
import { formatLanguageSummary, specStat } from "../../lib/model-spec-format";
import {
	cloningLabel,
	getEngineConfig,
	getEngineLogoSrc,
	getEngineMaker,
	ttsLanguageMeta,
} from "./tts-helpers";

/** Build the hover-card spec for a TTS voice model from its catalog row. */
export function buildTtsSpec(model: TtsModelInfo): ModelSpec {
	const config = getEngineConfig(model.engine);
	const logo = getEngineLogoSrc(model.engine);

	const features: ModelSpecFeature[] = [];
	if (model.languages.length > 1) {
		features.push({
			key: "multilingual",
			icon: GlobeIcon,
			label: "Multilingual",
			description: ttsLanguageMeta(model.languages).tooltip,
		});
	}
	const cloning = cloningLabel(model.cloning);
	if (cloning) {
		features.push({
			key: "cloning",
			icon: Copy01Icon,
			label: cloning.label,
			description: cloning.tooltip,
		});
	}
	if (model.voiceDesign) {
		features.push({
			key: "voice-design",
			icon: SparklesIcon,
			label: "Voice design",
			description: "The voice is described with a free-text prompt.",
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
	facts.push({
		key: "voices",
		label: "Voices",
		value: model.numVoices === 1 ? "1 voice" : `${model.numVoices} voices`,
		icon: UserMultiple02Icon,
	});
	if (model.paramCountM > 0) {
		facts.push({
			key: "params",
			label: "Parameters",
			value: `${model.paramCountM}M`,
			icon: NeuralNetworkIcon,
		});
	}
	if (model.sampleRate > 0) {
		facts.push({
			key: "sample-rate",
			label: "Sample rate",
			value: `${(model.sampleRate / 1000).toFixed(model.sampleRate % 1000 === 0 ? 0 : 1)} kHz`,
			icon: AudioWave02Icon,
		});
	}

	const stats: ModelSpecStat[] = [];
	const quality = specStat("quality", "Quality", model.qualityScore, StarIcon);
	if (quality) {
		stats.push(quality);
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
		makerLabel: model.maker || getEngineMaker(model.engine),
		makerLogoSrc: logo ? publicAsset(logo) : null,
		makerIcon: config.icon,
		description: model.description || undefined,
		features,
		facts,
		stats: stats.length > 0 ? stats : undefined,
	};
}
