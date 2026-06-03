import { EyeIcon, TextSquareIcon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { useCatalogStore } from "@/entities/model-catalog";
import {
	DEFAULT_SETTINGS,
	SettingField,
	SettingResetButton,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import { cn } from "@/shared/lib/cn";
import { CheckboxGroup, CheckboxItem } from "@/shared/ui/checkbox-group";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { InfoTooltip } from "@/shared/ui/info-tooltip";
import { OptInDialog } from "@/shared/ui/opt-in-dialog";
import { Toggle } from "@/shared/ui/toggle";
import { ContextDenyListSection } from "./ContextDenyListSection";

type QualityT = ReturnType<typeof useTranslations<"quality">>;
type QualitySettings = NonNullable<
	ReturnType<typeof useSettingsStore.getState>["settings"]["quality"]
>;
type UpdateQualityFn = (patch: Partial<QualitySettings>) => void;
type GeneralSettings = NonNullable<
	ReturnType<typeof useSettingsStore.getState>["settings"]["general"]
>;
type UpdateGeneralFn = (patch: Partial<GeneralSettings>) => void;

type GeneralT = ReturnType<typeof useTranslations<"general">>;

interface ContextAwarenessSectionProps {
	enabled: boolean;
	onCancel: () => void;
	onConfirm: () => void;
	tg: GeneralT;
}

function ContextAwarenessSection({
	enabled,
	onCancel,
	onConfirm,
	tg,
}: ContextAwarenessSectionProps) {
	const ts = useTranslations("settings");
	const [dialogOpen, setDialogOpen] = useState(false);
	// Toggle ON ⇒ show the opt-in dialog and DON'T persist yet; the dialog's
	// confirm path is what actually flips the stored value. Toggle OFF ⇒
	// persist immediately (no consent needed to disable).
	const handleToggle = (next: boolean): void => {
		if (next) {
			setDialogOpen(true);
			return;
		}
		onCancel();
	};
	return (
		<SettingSection icon={EyeIcon} title={tg("contextAwarenessSection")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<SettingField
					isDefault={enabled === DEFAULT_SETTINGS.general.contextAwareness}
					label={tg("contextAwareness")}
					labelAddon={<Toggle checked={enabled} onCheckedChange={handleToggle} />}
					onReset={onCancel}
					tooltip={
						enabled
							? tg("contextAwarenessTooltip")
							: `${tg("contextAwarenessTooltip")} ${ts("disabledReason", { name: tg("contextAwareness") })}`
					}
				/>
				{/* The deny-list (apps/sites to skip) configures the same capture
				    pipeline this toggle gates, so it lives directly beneath it —
				    shown disabled (not hidden) until context awareness is on. */}
				<div
					className={cn(
						"transition-opacity duration-200 ease-out",
						!enabled && "pointer-events-none opacity-40"
					)}
				>
					<ContextDenyListSection />
				</div>
			</div>
			<OptInDialog
				body={tg("contextAwarenessDialogBody")}
				cancelLabel={tg("contextAwarenessDialogCancel")}
				confirmLabel={tg("contextAwarenessDialogConfirm")}
				onCancel={onCancel}
				onConfirm={onConfirm}
				onOpenChange={setDialogOpen}
				open={dialogOpen}
				title={tg("contextAwarenessDialogTitle")}
			/>
		</SettingSection>
	);
}

interface FormattingSectionProps {
	general: GeneralSettings | undefined;
	llmDictationEnabled: boolean;
	q: QualitySettings | undefined;
	t: QualityT;
	update: UpdateQualityFn;
	updateGeneral: UpdateGeneralFn;
}

// Post-decode transcript cleanups. LLM dictation rewrites the transcript
// wholesale (casing, punctuation, fillers) before paste, so these per-utterance
// fixups are redundant — disable them while LLM dictation is on. Extracted so
// the panel root stays under the cyclomatic-complexity ceiling.
function FormattingSection({
	general,
	llmDictationEnabled,
	q,
	t,
	update,
	updateGeneral,
}: FormattingSectionProps) {
	const uppercase = q?.ensureSentenceStartingUppercase ?? true;
	const period = q?.ensureSentenceEndsWithPeriod ?? true;
	// Filler removal is a `general.*` setting (synced server-side via
	// custom-words-sync → set_parameter("filter_fillers")), surfaced here next to
	// the other post-decode cleanups. Turn OFF to keep verbatim disfluencies —
	// the reason to pick a model like CrisperWhisper.
	const filler = general?.filterFillers ?? true;

	const checkedIndices = new Set<number>();
	if (uppercase) {
		checkedIndices.add(0);
	}
	if (period) {
		checkedIndices.add(1);
	}
	if (filler) {
		checkedIndices.add(2);
	}

	const isDefault =
		uppercase === DEFAULT_SETTINGS.quality.ensureSentenceStartingUppercase &&
		period === DEFAULT_SETTINGS.quality.ensureSentenceEndsWithPeriod &&
		filler === DEFAULT_SETTINGS.general.filterFillers;
	const resetAll = (): void => {
		update({
			ensureSentenceEndsWithPeriod: DEFAULT_SETTINGS.quality.ensureSentenceEndsWithPeriod,
			ensureSentenceStartingUppercase: DEFAULT_SETTINGS.quality.ensureSentenceStartingUppercase,
		});
		updateGeneral({ filterFillers: DEFAULT_SETTINGS.general.filterFillers });
	};

	// The post-decode fixups are one group of booleans, so they read as a
	// CheckboxGroup (mirroring the live-transcription display control in the
	// Appearance tab) rather than three separate toggles. Each keeps its own help
	// tooltip in the trailing slot; one group reset lives in the section header.
	// Disabled per-item while LLM dictation is on (it rewrites the transcript).
	return (
		<SettingSection
			headerAction={<SettingResetButton isDefault={isDefault} onReset={resetAll} />}
			icon={TextSquareIcon}
			title={t("formatting")}
		>
			<ElevatedSurface>
				<CheckboxGroup checkedIndices={checkedIndices} className="w-full">
					<CheckboxItem
						checked={uppercase}
						disabled={llmDictationEnabled}
						index={0}
						label={t("uppercaseFirst")}
						onToggle={() => update({ ensureSentenceStartingUppercase: !uppercase })}
						trailing={<InfoTooltip content={t("uppercaseFirstTooltip")} />}
					/>
					<CheckboxItem
						checked={period}
						disabled={llmDictationEnabled}
						index={1}
						label={t("endWithPeriod")}
						onToggle={() => update({ ensureSentenceEndsWithPeriod: !period })}
						trailing={<InfoTooltip content={t("endWithPeriodTooltip")} />}
					/>
					<CheckboxItem
						checked={filler}
						disabled={llmDictationEnabled}
						index={2}
						label={t("removeFillerWords")}
						onToggle={() => updateGeneral({ filterFillers: !filler })}
						trailing={<InfoTooltip content={t("removeFillerWordsTooltip")} />}
					/>
				</CheckboxGroup>
			</ElevatedSurface>
		</SettingSection>
	);
}

/**
 * Post-recognition text-cleanup controls that are NOT the LLM provider config.
 * Renders after `LlmSettingsPanel` on the Processing tab: Context awareness
 * (+ deny-list) and the post-decode Formatting fixups. (These moved here from
 * the former QualitySettingsPanel, folded away in the settings IA reorg.)
 */
export function ProcessingExtrasPanel() {
	const q = useSettingsStore((s) => s.settings.quality);
	const update = useSettingsStore((s) => s.updateQualitySettings);
	const general = useSettingsStore((s) => s.settings.general);
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const llmDictationEnabled = useSettingsStore((s) => s.settings.llm?.dictation?.enabled ?? false);
	// Context awareness has two consumers (see relay-context-capture):
	//   1. ASR-side: Whisper-only via `<|startofprev|>`. Canary / Cohere
	//      have a `<|startofcontext|>` slot but the released checkpoints
	//      aren't trained on it — empirical bench shows broken / truncated
	//      / hallucinated outputs (see memory note `canary-cohere-prompt-
	//      slot-untrained`). Moonshine / SenseVoice / CTC families have
	//      no prompt mechanism at all.
	//   2. LLM cleanup: any engine benefits when the dictation LLM runs.
	// So the section is meaningful when EITHER condition is met; if
	// neither is, the toggle does nothing — hide it.
	const activeSttModelId = useSettingsStore((s) => s.settings.model?.model ?? "");
	const activeSttFamily = useCatalogStore((s) => s.getModel(activeSttModelId)?.family);
	const contextAwarenessUseful = activeSttFamily === "whisper" || llmDictationEnabled;
	const t = useTranslations("quality");
	const tg = useTranslations("general");

	const contextAwarenessEnabled = general?.contextAwareness ?? false;

	return (
		<div className="flex flex-col gap-2">
			{/* ── Context Awareness ────────────────────────────
				 Shown only when at least one consumer can actually act on
				 the captured snapshot:
				   * ASR-side: active model is a Whisper variant (the only
				     family whose released checkpoints accept and respond
				     to prior-text prompts — see memory note
				     `canary-cohere-prompt-slot-untrained` for the bench
				     evidence on Canary / Cohere / Moonshine).
				   * LLM-side: dictation LLM is enabled (the cleanup pass
				     consumes context regardless of which ASR engine ran).
				 With neither condition met the toggle does nothing, so we
				 hide it instead of advertising a dead setting. */}
			{contextAwarenessUseful && (
				<ContextAwarenessSection
					enabled={contextAwarenessEnabled}
					onCancel={() => updateGeneral({ contextAwareness: false })}
					onConfirm={() => updateGeneral({ contextAwareness: true })}
					tg={tg}
				/>
			)}

			{/* ── Formatting ─────────────────────────────────── */}
			<FormattingSection
				general={general}
				llmDictationEnabled={llmDictationEnabled}
				q={q}
				t={t}
				update={update}
				updateGeneral={updateGeneral}
			/>
		</div>
	);
}
