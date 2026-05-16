import {
	AiChipIcon,
	AudioWave02Icon,
	CpuIcon,
	FlashIcon,
	Radio01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { ModelInfo } from "@/entities/model-catalog";

export type FamilyKey = ModelInfo["family"];

interface FamilyConfig {
	/** Tailwind classes for the family chip (background + foreground). */
	chip: string;
	icon: IconSvgElement;
	label: string;
}

const FAMILY_CONFIG: Record<FamilyKey, FamilyConfig> = {
	whisper: {
		icon: AudioWave02Icon,
		label: "Whisper",
		chip: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
	},
	nemo: {
		icon: AiChipIcon,
		label: "NeMo",
		chip: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
	},
	gigaam: {
		icon: Radio01Icon,
		label: "GigaAM",
		chip: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
	},
	kaldi: {
		icon: CpuIcon,
		label: "Kaldi",
		chip: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
	},
	"t-one": {
		icon: FlashIcon,
		label: "T-One",
		chip: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
	},
};

export function getFamilyConfig(family: FamilyKey): FamilyConfig {
	return FAMILY_CONFIG[family];
}

/** The org/maker behind each model family — drives the group header. */
const FAMILY_AUTHOR: Record<FamilyKey, string> = {
	whisper: "OpenAI",
	nemo: "NVIDIA",
	gigaam: "Sber Salute",
	kaldi: "Alpha Cephei",
	"t-one": "T-Tech",
};

export function getAuthorLabel(family: FamilyKey): string {
	return FAMILY_AUTHOR[family];
}

const FAMILY_ORDER: FamilyKey[] = ["whisper", "nemo", "gigaam", "kaldi", "t-one"];

function bucketByFamily(models: readonly ModelInfo[]): Map<FamilyKey, ModelInfo[]> {
	const grouped = new Map<FamilyKey, ModelInfo[]>();
	for (const m of models) {
		const list = grouped.get(m.family) ?? [];
		list.push(m);
		grouped.set(m.family, list);
	}
	return grouped;
}

/** Group models by family in a stable display order (whisper first). */
export function groupByFamily(models: readonly ModelInfo[]): [FamilyKey, ModelInfo[]][] {
	const grouped = bucketByFamily(models);
	return FAMILY_ORDER.flatMap((family): [FamilyKey, ModelInfo[]][] => {
		const list = grouped.get(family);
		return list && list.length > 0 ? [[family, list]] : [];
	});
}

/**
 * Base UI Combobox grouped-items shape: one entry per author/family with its
 * member models. `value` is the family key (used as the group identity);
 * the visible heading is derived via {@link getAuthorLabel}.
 */
export interface AuthorGroup {
	items: ModelInfo[];
	value: FamilyKey;
}

export function groupModelsByAuthor(models: readonly ModelInfo[]): AuthorGroup[] {
	return groupByFamily(models).map(([value, items]) => ({ value, items }));
}
