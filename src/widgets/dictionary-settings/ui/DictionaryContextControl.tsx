import { DashboardSpeed02Icon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import {
	DEFAULT_SETTINGS,
	SettingField,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import { Slider } from "@/shared/ui/slider";

// Discrete context-window steps (bytes each side of a word) the slider maps to. 220 = the default,
// least, fastest step; wider trades speed for catching borderline corrections in long dictation.
// Mirrors the Rust/zod validated range (220..=1000).
const CONTEXT_STEPS = [220, 450, 700, 1000] as const;
const STEP_LABEL_KEYS = [
	"contextLeast",
	"contextSome",
	"contextMore",
	"contextMost",
] as const;

/** Snap a stored byte value to the nearest slider step index. */
function valueToIndex(value: number): number {
	let best = 0;
	let bestDist = Number.POSITIVE_INFINITY;
	for (let i = 0; i < CONTEXT_STEPS.length; i++) {
		const step = CONTEXT_STEPS[i];
		if (step === undefined) {
			continue;
		}
		const dist = Math.abs(step - value);
		if (dist < bestDist) {
			bestDist = dist;
			best = i;
		}
	}
	return best;
}

export interface DictionaryContextControlProps {
	/** Greyed + inert when the on-device dictionary can't act (feature off / model absent). */
	disabled?: boolean;
	disabledTooltip?: string | undefined;
}

/**
 * "Dictionary speed" — how much surrounding text the on-device dictionary reads around each word when
 * deciding whether it's a mis-hearing. Least (default) is fastest; wider can catch borderline
 * corrections in long dictation but is slower. Persists to `general.dictionaryContextChars`, which the
 * Rust corrector reads per utterance.
 */
export function DictionaryContextControl({
	disabled = false,
	disabledTooltip,
}: DictionaryContextControlProps): ReactNode {
	const t = useTranslations("dictionary");
	const value = useSettingsStore(
		(s) => s.settings.general?.dictionaryContextChars ?? 220,
	);
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const index = valueToIndex(value);
	const fallback = DEFAULT_SETTINGS.general.dictionaryContextChars;

	return (
		<SettingSection
			boxed
			icon={DashboardSpeed02Icon}
			title={t("contextSectionTitle")}
		>
			<SettingField
				defaultValue={fallback}
				disabled={disabled}
				disabledTooltip={disabledTooltip}
				hideReset={disabled}
				label={t("contextLabel")}
				onReset={() => updateGeneral({ dictionaryContextChars: fallback })}
				tooltip={t("contextTooltip")}
				value={value}
			>
				<Slider
					aria-label={t("contextLabel")}
					disabled={disabled}
					formatValue={(v) => t(STEP_LABEL_KEYS[v] ?? STEP_LABEL_KEYS[0])}
					max={CONTEXT_STEPS.length - 1}
					min={0}
					onChange={(v) => {
						if (!disabled) {
							updateGeneral({
								dictionaryContextChars: CONTEXT_STEPS[v] ?? fallback,
							});
						}
					}}
					step={1}
					value={index}
				/>
			</SettingField>
		</SettingSection>
	);
}
