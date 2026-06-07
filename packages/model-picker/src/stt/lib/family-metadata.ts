import {
	AiChipIcon,
	AudioWave02Icon,
	CpuIcon,
	FlashIcon,
	FolderLibraryIcon,
	Radio01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { ModelInfo } from "@/entities/model-catalog";

export type FamilyKey = ModelInfo["family"];

interface FamilyConfig {
	/** Tailwind classes for the family chip (background + foreground). */
	chip: string;
	/** HugeIcons fallback when no brand `logoSrc` is available. */
	icon: IconSvgElement;
	label: string;
	/** Public path to a brand-logo PNG/SVG. When set, the brand logo is shown instead of the HugeIcon. */
	logoSrc?: string;
}

const FAMILY_CONFIG: Record<FamilyKey, FamilyConfig> = {
	whisper: {
		icon: AudioWave02Icon,
		label: "Whisper",
		chip: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
		logoSrc: "/provider-icons/openai.svg",
	},
	"lite-whisper": {
		icon: AudioWave02Icon,
		label: "Lite-Whisper",
		chip: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
		logoSrc: "/provider-icons/openai.svg",
	},
	nemo: {
		icon: AiChipIcon,
		label: "NeMo",
		chip: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
		logoSrc: "/provider-icons/nvidia.svg",
	},
	granite: {
		icon: AiChipIcon,
		label: "Granite",
		chip: "bg-stone-500/15 text-stone-600 dark:text-stone-400",
		logoSrc: "/provider-icons/ibm-granite.svg",
	},
	gigaam: {
		icon: Radio01Icon,
		label: "GigaAM",
		chip: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
		// Sber/GigaChat swirl emblem (single-path SVG, recolored white for the
		// dark UI). The earlier HF org avatar was a full-bleed opaque tile that
		// read as a solid rectangle in the chip.
		logoSrc: "/provider-icons/sber.svg",
	},
	kaldi: {
		icon: CpuIcon,
		label: "Kaldi",
		chip: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
		// Vosk's transparent diamond mark.
		logoSrc: "/provider-icons/vosk.png",
	},
	"t-one": {
		icon: FlashIcon,
		label: "T-One",
		chip: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
		// T-Bank's shield emblem (transparent SVG) — the HF org avatar was an
		// opaque dark tile that read as a solid rectangle in the chip.
		logoSrc: "/provider-icons/t-bank.svg",
	},
	moonshine: {
		icon: FlashIcon,
		label: "Moonshine",
		chip: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400",
		// Useful Sensors' Moonshine crescent + waveform mark (transparent).
		logoSrc: "/provider-icons/moonshine.png",
	},
	cohere: {
		icon: AiChipIcon,
		label: "Cohere",
		chip: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
		logoSrc: "/provider-icons/cohere.svg",
	},
	sense_voice: {
		icon: AudioWave02Icon,
		label: "SenseVoice",
		chip: "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400",
		logoSrc: "/provider-icons/funaudiollm.png",
	},
	dolphin: {
		icon: AudioWave02Icon,
		label: "Dolphin",
		chip: "bg-teal-500/15 text-teal-600 dark:text-teal-400",
		// DataoceanAI's wordmark (transparent). It's a wide wordmark, so the
		// logo `<img>` uses object-contain (not cover) to show it whole.
		logoSrc: "/provider-icons/dataoceanai.png",
	},
	custom: {
		icon: FolderLibraryIcon,
		label: "Custom",
		chip: "bg-slate-500/15 text-slate-600 dark:text-slate-400",
		// No brand logo — these are user-provided drops, not first-party models.
	},
};

export function getFamilyConfig(family: FamilyKey): FamilyConfig {
	return FAMILY_CONFIG[family];
}

/** The org/maker behind each model family — drives the group header. */
const FAMILY_AUTHOR: Record<FamilyKey, string> = {
	whisper: "OpenAI",
	"lite-whisper": "Efficient-Speech",
	nemo: "NVIDIA",
	granite: "IBM",
	gigaam: "Sber Salute",
	kaldi: "Alpha Cephei",
	"t-one": "T-Tech",
	moonshine: "Useful Sensors",
	cohere: "Cohere",
	sense_voice: "FunAudioLLM",
	dolphin: "DataoceanAI",
	custom: "Your Models",
};

export function getAuthorLabel(family: FamilyKey): string {
	return FAMILY_AUTHOR[family];
}

/**
 * Extra synonyms that should also match the family in search — covers common
 * brand nicknames (e.g. "tinkoff" for T-Tech, "sber" for Sber Salute, "vosk"
 * for Kaldi/Alpha Cephei) so users can type whatever brand they know.
 */
const FAMILY_SEARCH_ALIASES: Record<FamilyKey, string[]> = {
	whisper: ["openai", "open ai", "breeze", "mediatek"],
	"lite-whisper": [
		"efficient-speech",
		"efficient speech",
		"lite",
		"litewhisper",
	],
	nemo: ["nvidia", "parakeet", "canary"],
	granite: ["ibm", "granite speech", "granite-speech"],
	gigaam: ["sber", "salute", "sberbank", "sberdevices", "salutedevices"],
	kaldi: ["alpha cephei", "alphacephei", "vosk"],
	"t-one": ["t-tech", "t tech", "t-bank", "tinkoff", "tbank"],
	moonshine: ["useful sensors", "useful-sensors", "moon", "streaming"],
	cohere: ["cohere ai", "command", "transcribe"],
	sense_voice: [
		"sensevoice",
		"sense-voice",
		"sense voice",
		"funaudiollm",
		"funasr",
		"alibaba",
		"damo",
	],
	dolphin: [
		"dataocean",
		"dataoceanai",
		"tsinghua",
		"eastern",
		"asian",
		"multilingual",
	],
	custom: ["custom", "user", "local", "byo", "bring your own"],
};

/**
 * Builds the lowercase search corpus for a model: display fields plus the
 * authoring org and any brand aliases. Centralised here so the search input
 * and any future "global search" share one definition.
 */
export function buildModelSearchCorpus(model: ModelInfo): string {
	const author = FAMILY_AUTHOR[model.family];
	const aliases = FAMILY_SEARCH_ALIASES[model.family].join(" ");
	const label = FAMILY_CONFIG[model.family].label;
	return [
		model.displayName,
		model.id,
		model.family,
		model.sizeLabel,
		label,
		author,
		aliases,
		model.languages.join(" "),
	]
		.join(" ")
		.toLowerCase();
}
