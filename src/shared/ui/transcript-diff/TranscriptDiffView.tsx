import {
	AiBrain02Icon,
	Cancel01Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button as BaseButton } from "@base-ui/react/button";
import { Fragment } from "react";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import type { TranscriptDiffResult } from "@/shared/lib/transcript-diff";

/**
 * Strings the diff view renders. Kept as props (not a fixed i18n namespace) so
 * the SAME component serves the read-only history hover diff (`history.diff*`
 * keys) and the interactive preview-enhance diff (`preview.*` keys) — "the same
 * diff view" in both places without coupling shared UI to one namespace.
 */
export interface TranscriptDiffLabels {
	aiEdits: string;
	before: string;
	after: string;
	inserted: string;
	removed: string;
	largeRewrite: string;
	changeCount: (count: number) => string;
	moreChanges: (count: number) => string;
}

/**
 * Optional interactive layer. When present, the view becomes a cherry-pick
 * reviewer: every AI change starts ACCEPTED; `rejected` holds the change
 * ordinals the user reverted (same order as {@link TranscriptDiffResult.changes}).
 * Each change exposes a ✓/✗ toggle; the footer offers Discard + a single commit
 * button (label supplied as `applyLabel`, e.g. "Accept all" / "Apply edits").
 */
export interface TranscriptDiffReview {
	rejected: ReadonlySet<number>;
	onToggle: (changeIndex: number) => void;
	/** Commit the CURRENT decisions (≡ accept-all when nothing is rejected). */
	onCommit: () => void;
	onDiscard: () => void;
	/** Adapts in the parent: "Accept all" when nothing rejected, else "Apply edits". */
	applyLabel: string;
	discardLabel: string;
	acceptLabel: string;
	rejectLabel: string;
}

interface TranscriptDiffViewProps {
	diff: TranscriptDiffResult;
	labels: TranscriptDiffLabels;
	/** Provide to enable per-change accept/deny + commit footer. Omit = read-only. */
	review?: TranscriptDiffReview;
}

const DIFF_SUMMARY_LIMIT = 6;

function truncateDiffSnippet(text: string, max = 38): string {
	if (text.length <= max) {
		return text;
	}
	return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Per-hunk change ordinal (−1 for equal hunks), aligned with `diff.changes`. */
function hunkChangeOrdinals(diff: TranscriptDiffResult): number[] {
	let ordinal = 0;
	return diff.hunks.map((hunk) => (hunk.kind === "change" ? ordinal++ : -1));
}

function ReviewToggle({
	active,
	kind,
	label,
	onClick,
}: {
	active: boolean;
	kind: "accept" | "reject";
	label: string;
	onClick: () => void;
}) {
	const accent =
		kind === "accept"
			? "text-success bg-success/15 ring-success/40"
			: "text-error bg-error/15 ring-error/40";
	return (
		<BaseButton
			aria-label={label}
			aria-pressed={active}
			className={cn(
				"inline-flex size-5 shrink-0 items-center justify-center rounded-full ring-1 transition-colors",
				active
					? accent
					: "text-foreground-muted ring-transparent hover:bg-foreground/10 hover:text-foreground",
			)}
			onClick={onClick}
			title={label}
			type="button"
		>
			<HugeiconsIcon
				icon={kind === "accept" ? Tick02Icon : Cancel01Icon}
				size={12}
			/>
		</BaseButton>
	);
}

function DiffChangeChip({
	change,
	changeIndex,
	labels,
	review,
}: {
	change: TranscriptDiffResult["changes"][number];
	changeIndex: number;
	labels: TranscriptDiffLabels;
	review?: TranscriptDiffReview | undefined;
}) {
	const rejected = review?.rejected.has(changeIndex) ?? false;
	const before = change.before
		? truncateDiffSnippet(change.before)
		: labels.inserted;
	const after = change.after
		? truncateDiffSnippet(change.after)
		: labels.removed;
	return (
		<span
			className={cn(
				"inline-flex min-w-0 max-w-full items-center gap-1 rounded-md bg-foreground/[0.04] px-1.5 py-1 text-[11px] leading-none ring-1 ring-divider ring-inset",
				rejected && "opacity-60",
			)}
			title={
				change.kind === "insert"
					? change.after
					: change.kind === "delete"
						? change.before
						: `${change.before} → ${change.after}`
			}
		>
			{change.before ? (
				<span className="min-w-0 max-w-[9rem] truncate rounded bg-error-dim/40 px-1 text-error line-through decoration-error/70">
					{before}
				</span>
			) : (
				<span className="text-foreground-muted">{before}</span>
			)}
			<span className="shrink-0 text-foreground-muted">→</span>
			{change.after ? (
				<span
					className={cn(
						"min-w-0 max-w-[9rem] truncate rounded bg-success-dim/50 px-1 text-success",
						rejected &&
							"bg-foreground/5 text-foreground-muted line-through decoration-foreground-muted/60",
					)}
				>
					{after}
				</span>
			) : (
				<span className="text-foreground-muted">{after}</span>
			)}
			{review ? (
				<span className="ml-0.5 flex shrink-0 items-center gap-0.5">
					<ReviewToggle
						active={!rejected}
						kind="accept"
						label={review.acceptLabel}
						onClick={() => {
							if (rejected) {
								review.onToggle(changeIndex);
							}
						}}
					/>
					<ReviewToggle
						active={rejected}
						kind="reject"
						label={review.rejectLabel}
						onClick={() => {
							if (!rejected) {
								review.onToggle(changeIndex);
							}
						}}
					/>
				</span>
			) : null}
		</span>
	);
}

function DiffText({
	diff,
	ordinals,
	rejected,
	side,
}: {
	diff: TranscriptDiffResult;
	ordinals: number[];
	rejected?: ReadonlySet<number> | undefined;
	side: "after" | "before";
}) {
	return (
		<p className="whitespace-pre-wrap break-words text-body-sm text-foreground leading-relaxed">
			{diff.hunks.map((hunk, index) => {
				const text = side === "before" ? hunk.before : hunk.after;
				if (!text) {
					return null;
				}
				const isRejected =
					hunk.kind === "change" &&
					side === "after" &&
					(rejected?.has(ordinals[index] ?? -1) ?? false);
				let className: string | undefined;
				if (hunk.kind === "change") {
					if (side === "before") {
						className =
							"rounded-[3px] bg-error-dim/45 px-0.5 text-error line-through decoration-error/70";
					} else if (isRejected) {
						className =
							"rounded-[3px] bg-foreground/5 px-0.5 text-foreground-muted line-through decoration-foreground-muted/60";
					} else {
						className = "rounded-[3px] bg-success-dim/55 px-0.5 text-success";
					}
				}
				return (
					<Fragment key={`${side}-${index}`}>
						{index > 0 ? " " : null}
						<span className={className}>{text}</span>
					</Fragment>
				);
			})}
		</p>
	);
}

/**
 * Two-column transcript diff (Previous vs AI edits) with change-summary chips —
 * the history hover view, made reusable. Pass `review` to turn it into a
 * cherry-pick reviewer (per-change ✓/✗ + Discard / commit footer).
 */
export function TranscriptDiffView({
	diff,
	labels,
	review,
}: TranscriptDiffViewProps) {
	const panelLevel = Math.max(useSurface() - 1, 1);
	const reviewing = review !== undefined;
	const ordinals = hunkChangeOrdinals(diff);
	// In review mode every change needs its own control, so show them all; the
	// read-only summary caps at DIFF_SUMMARY_LIMIT with a "+N more" pill.
	const shownChanges = reviewing
		? diff.changes
		: diff.changes.slice(0, DIFF_SUMMARY_LIMIT);
	const hiddenChanges = reviewing
		? 0
		: Math.max(diff.changes.length - DIFF_SUMMARY_LIMIT, 0);
	const changeCount = labels.changeCount(diff.changes.length);

	return (
		<div className="flex flex-col gap-2.5">
			<div className="flex flex-wrap items-center gap-2 border-divider border-b pb-2.5">
				<span className="inline-flex items-center gap-1 rounded-md bg-accent-glow px-1.5 py-1 font-medium text-[11px] text-accent leading-none ring-1 ring-accent/20 ring-inset">
					<HugeiconsIcon
						aria-hidden="true"
						className="size-3"
						icon={AiBrain02Icon}
					/>
					{labels.aiEdits}
				</span>
				<span className="text-[11px] text-foreground-muted leading-none">
					{diff.coarse
						? `${changeCount} · ${labels.largeRewrite}`
						: changeCount}
				</span>
			</div>

			<div className="flex flex-wrap gap-1.5">
				{shownChanges.map((change, index) => (
					<DiffChangeChip
						change={change}
						changeIndex={index}
						key={`${change.kind}-${index}`}
						labels={labels}
						review={review}
					/>
				))}
				{hiddenChanges > 0 ? (
					<span className="inline-flex items-center rounded-md bg-foreground/[0.04] px-1.5 py-1 text-[11px] text-foreground-muted leading-none ring-1 ring-divider ring-inset">
						{labels.moreChanges(hiddenChanges)}
					</span>
				) : null}
			</div>

			<div className="grid gap-2 sm:grid-cols-2">
				<section
					className={cn(
						"min-w-0 rounded-lg p-2.5 ring-1 ring-divider ring-inset",
						surfaceBg(panelLevel),
					)}
				>
					<div className="mb-1.5 flex items-center gap-1.5 font-medium text-[11px] text-foreground-muted uppercase leading-none tracking-[0.08em]">
						<span
							aria-hidden="true"
							className="size-1.5 rounded-full bg-error/70"
						/>
						{labels.before}
					</div>
					<DiffText diff={diff} ordinals={ordinals} side="before" />
				</section>
				<section
					className={cn(
						"min-w-0 rounded-lg p-2.5 ring-1 ring-divider ring-inset",
						surfaceBg(panelLevel),
					)}
				>
					<div className="mb-1.5 flex items-center gap-1.5 font-medium text-[11px] text-foreground-muted uppercase leading-none tracking-[0.08em]">
						<span
							aria-hidden="true"
							className="size-1.5 rounded-full bg-success/70"
						/>
						{labels.after}
					</div>
					<DiffText
						diff={diff}
						ordinals={ordinals}
						rejected={review?.rejected}
						side="after"
					/>
				</section>
			</div>

			{review ? (
				<div className="flex items-center justify-end gap-2">
					<BaseButton
						className="rounded-md border border-border px-3 py-1.5 text-foreground-muted text-sm transition-colors hover:text-foreground"
						onClick={review.onDiscard}
						type="button"
					>
						{review.discardLabel}
					</BaseButton>
					<BaseButton
						className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 font-medium text-on-accent text-sm shadow-action-accent transition-[background-color,box-shadow] hover:bg-accent-hover hover:shadow-action-accent-hover"
						onClick={review.onCommit}
						type="button"
					>
						<HugeiconsIcon icon={Tick02Icon} size={15} />
						{review.applyLabel}
					</BaseButton>
				</div>
			) : null}
		</div>
	);
}
