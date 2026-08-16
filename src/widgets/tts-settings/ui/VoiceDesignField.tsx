import { AiMagicIcon, MagicWand01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, useState } from "react";
import { SettingField } from "@/entities/setting";
import type { TranslateFn } from "@/shared/i18n/translation-types";
import { cn } from "@/shared/lib/cn";
import { useSurface } from "@/shared/lib/surface";
import { AutoTextarea } from "@/shared/ui/auto-textarea";
import { DialogActionButton } from "@/shared/ui/dialog";
import { DialogShell } from "@/shared/ui/dialog-shell";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupContent,
	InputGroupInput,
	InputGroupText,
	type InputGroupTone,
} from "@/shared/ui/input-group";
import { Spinner } from "@/shared/ui/spinner";

/** Fraction of the budget after which the counter starts warning. One named
 *  constant so the "getting close" moment is a single decision, not a magic
 *  number sprinkled across the tone and the aria state. */
const COUNTER_WARN_RATIO = 0.9;

/** Resting height of the prompt editor, in rows. Five lines reproduces the
 *  110px floor this textarea used to be pinned to; past that it now grows with
 *  the prompt instead of hiding it behind a scroll. */
const PROMPT_MIN_ROWS = 5;

/** Collapse a multi-line prompt onto the trigger button: single line, trimmed,
 *  and hard-capped so a long prompt never blows out the settings row width. */
/** Which wording the shared editor speaks. `voiceDesign` = the prompt IS the
 *  voice; `voiceInstruct` = a style instruction alongside a cloned voice. */
export type KeyPrefix = "voiceDesign" | "voiceInstruct";

function truncatePrompt(prompt: string, max = 48): string {
	const oneLine = prompt.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** `0` means "the server told us nothing" (an old build, or a row that isn't a
 *  voice-design model at all) — treat it as "no cap" instead of a zero-length
 *  budget, which would make the textarea unusable. */
function resolveCap(maxChars: number): number | null {
	return Number.isFinite(maxChars) && maxChars > 0 ? maxChars : null;
}

/** The ONLY place a prompt is length-limited. `maxLength` already stops typing
 *  and pasting past the cap, but text arriving programmatically (the LLM
 *  generator) bypasses the DOM entirely — routing every write through here is
 *  what keeps `used <= cap` an invariant the counter can rely on. */
function clampToCap(value: string, cap: number | null): string {
	return cap === null || value.length <= cap ? value : value.slice(0, cap);
}

interface PromptCounterProps {
	cap: number;
	/** Referenced by the textarea's `aria-describedby`, so the budget is read out
	 *  on focus rather than announced on every keystroke. */
	id: string;
	t: TranslateFn;
	used: number;
}

/** Consumed / budget + what's left, in an input-group frame so it reads as part
 *  of the field rather than as loose caption text. Grayscale by default, accent
 *  once the prompt nears the cap, error at the cap — never green (status color
 *  is grayscale-plus-accent across this app). */
function PromptCounter({ cap, id, t, used }: PromptCounterProps) {
	const remaining = Math.max(cap - used, 0);
	const atCap = used >= cap;
	const nearCap = used >= Math.floor(cap * COUNTER_WARN_RATIO);
	const tone: InputGroupTone = atCap
		? "danger"
		: nearCap
			? "active"
			: "default";
	return (
		<InputGroup
			appearance="minimal"
			aria-label={t("voiceDesignCharCounterLabel")}
			className="w-auto shrink-0"
			id={id}
			role="group"
			size="sm"
			tone={tone}
		>
			<InputGroupContent className="px-2 tabular-nums">
				<span
					className={cn(
						"font-medium",
						atCap ? "text-error" : nearCap ? "text-accent" : "text-foreground",
					)}
					data-testid="voice-design-char-used"
				>
					{used}
				</span>
				<span className="text-foreground-muted">{` / ${cap}`}</span>
			</InputGroupContent>
			<InputGroupAddon align="inline-end">
				<InputGroupText>
					{t("voiceDesignCharsRemaining", { count: remaining })}
				</InputGroupText>
			</InputGroupAddon>
		</InputGroup>
	);
}

interface PromptGeneratorProps {
	/** Resolves to the generated instruct, rejects/throws with a user-facing
	 *  message. Supplied only when post-processing is actually runnable. */
	onGenerate: (description: string) => Promise<string>;
	onResult: (prompt: string) => void;
	keyPrefix: KeyPrefix;
	t: TranslateFn;
}

/** "Describe a character, get a voice-design prompt" — the AI affordance. Only
 *  mounted when post-processing is ready (see `isPostProcessingReady`), so it is
 *  never a dead button the user has to discover is disabled. */
function PromptGenerator({
	onGenerate,
	onResult,
	keyPrefix,
	t,
}: PromptGeneratorProps) {
	const [description, setDescription] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const canRun = !busy && description.trim().length > 0;

	const run = (): void => {
		if (!canRun) {
			return;
		}
		setError(null);
		setBusy(true);
		void onGenerate(description.trim())
			.then((generated) => {
				onResult(generated);
				setBusy(false);
			})
			.catch((reason: unknown) => {
				setBusy(false);
				const message =
					reason instanceof Error ? reason.message : String(reason);
				setError(
					message.trim().length > 0 ? message : t(`${keyPrefix}GenerateFailed`),
				);
			});
	};

	return (
		<div className="flex flex-col gap-1">
			<InputGroup
				appearance="minimal"
				size="sm"
				tone={error === null ? "default" : "danger"}
			>
				<InputGroupAddon align="inline-start">
					<HugeiconsIcon
						aria-hidden="true"
						className="size-3.5"
						icon={AiMagicIcon}
					/>
				</InputGroupAddon>
				<InputGroupInput
					aria-label={t(`${keyPrefix}GenerateLabel`)}
					dir="auto"
					disabled={busy}
					onChange={(e) => setDescription(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							run();
						}
					}}
					placeholder={t(`${keyPrefix}GeneratePlaceholder`)}
					value={description}
				/>
				<InputGroupAddon align="inline-end">
					<InputGroupButton
						aria-busy={busy || undefined}
						aria-label={
							busy
								? t(`${keyPrefix}GeneratePending`)
								: t(`${keyPrefix}GenerateAction`)
						}
						className="size-5"
						disabled={!canRun}
						onClick={run}
						tone="surface"
					>
						{busy ? (
							<Spinner className="size-3 border" />
						) : (
							<HugeiconsIcon
								aria-hidden="true"
								className="size-3.5"
								icon={MagicWand01Icon}
							/>
						)}
					</InputGroupButton>
				</InputGroupAddon>
			</InputGroup>
			{error === null ? null : (
				<p className="px-0.5 text-2xs text-error leading-relaxed" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

interface VoiceDesignDialogProps {
	initialPrompt: string;
	/** Character budget from the model's catalog row; `<= 0` = no cap known. */
	maxChars: number;
	onClose: () => void;
	/** Present iff post-processing can actually run — see `PromptGenerator`. */
	onGenerate?: ((description: string) => Promise<string>) | undefined;
	onSave: (prompt: string) => void;
	open: boolean;
	keyPrefix: KeyPrefix;
	t: TranslateFn;
}

/** The prompt editor itself — a titled alert dialog with a single textarea.
 *  Seeded once from `initialPrompt`; the parent remounts it with a fresh `key`
 *  on each open so re-syncing from props in an effect (a no-derived-state /
 *  cascading-set-state smell) is unnecessary. Empty is a valid save. */
function VoiceDesignDialog({
	initialPrompt,
	maxChars,
	onClose,
	onGenerate,
	onSave,
	open,
	keyPrefix,
	t,
}: VoiceDesignDialogProps) {
	const cap = resolveCap(maxChars);
	const counterId = useId();
	// Seed through the same clamp as every other write: a prompt saved before the
	// cap existed would otherwise render a counter reading over budget with no way
	// to reconcile it. Nothing is persisted until the user presses Save.
	const [draft, setDraft] = useState(() => clampToCap(initialPrompt, cap));
	// Lift the textarea one surface step above the popup — the same elevation the
	// custom-modifier prompt editor uses — so it reads as an input on the modal
	// rather than a dark inset well.
	const inputLevel = Math.min(useSurface() + 1, 8);
	return (
		<DialogShell
			body={
				<div className="flex flex-col gap-1.5">
					{onGenerate ? (
						<PromptGenerator
							keyPrefix={keyPrefix}
							onGenerate={onGenerate}
							onResult={(generated) => setDraft(clampToCap(generated, cap))}
							t={t}
						/>
					) : null}
					<AutoTextarea
						aria-label={t(`${keyPrefix}PromptLabel`)}
						{...(cap === null ? {} : { "aria-describedby": counterId })}
						{...(cap === null ? {} : { maxLength: cap })}
						minRows={PROMPT_MIN_ROWS}
						onChange={(e) => setDraft(clampToCap(e.target.value, cap))}
						placeholder={t(`${keyPrefix}PromptPlaceholder`)}
						// The dialog is assembled OUTSIDE the popup's SurfaceProvider, so
						// the level resolved here is the one to paint with — see
						// `AutoTextarea`'s `surfaceLevel`.
						surfaceLevel={inputLevel}
						value={draft}
					/>
					<div className="flex items-center justify-between gap-2">
						<p className="px-0.5 text-2xs text-foreground-muted leading-relaxed">
							{t(`${keyPrefix}PromptEmptyHint`)}
						</p>
						{cap === null ? null : (
							<PromptCounter
								cap={cap}
								id={counterId}
								t={t}
								used={draft.length}
							/>
						)}
					</div>
				</div>
			}
			description={t(`${keyPrefix}DialogDescription`)}
			onOpenChange={(next) => {
				if (!next) {
					onClose();
				}
			}}
			open={open}
			title={t(`${keyPrefix}DialogTitle`)}
			width={420}
		>
			<DialogActionButton onClick={onClose} variant="neutral">
				{t("voiceDesignCancel")}
			</DialogActionButton>
			<DialogActionButton
				onClick={() => onSave(clampToCap(draft.trim(), cap))}
				variant="accent"
			>
				{t("voiceDesignSave")}
			</DialogActionButton>
		</DialogShell>
	);
}

export interface VoiceDesignFieldProps {
	/** Character budget for the prompt, read from the selected model's catalog
	 *  row (`voiceDesignMaxChars`). `0` = unknown → the field imposes no cap and
	 *  hides the counter. Never hardcode the number here. */
	maxChars: number;
	/** Run the configured post-processing LLM over a character description and
	 *  return a voice-design instruct. Omit when post-processing is unavailable —
	 *  the AI affordance then doesn't render at all. */
	onGeneratePrompt?: ((description: string) => Promise<string>) | undefined;
	/** Persist a new prompt. Empty string is allowed (reverts to the default). */
	onPromptChange: (prompt: string) => void;
	/** Current design prompt — the overloaded `settings.tts.voice`. Empty = the
	 *  model's default built-in voice. */
	prompt: string;
	/** i18n key prefix for the concept-specific strings. `"voiceDesign"` (default)
	 *  is the prompt-IS-the-voice reading; `"voiceInstruct"` is the style
	 *  instruction that rides ALONGSIDE a cloned voice (OmniVoice). The editor,
	 *  the AI fill and the character budget are identical — only the wording
	 *  differs, so this stays one component. */
	keyPrefix?: KeyPrefix;
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
	maxChars,
	onGeneratePrompt,
	onPromptChange,
	prompt,
	keyPrefix = "voiceDesign",
	t,
}: VoiceDesignFieldProps) {
	const [open, setOpen] = useState(false);
	const hasPrompt = prompt.trim().length > 0;
	const buttonLabel = hasPrompt
		? truncatePrompt(prompt)
		: t(`${keyPrefix}ButtonPlaceholder`);
	return (
		<SettingField
			// The prompt IS the voice here; the default is empty (built-in voice), so
			// the reset button clears the prompt.
			isDefault={!hasPrompt}
			label={t(`${keyPrefix}Label`)}
			layout="row"
			onReset={() => onPromptChange("")}
			tooltip={t(`${keyPrefix}Tooltip`)}
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
				keyPrefix={keyPrefix}
				maxChars={maxChars}
				onClose={() => setOpen(false)}
				onGenerate={onGeneratePrompt}
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
