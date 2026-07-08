import { MagicWand01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { SettingField } from "@/entities/setting";
import type { TranslateFn } from "@/shared/i18n/translation-types";
import { cn } from "@/shared/lib/cn";
import { surfaceClasses, useSurface } from "@/shared/lib/surface";
import { DialogActionButton } from "@/shared/ui/dialog";
import { DialogShell } from "@/shared/ui/dialog-shell";

/** Collapse a multi-line prompt onto the trigger button: single line, trimmed,
 *  and hard-capped so a long prompt never blows out the settings row width. */
function truncatePrompt(prompt: string, max = 48): string {
	const oneLine = prompt.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

interface VoiceDesignDialogProps {
	initialPrompt: string;
	onClose: () => void;
	onSave: (prompt: string) => void;
	open: boolean;
	t: TranslateFn;
}

/** The prompt editor itself — a titled alert dialog with a single textarea.
 *  Seeded once from `initialPrompt`; the parent remounts it with a fresh `key`
 *  on each open so re-syncing from props in an effect (a no-derived-state /
 *  cascading-set-state smell) is unnecessary. Empty is a valid save. */
function VoiceDesignDialog({
	initialPrompt,
	onClose,
	onSave,
	open,
	t,
}: VoiceDesignDialogProps) {
	const [draft, setDraft] = useState(initialPrompt);
	// Lift the textarea one surface step above the popup — the same elevation the
	// custom-modifier prompt editor uses — so it reads as an input on the modal
	// rather than a dark inset well.
	const inputLevel = Math.min(useSurface() + 1, 8);
	return (
		<DialogShell
			body={
				<div className="flex flex-col gap-1.5">
					<textarea
						aria-label={t("voiceDesignPromptLabel")}
						className={cn(
							"min-h-[110px] w-full resize-y rounded-lg p-2.5 text-body text-foreground caret-accent outline-none placeholder:text-foreground-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1",
							surfaceClasses(inputLevel),
						)}
						dir="auto"
						onChange={(e) => setDraft(e.target.value)}
						placeholder={t("voiceDesignPromptPlaceholder")}
						value={draft}
					/>
					<p className="px-0.5 text-2xs text-foreground-muted leading-relaxed">
						{t("voiceDesignPromptEmptyHint")}
					</p>
				</div>
			}
			description={t("voiceDesignDialogDescription")}
			onOpenChange={(next) => {
				if (!next) {
					onClose();
				}
			}}
			open={open}
			title={t("voiceDesignDialogTitle")}
			width={420}
		>
			<DialogActionButton onClick={onClose} variant="neutral">
				{t("voiceDesignCancel")}
			</DialogActionButton>
			<DialogActionButton onClick={() => onSave(draft.trim())} variant="accent">
				{t("voiceDesignSave")}
			</DialogActionButton>
		</DialogShell>
	);
}

export interface VoiceDesignFieldProps {
	/** Current design prompt — the overloaded `settings.tts.voice`. Empty = the
	 *  model's default built-in voice. */
	prompt: string;
	/** Persist a new prompt. Empty string is allowed (reverts to the default). */
	onPromptChange: (prompt: string) => void;
	t: TranslateFn;
}

/**
 * The voice-design affordance shown in place of the voice dropdown when the
 * selected TTS model is a voice-design model (Qwen3-TTS-VoiceDesign): a "Design
 * voice" button that opens a textarea dialog. The button surfaces the current
 * prompt (truncated) or a placeholder when none is set. Empty prompt is the
 * default and is fully allowed.
 */
export function VoiceDesignField({
	prompt,
	onPromptChange,
	t,
}: VoiceDesignFieldProps) {
	const [open, setOpen] = useState(false);
	const hasPrompt = prompt.trim().length > 0;
	const buttonLabel = hasPrompt
		? truncatePrompt(prompt)
		: t("voiceDesignButtonPlaceholder");
	return (
		<SettingField
			// The prompt IS the voice here; the default is empty (built-in voice), so
			// the reset button clears the prompt.
			isDefault={!hasPrompt}
			label={t("voiceDesignLabel")}
			layout="row"
			onReset={() => onPromptChange("")}
			tooltip={t("voiceDesignTooltip")}
		>
			<button
				className={cn(
					"inline-flex h-8 w-52 min-w-0 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-surface-3 px-2.5 text-left text-body outline-none transition-colors hover:border-border-accent focus-visible:border-border-accent focus-visible:ring-2 focus-visible:ring-accent/40",
					hasPrompt ? "text-foreground" : "text-foreground-muted",
				)}
				onClick={() => setOpen(true)}
				type="button"
			>
				<HugeiconsIcon
					aria-hidden="true"
					className="size-3.5 shrink-0 text-accent"
					icon={MagicWand01Icon}
				/>
				<span className="min-w-0 flex-1 truncate" dir="auto">
					{buttonLabel}
				</span>
			</button>
			<VoiceDesignDialog
				initialPrompt={prompt}
				key={open ? "open" : "closed"}
				onClose={() => setOpen(false)}
				onSave={(next) => {
					onPromptChange(next);
					setOpen(false);
				}}
				open={open}
				t={t}
			/>
		</SettingField>
	);
}
