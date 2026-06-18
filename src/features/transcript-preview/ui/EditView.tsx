import { AiMagicIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import { useSettingsStore } from "@/entities/setting";
import { ALL_PRESET_KEYS, type PresetKey } from "@/shared/lib/preset-prompts";
import { Button } from "@/shared/ui/button";
import {
	hasRunnableDictationPreviewLlm,
	sendPreview,
} from "../lib/preview-config";
import { useTranscriptPreviewStore } from "../model/preview-store";
import { PreviewInfoPill, StaggerReveal } from "./preview-primitives";

function isPresetKey(key: string): key is PresetKey {
	return (ALL_PRESET_KEYS as readonly string[]).includes(key);
}

/** Entry view: the editable transcript + Enhance/Send toolbar. Shown when AI
 *  post-processing did not auto-enhance the transcript (or after returning here
 *  from the enhance view). */
export function EditView() {
	const tp = useTranslations("preview");
	const store = useTranscriptPreviewStore();
	const llm = useSettingsStore((s) => s.settings.llm);
	const dictation = llm?.dictation;
	const postProcessingEnabled = Boolean(dictation?.enabled);
	const modelReady = hasRunnableDictationPreviewLlm(llm);
	const enhanceEnabled = postProcessingEnabled && modelReady;
	// Distinguish the two disabled reasons so the info pill is actionable.
	const disabledReason = postProcessingEnabled
		? tp("enhanceDisabled")
		: tp("enhanceDisabledNoPostProcessing");

	const openEnhance = () => {
		const presetKeys: PresetKey[] = [];
		for (const preset of dictation?.presets ?? []) {
			if (isPresetKey(preset.key)) {
				presetKeys.push(preset.key);
			}
		}
		const modifierIds: string[] = [];
		for (const modifier of dictation?.customModifiers ?? []) {
			if (modifier.enabled) {
				modifierIds.push(modifier.id);
			}
		}
		store.seedEnhance(presetKeys, modifierIds);
		store.setView("enhance");
	};

	return (
		<div className="flex flex-col gap-2 px-1">
			<StaggerReveal>
				<textarea
					aria-label={tp("placeholder")}
					className="t-stagger-line max-h-56 min-h-[3rem] w-full resize-none rounded-md border border-border bg-surface-2 px-2.5 py-2 text-foreground text-sm leading-snug placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-accent/60"
					dir="auto"
					onChange={(e) => {
						store.setText(e.currentTarget.value);
						store.setSelection(
							e.currentTarget.selectionStart,
							e.currentTarget.selectionEnd,
						);
					}}
					onSelect={(e) =>
						store.setSelection(
							e.currentTarget.selectionStart,
							e.currentTarget.selectionEnd,
						)
					}
					placeholder={tp("placeholder")}
					value={store.text}
				/>
			</StaggerReveal>
			<div className="flex items-center justify-between gap-2">
				<div className="flex min-w-0 flex-col gap-1.5">
					<Button
						className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-foreground-muted text-sm transition-colors hover:text-foreground disabled:opacity-40"
						disabled={!enhanceEnabled}
						onClick={openEnhance}
						title={enhanceEnabled ? undefined : disabledReason}
					>
						<HugeiconsIcon icon={AiMagicIcon} size={15} />
						{tp("enhance")}
					</Button>
					{enhanceEnabled ? null : <PreviewInfoPill text={disabledReason} />}
				</div>
				<Button
					className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-md bg-accent px-3.5 py-1.5 font-medium text-sm text-on-accent transition-colors hover:bg-accent-hover"
					onClick={sendPreview}
				>
					<HugeiconsIcon icon={Tick02Icon} size={15} />
					{tp("send")}
				</Button>
			</div>
		</div>
	);
}
