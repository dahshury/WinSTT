import { EyeIcon, TextSquareIcon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { useCatalogStore } from "@/entities/model-catalog";
import {
	DEFAULT_SETTINGS,
	SettingResetButton,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import { cn } from "@/shared/lib/cn";
import { FormControl } from "@/shared/ui/form-control";
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
				<FormControl
					label={tg("contextAwareness")}
					labelAddon={<Toggle checked={enabled} onCheckedChange={handleToggle} />}
					labelTrailing={
						<SettingResetButton
							isDefault={enabled === DEFAULT_SETTINGS.general.contextAwareness}
							onReset={onCancel}
						/>
					}
					tooltip={tg("contextAwarenessTooltip")}
				/>
				{/* The deny-list (apps/sites to skip) configures the same capture
				    pipeline this toggle gates, so it lives directly beneath it —
				    shown only once context awareness is actually on. */}
				{enabled ? <ContextDenyListSection /> : null}
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
	return (
		<SettingSection icon={TextSquareIcon} title={t("formatting")}>
			<div
				className={cn(
					"flex flex-col divide-y divide-surface-1 transition-opacity duration-200 ease-out",
					llmDictationEnabled && "pointer-events-none opacity-40"
				)}
			>
				<FormControl
					label={t("uppercaseFirst")}
					labelAddon={
						<Toggle
							checked={q?.ensureSentenceStartingUppercase ?? true}
							disabled={llmDictationEnabled}
							onCheckedChange={(v) => update({ ensureSentenceStartingUppercase: v })}
						/>
					}
					labelTrailing={
						<SettingResetButton
							isDefault={
								(q?.ensureSentenceStartingUppercase ?? true) ===
								DEFAULT_SETTINGS.quality.ensureSentenceStartingUppercase
							}
							onReset={() =>
								update({
									ensureSentenceStartingUppercase:
										DEFAULT_SETTINGS.quality.ensureSentenceStartingUppercase,
								})
							}
						/>
					}
					tooltip={t("uppercaseFirstTooltip")}
				/>
				<FormControl
					label={t("endWithPeriod")}
					labelAddon={
						<Toggle
							checked={q?.ensureSentenceEndsWithPeriod ?? true}
							disabled={llmDictationEnabled}
							onCheckedChange={(v) => update({ ensureSentenceEndsWithPeriod: v })}
						/>
					}
					labelTrailing={
						<SettingResetButton
							isDefault={
								(q?.ensureSentenceEndsWithPeriod ?? true) ===
								DEFAULT_SETTINGS.quality.ensureSentenceEndsWithPeriod
							}
							onReset={() =>
								update({
									ensureSentenceEndsWithPeriod:
										DEFAULT_SETTINGS.quality.ensureSentenceEndsWithPeriod,
								})
							}
						/>
					}
					tooltip={t("endWithPeriodTooltip")}
				/>
				{/* Filler removal is a `general.*` setting (synced server-side via
					custom-words-sync → set_parameter("filter_fillers")). Surfaced here
					next to the other post-decode cleanups. Turn OFF to keep verbatim
					disfluencies — the reason to pick a model like CrisperWhisper. */}
				<FormControl
					label={t("removeFillerWords")}
					labelAddon={
						<Toggle
							checked={general?.filterFillers ?? true}
							disabled={llmDictationEnabled}
							onCheckedChange={(v) => updateGeneral({ filterFillers: v })}
						/>
					}
					labelTrailing={
						<SettingResetButton
							isDefault={
								(general?.filterFillers ?? true) === DEFAULT_SETTINGS.general.filterFillers
							}
							onReset={() =>
								updateGeneral({ filterFillers: DEFAULT_SETTINGS.general.filterFillers })
							}
						/>
					}
					tooltip={t("removeFillerWordsTooltip")}
				/>
			</div>
		</SettingSection>
	);
}

/**
 * Post-recognition text-cleanup controls that are NOT the LLM provider config.
 * Renders after `LlmSettingsPanel` on the Processing tab: Context awareness
 * (+ deny-list) and the post-decode Formatting fixups. Behavior is copied
 * verbatim from the former QualitySettingsPanel — store keys, update fns,
 * i18n keys, reset buttons, and gating are unchanged.
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
