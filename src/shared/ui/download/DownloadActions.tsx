import {
	Cancel01Icon,
	CloudDownloadIcon,
	PauseIcon,
	PlayIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	AnimatePresence,
	domAnimation,
	LazyMotion,
	m,
	useReducedMotion,
} from "motion/react";
import type { MouseEvent, PointerEvent, ReactElement, ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, surfaceHoverBg, useSurface } from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import { DialogActionButton } from "@/shared/ui/dialog";
import { Tooltip } from "@/shared/ui/tooltip";

/** Phase of the download workflow as seen by the action row.
 *  - `idle`   nothing on disk, nothing in flight → primary "Download"
 *  - `active` bytes are flowing right now        → "Stop"
 *  - `paused` partial bytes on disk, no flow     → "Discard" + "Resume" */
export type DownloadPhase = "idle" | "active" | "paused";

interface DownloadActionLabels {
	discard: string;
	download: string;
	resume: string;
	stop: string;
}

export interface DownloadActionsProps {
	/** Dialog footers wrap sibling actions in ButtonGroup. This option removes
	 *  internal spacing and uses the shared dialog button treatment so phase
	 *  changes still join into one segmented action row. */
	appearance?: "default" | "dialog";
	/** Tooltip shown when hovering the destructive "Discard" button. Optional
	 *  because the dictation modal already has the explanation in the modal
	 *  body, but Ollama's list rows benefit from a hover hint. */
	discardTooltip?: string;
	labels: DownloadActionLabels;
	onDiscard: () => void;
	onDownload: () => void;
	onResume: () => void;
	onStop: () => void;
	phase: DownloadPhase;
	/** "sm" fits inside list rows (Ollama); "md" reads as a modal CTA. */
	size?: "sm" | "md";
}

const SIZE_CLASS: Record<NonNullable<DownloadActionsProps["size"]>, string> = {
	sm: "h-7 px-2.5 text-xs",
	md: "h-8 px-3 text-sm",
};

// Static part of the neutral button shell. The substrate-aware bg + hover-bg
// are composed in at render time via `useSurface()` so the button lifts
// correctly inside ElevatedSurface / nested containers.
const NEUTRAL_STATIC =
	"inline-flex items-center gap-1.5 rounded-md border border-border text-foreground-secondary transition-colors";
const ACCENT_BASE =
	"inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent font-medium text-white transition-colors hover:bg-accent-dim";

function actionIconSize(
	size: NonNullable<DownloadActionsProps["size"]>,
): number {
	return size === "sm" ? 13 : 14;
}

type DownloadButtonEvent =
	| MouseEvent<HTMLButtonElement>
	| PointerEvent<HTMLButtonElement>;

function stopDownloadButtonPropagation(event: DownloadButtonEvent): void {
	event.stopPropagation();
}

function downloadButtonHandlers(onAction: () => void) {
	return {
		onClick: (event: MouseEvent<HTMLButtonElement>) => {
			event.preventDefault();
			event.stopPropagation();
			onAction();
		},
		onMouseDown: stopDownloadButtonPropagation,
		onPointerDown: stopDownloadButtonPropagation,
	};
}

/** Tri-state action row. Renders only the phase-specific primary (+
 *  destructive) buttons — any modal-level dismiss button ("Cancel",
 *  "Close", "Hide") stays at the caller because it isn't a download
 *  concern. */
export function DownloadActions({
	appearance = "default",
	phase,
	labels,
	discardTooltip,
	onDownload,
	onStop,
	onDiscard,
	onResume,
	size = "md",
}: DownloadActionsProps): ReactNode {
	const dialogAppearance = appearance === "dialog";
	const sizeCls = SIZE_CLASS[size];
	const iconSize = actionIconSize(size);
	const substrate = useSurface();
	const buttonLevel = Math.min(substrate + 1, 8);
	const buttonHover = Math.min(substrate + 2, 8);
	const neutralCls = cn(
		NEUTRAL_STATIC,
		surfaceBg(buttonLevel),
		surfaceHoverBg(buttonHover),
	);
	const reduceMotion = useReducedMotion();
	const renderActionButton = (
		variant: "neutral" | "accent",
		defaultClassName: string,
		onAction: () => void,
		icon: ReactNode,
		label: string,
	): ReactElement => {
		const handlers = downloadButtonHandlers(onAction);
		if (dialogAppearance) {
			return (
				<DialogActionButton className={sizeCls} variant={variant} {...handlers}>
					{icon}
					<span>{label}</span>
				</DialogActionButton>
			);
		}
		return (
			<Button className={cn(defaultClassName, sizeCls)} {...handlers}>
				{icon}
				<span>{label}</span>
			</Button>
		);
	};
	let content: ReactNode;
	if (phase === "active") {
		content = renderActionButton(
			"neutral",
			neutralCls,
			onStop,
			<HugeiconsIcon icon={PauseIcon} size={iconSize} />,
			labels.stop,
		);
	} else if (phase === "paused") {
		const discardButton = renderActionButton(
			"neutral",
			neutralCls,
			onDiscard,
			<HugeiconsIcon icon={Cancel01Icon} size={iconSize} />,
			labels.discard,
		);
		content = (
			<div
				className={cn(
					"flex items-center",
					dialogAppearance ? "divide-x divide-divider" : "gap-1.5",
				)}
			>
				{discardTooltip ? (
					<Tooltip content={discardTooltip} side="top">
						{discardButton}
					</Tooltip>
				) : (
					discardButton
				)}
				{renderActionButton(
					"accent",
					ACCENT_BASE,
					onResume,
					<HugeiconsIcon icon={PlayIcon} size={iconSize} />,
					labels.resume,
				)}
			</div>
		);
	} else {
		content = renderActionButton(
			"accent",
			ACCENT_BASE,
			onDownload,
			<HugeiconsIcon icon={CloudDownloadIcon} size={iconSize} />,
			labels.download,
		);
	}
	return (
		<LazyMotion features={domAnimation} strict>
			<AnimatePresence initial={false} mode="wait">
				<m.div
					animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
					className="inline-flex items-center"
					exit={
						reduceMotion
							? { opacity: 1, transition: { duration: 0 } }
							: {
									opacity: 0,
									y: -3,
									filter: "blur(2px)",
									transition: { duration: 0.12 },
								}
					}
					initial={
						reduceMotion ? false : { opacity: 0, y: 3, filter: "blur(2px)" }
					}
					key={phase}
					transition={
						reduceMotion
							? { duration: 0 }
							: { duration: 0.16, ease: [0.22, 1, 0.36, 1] }
					}
				>
					{content}
				</m.div>
			</AnimatePresence>
		</LazyMotion>
	);
}
