import { Button as BaseButton } from "@base-ui/react/button";
import { Progress } from "@base-ui/react/progress";
import {
	AlertCircleIcon,
	Cancel01Icon,
	CheckmarkCircle02Icon,
	Clock01Icon,
	Copy01Icon,
	Loading03Icon,
	PauseIcon,
	PlayIcon,
	RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import type { FileQueueItem, FileQueueStatus } from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { surfaceBg } from "@/shared/lib/surface";

// One status glyph per state. The active row's spinner and the complete row's
// pop are the only motion here — gated by `motion-safe:` so reduced-motion
// users get a static, still-legible icon.
const GLYPH = {
	queued: { icon: Clock01Icon, cls: "text-foreground-muted" },
	transcribing: {
		icon: Loading03Icon,
		cls: "text-teal motion-safe:animate-[spin_1s_linear_infinite]",
	},
	complete: {
		icon: CheckmarkCircle02Icon,
		cls: "text-success motion-safe:animate-[glyph-pop_240ms_ease-out]",
	},
	error: { icon: AlertCircleIcon, cls: "text-error" },
	paused: { icon: PauseIcon, cls: "text-warning" },
	canceled: { icon: Cancel01Icon, cls: "text-foreground-muted" },
} as const;

function labelClass(status: FileQueueStatus): string {
	if (status === "transcribing") {
		return "text-foreground";
	}
	if (status === "queued" || status === "paused" || status === "canceled") {
		return "text-foreground-muted";
	}
	return "text-foreground-dim";
}

// The welded hairline = the row's bottom border AND its progress fill in one
// 2px line. The fill colour/width encodes state; a frozen paused fill breathes
// (desaturated) so it never reads as idle; error shows a fixed red stub. A
// resumed row sits at "queued" with carried-over progress — show that fill (a
// dimmer teal) so resume doesn't flash the bar back to 0 before it continues.
function indicatorClass(status: FileQueueStatus, hasProgress: boolean): string {
	if (status === "transcribing") {
		return "bg-teal";
	}
	if (status === "complete") {
		return "bg-success";
	}
	if (status === "paused") {
		return "bg-warning/60 motion-safe:animate-[hairline-pulse_1.6s_ease-in-out_infinite]";
	}
	if (status === "error") {
		return "w-[12%] bg-error";
	}
	if (status === "queued" && hasProgress) {
		return "bg-teal/70";
	}
	return "w-0"; // fresh queued / canceled — no fill, just the grey track
}

function RowStatusText({ item, pct }: { item: FileQueueItem; pct: number }) {
	const t = useTranslations("fileOverlay");
	if (item.status === "transcribing") {
		return (
			<span className="shrink-0 font-mono text-[11px] text-teal tabular-nums">
				{pct}
				<span className="text-teal/45">%</span>
			</span>
		);
	}
	if (item.status === "queued") {
		return (
			<span className="shrink-0 text-[10px] text-foreground-muted tracking-tight">
				{t("statusQueued")}
			</span>
		);
	}
	if (item.status === "paused") {
		return (
			<span className="shrink-0 text-[10px] text-warning/80 tracking-tight">
				{t("statusPaused")}
			</span>
		);
	}
	if (item.status === "canceled") {
		return (
			<span className="shrink-0 text-[10px] text-foreground-muted tracking-tight">
				{t("statusCanceled")}
			</span>
		);
	}
	return null;
}

// Primary action (pause / resume / retry) is always visible; secondary (copy /
// discard) is revealed on row hover + keyboard focus to keep the dense row calm.
const PRIMARY_BTN =
	"grid size-5 shrink-0 place-items-center rounded transition-[transform,color] duration-150 ease-out focus-visible:outline-none focus-visible:ring-1 active:scale-[0.97]";
const HOVER_BTN =
	"grid size-5 shrink-0 place-items-center rounded opacity-0 transition-[opacity,transform,color] duration-150 ease-out focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 active:scale-[0.97] group-hover:opacity-100";

interface RowActionHandlers {
	onCopy: (id: string) => void;
	onDiscard: (id: string) => void;
	onPause: (id: string) => void;
	onResume: (id: string) => void;
	onRetry: (id: string) => void;
}

function RowActions({
	item,
	...h
}: { item: FileQueueItem } & RowActionHandlers) {
	const t = useTranslations("fileOverlay");
	const name = item.fileName;
	return (
		<>
			{item.status === "transcribing" && (
				<BaseButton
					aria-label={t("pauseFile", { name })}
					className={cn(
						PRIMARY_BTN,
						"text-foreground-muted hover:text-foreground-dim focus-visible:ring-teal/60",
					)}
					onClick={() => h.onPause(item.id)}
					type="button"
				>
					<HugeiconsIcon aria-hidden icon={PauseIcon} size={12} />
				</BaseButton>
			)}
			{item.status === "paused" && (
				<BaseButton
					aria-label={t("resumeFile", { name })}
					className={cn(
						PRIMARY_BTN,
						"text-teal/90 hover:text-teal focus-visible:ring-teal/60",
					)}
					onClick={() => h.onResume(item.id)}
					type="button"
				>
					<HugeiconsIcon aria-hidden icon={PlayIcon} size={12} />
				</BaseButton>
			)}
			{item.status === "error" && (
				<BaseButton
					aria-label={t("retryFile", { name })}
					className={cn(
						PRIMARY_BTN,
						"text-error/80 hover:text-error focus-visible:ring-error/60",
					)}
					onClick={() => h.onRetry(item.id)}
					type="button"
				>
					<HugeiconsIcon aria-hidden icon={RefreshIcon} size={12} />
				</BaseButton>
			)}
			{item.status === "complete" && (
				<BaseButton
					aria-label={t("copyFile", { name })}
					className={cn(
						HOVER_BTN,
						"text-foreground-muted hover:text-foreground-dim focus-visible:ring-teal/60",
					)}
					onClick={() => h.onCopy(item.id)}
					type="button"
				>
					<HugeiconsIcon aria-hidden icon={Copy01Icon} size={13} />
				</BaseButton>
			)}
			<BaseButton
				aria-label={t("discardFile", { name })}
				className={cn(
					HOVER_BTN,
					"text-foreground-muted hover:text-error focus-visible:ring-error/60",
				)}
				onClick={() => h.onDiscard(item.id)}
				type="button"
			>
				<HugeiconsIcon aria-hidden icon={Cancel01Icon} size={12} />
			</BaseButton>
		</>
	);
}

interface QueueRowProps extends RowActionHandlers {
	index: number;
	item: FileQueueItem;
	rowLevel: number;
}

export function QueueRow({
	item,
	index,
	rowLevel,
	...handlers
}: QueueRowProps) {
	const isActive = item.status === "transcribing";
	const pct = Math.round(item.progress * 100);
	const hasProgress = item.progress > 0;
	// A resumed-but-waiting row is "queued" with carried-over progress — keep the
	// bar determinate so it shows where it'll continue from, not a reset to 0.
	const determinate =
		isActive ||
		item.status === "complete" ||
		item.status === "paused" ||
		hasProgress;
	const glyph = GLYPH[item.status];

	return (
		<li
			aria-current={isActive ? "step" : undefined}
			className={cn(
				"group relative flex h-9 items-center gap-2.5 px-3",
				"motion-safe:animate-[row-in_220ms_ease-out_both]",
				"transition-[background-color] duration-200 ease-out",
				isActive
					? cn(
							surfaceBg(rowLevel),
							"shadow-[inset_2px_0_0_0_var(--color-teal)]",
						)
					: "bg-transparent",
			)}
			// Per-row entrance stagger, capped so a large drop still settles fast.
			style={{ animationDelay: `${Math.min(index, 6) * 45}ms` }}
		>
			<span
				aria-hidden
				className="grid size-[14px] shrink-0 place-items-center"
			>
				<HugeiconsIcon className={glyph.cls} icon={glyph.icon} size={13} />
			</span>

			<Progress.Root
				className="flex min-w-0 flex-1 items-center gap-2"
				value={determinate ? pct : null}
			>
				<Progress.Label
					className={cn(
						"min-w-0 flex-1 truncate text-[12px] leading-none tracking-tight",
						labelClass(item.status),
					)}
					title={item.fileName}
				>
					{item.fileName}
				</Progress.Label>

				<RowStatusText item={item} pct={pct} />

				{/* Welded hairline — the row's bottom border doubles as the progress fill. */}
				<Progress.Track className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] overflow-hidden bg-foreground/10">
					<Progress.Indicator
						className={cn(
							"h-full transition-[width] duration-200 ease-out",
							indicatorClass(item.status, hasProgress),
						)}
					/>
				</Progress.Track>
				<Progress.Value className="sr-only">
					{(formatted: string | null) => formatted}
				</Progress.Value>
			</Progress.Root>

			<RowActions item={item} {...handlers} />
		</li>
	);
}
