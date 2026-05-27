import { useState } from "react";
import { useTranslations } from "use-intl";
import { useSettingsStore } from "@/entities/setting";
import { FormControl } from "@/shared/ui/form-control";
import { OptInDialog } from "@/shared/ui/opt-in-dialog";
import { Toggle } from "@/shared/ui/toggle";

/**
 * Context-awareness control. Rendered inside the "Dictation post-processing"
 * subsection because the captured window text is only ever fed into the
 * dictation LLM cleanup path (relay.ts → processText); the Transforms path
 * never passes context. Content-only — the surrounding SettingSubsection
 * owns the title/toggle/box.
 *
 * Toggle-on path: show the warning dialog → confirm persists the flag;
 * cancel reverts. Toggle-off path: persist immediately (no consent needed
 * to disable a privacy-affecting feature).
 *
 * Hidden when the dictation LLM isn't configured — the captured snapshot
 * would be thrown away (relay.ts `maybeRunLlm` bails on `!isLlmConfigured()`
 * and the fallback `applyPostProcessing` ignores context), so surfacing
 * the control at all (even disabled) is misleading. The persisted
 * `contextAwareness` value stays untouched so the preference comes back
 * automatically when dictation LLM is re-enabled.
 */
export function ContextAwarenessSection() {
	const general = useSettingsStore((s) => s.settings.general);
	const dictation = useSettingsStore((s) => s.settings.llm.dictation);
	const openrouterApiKey = useSettingsStore((s) => s.settings.llm.openrouterApiKey);
	const update = useSettingsStore((s) => s.updateGeneralSettings);
	const t = useTranslations("general");
	const enabled = general?.contextAwareness ?? false;
	const [dialogOpen, setDialogOpen] = useState(false);

	// Mirrors relay.ts `isLlmConfigured()` — provider-aware so OpenRouter
	// counts as "configured" via an API key (model defaults are filled in
	// by the per-feature toggle), while Ollama requires a chosen model name.
	const hasDictationModel =
		dictation.provider === "openrouter" ? openrouterApiKey.length > 0 : dictation.model.length > 0;
	const dictationLlmConfigured = dictation.enabled && hasDictationModel;

	if (!dictationLlmConfigured) {
		return null;
	}

	const handleToggle = (next: boolean): void => {
		if (next) {
			setDialogOpen(true);
			return;
		}
		update({ contextAwareness: false });
	};

	return (
		<>
			<FormControl
				caption={t("contextAwarenessCaption")}
				label={t("contextAwareness")}
				tooltip={t("contextAwarenessTooltip")}
			>
				<Toggle checked={enabled} onCheckedChange={handleToggle} />
			</FormControl>
			<OptInDialog
				body={t("contextAwarenessDialogBody")}
				cancelLabel={t("contextAwarenessDialogCancel")}
				confirmLabel={t("contextAwarenessDialogConfirm")}
				onCancel={() => update({ contextAwareness: false })}
				onConfirm={() => update({ contextAwareness: true })}
				onOpenChange={setDialogOpen}
				open={dialogOpen}
				title={t("contextAwarenessDialogTitle")}
			/>
		</>
	);
}
