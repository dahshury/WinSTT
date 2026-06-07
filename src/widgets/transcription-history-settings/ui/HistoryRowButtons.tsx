import { Button as BaseButton } from "@base-ui/react/button";
import {
	AiBrain02Icon,
	Copy01Icon,
	CopyCheckIcon,
	Delete02Icon,
	PauseIcon,
	PlayIcon,
	TextFontIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/shared/lib/cn";
import { Spinner } from "@/shared/ui/spinner";
import { Tooltip } from "@/shared/ui/tooltip";
import { COPY_FEEDBACK_MS, copyEntryText } from "../lib/copy-entry-text";

export function PlayButton({
	loading,
	onToggle,
	playing,
}: {
	loading: boolean;
	onToggle: () => void;
	playing: boolean;
}) {
	let label = "Play recording";
	if (loading) {
		label = "Loading recording";
	} else if (playing) {
		label = "Pause recording";
	}
	// Ghost transport control, matched to the recording-sound library's play
	// button (SoundLibraryRow): idle is a muted glyph that picks up a faint
	// neutral wash on hover; playing settles into a soft neutral chip. No accent
	// — playback state reads through tone alone, not color.
	return (
		<BaseButton
			aria-label={label}
			className={cn(
				"inline-flex size-7 shrink-0 items-center justify-center rounded-full transition-colors duration-150 active:scale-95",
				playing
					? "bg-foreground/15 text-foreground hover:bg-foreground/25"
					: "bg-transparent text-foreground-muted hover:bg-foreground/10 hover:text-foreground",
			)}
			disabled={loading}
			onClick={onToggle}
			type="button"
		>
			{loading ? (
				<Spinner className="size-3.5" />
			) : (
				<HugeiconsIcon
					className="size-3.5"
					icon={playing ? PauseIcon : PlayIcon}
				/>
			)}
		</BaseButton>
	);
}

export function CopyButton({ label, text }: { label: string; text: string }) {
	const [copied, setCopied] = useState(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
			}
		},
		[],
	);

	const handleCopy = () => {
		copyEntryText(text);
		setCopied(true);
		if (timerRef.current) {
			clearTimeout(timerRef.current);
		}
		// Hold the check just long enough to read as confirmation, then revert.
		timerRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
	};

	// Both glyphs are stacked and cross-faded (scale + opacity) so the copy →
	// check swap animates, matching fluidfunctionalism's input-copy "icon"
	// variant. The Base UI Tooltip supplies the accessible label on hover.
	return (
		<Tooltip content={label}>
			<BaseButton
				aria-label={label}
				className="relative inline-flex size-7 items-center justify-center text-foreground-muted transition-[color,background-color,transform] hover:bg-surface-hover hover:text-foreground active:scale-95"
				onClick={handleCopy}
				type="button"
			>
				<HugeiconsIcon
					aria-hidden="true"
					className={cn(
						"absolute size-3.5 transition-[opacity,transform] duration-200 ease-out",
						copied ? "scale-50 opacity-0" : "scale-100 opacity-100",
					)}
					icon={Copy01Icon}
				/>
				<HugeiconsIcon
					aria-hidden="true"
					className={cn(
						"absolute size-3.5 text-success transition-[opacity,transform] duration-200 ease-out",
						copied ? "scale-100 opacity-100" : "scale-50 opacity-0",
					)}
					icon={CopyCheckIcon}
				/>
			</BaseButton>
		</Tooltip>
	);
}

export function DeleteButton({
	entryId,
	onDelete,
}: {
	entryId: string;
	onDelete: (id: string) => void;
}) {
	return (
		<BaseButton
			aria-label="Delete entry"
			className="inline-flex size-7 items-center justify-center text-foreground-muted transition-[color,background-color,transform] hover:bg-error/15 hover:text-error active:scale-95"
			onClick={() => {
				onDelete(entryId);
			}}
			type="button"
		>
			<HugeiconsIcon className="size-3.5" icon={Delete02Icon} />
		</BaseButton>
	);
}

/**
 * Toggles a row's transcript between the AI-edited final text and the raw
 * pre-LLM original. Only mounted for entries where the LLM produced a visible
 * text variant. The glyph doubles as a state
 * indicator: the brain (accent) when the AI version is showing, the text glyph
 * when the original is showing — so the row reads as AI-touched at a glance.
 * The label describes the action the click performs, matching the copy
 * button's icon-swap convention above.
 */
export function SwapButton({
	onToggle,
	showOriginal,
	showOriginalLabel,
	showProcessedLabel,
}: {
	onToggle: () => void;
	showOriginal: boolean;
	showOriginalLabel: string;
	showProcessedLabel: string;
}) {
	const label = showOriginal ? showProcessedLabel : showOriginalLabel;
	return (
		<Tooltip content={label}>
			<BaseButton
				aria-label={label}
				aria-pressed={showOriginal}
				className="relative inline-flex size-7 items-center justify-center text-foreground-muted transition-[color,background-color,transform] hover:bg-surface-hover hover:text-foreground active:scale-95"
				onClick={onToggle}
				type="button"
			>
				<HugeiconsIcon
					aria-hidden="true"
					className={cn(
						"absolute size-3.5 text-accent transition-[opacity,transform] duration-200 ease-out",
						showOriginal ? "scale-50 opacity-0" : "scale-100 opacity-100",
					)}
					icon={AiBrain02Icon}
				/>
				<HugeiconsIcon
					aria-hidden="true"
					className={cn(
						"absolute size-3.5 transition-[opacity,transform] duration-200 ease-out",
						showOriginal ? "scale-100 opacity-100" : "scale-50 opacity-0",
					)}
					icon={TextFontIcon}
				/>
			</BaseButton>
		</Tooltip>
	);
}
