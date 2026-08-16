import {
	Bug01Icon,
	ChevronDownIcon,
	ChevronUpIcon,
	Clock01Icon,
	CloudIcon,
	Copy01Icon,
	CopyCheckIcon,
	CpuIcon,
	Delete02Icon,
	FingerPrintIcon,
	RefreshIcon,
	StopWatchIcon,
	Tag01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "use-intl";
import { SettingSection } from "@/entities/setting";
import {
	diagClearObservabilityTimeline,
	diagObservabilityTimeline,
	type ObservabilityIssue,
} from "@/shared/api/ipc-client";
import { COPY_FEEDBACK_MS, copyToClipboard } from "@/shared/lib/clipboard";
import { cn } from "@/shared/lib/cn";
import {
	makerFromModelId,
	resolveProviderIcon,
} from "@/shared/lib/provider-icons";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { ButtonGroup } from "@/shared/ui/button-group";
import {
	EntryCard,
	type EntryCardMetaPart,
	EntryCardShell,
} from "@/shared/ui/entry-card-list";
import {
	surfaceClasses,
	surfaceHoverBg,
	useSurface,
} from "@/shared/lib/surface";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { Tooltip } from "@/shared/ui/tooltip";
import { LiveDebugLogViewer } from "./LiveDebugLogViewer";
import type { AboutT } from "./types";

// Pull a generous slice of the backend ring buffer (capped at 200) so the list
// is meaningfully scrollable rather than a fixed inline dump.
const ISSUE_FETCH_LIMIT = 50;
// Bound the scroll region so the issue list stays a contained, paginated box
// under the log console instead of growing the whole section.
const ISSUES_BODY_MAX_HEIGHT_PX = 420;
const ISSUE_DETAIL_COLLAPSE_LENGTH = 360;
const ISSUE_DETAIL_COLLAPSE_LINES = 4;

// The clipboard dump is a stable English bug-report format — it sits alongside
// the `Time:` / `Request:` / `Detail:` lines below and is deliberately NOT
// localized, so a pasted issue reads the same for maintainers in every locale.
const CLIPBOARD_REMEDIATION_LABEL = "Suggested action";

const ISSUE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	month: "short",
});

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatIssueTime(timestampMs: number): string {
	return ISSUE_TIME_FORMATTER.format(new Date(timestampMs));
}

function issueSeverityClass(severity: string): string {
	switch (severity) {
		case "error":
			return "border-error/40 bg-error/10 text-error";
		case "warn":
			return "border-warning/40 bg-warning/10 text-warning";
		default:
			return "border-border bg-surface-muted text-foreground-muted";
	}
}

function issueMeta(issue: ObservabilityIssue): string {
	const parts = [issue.area, issue.operation, issue.kind];
	if (issue.provider) {
		parts.push(issue.provider);
	}
	if (issue.modelId) {
		parts.push(issue.modelId);
	}
	if (issue.durationMs !== null && issue.durationMs !== undefined) {
		parts.push(`${issue.durationMs}ms`);
	}
	return parts.filter(Boolean).join(" / ");
}

/**
 * The per-issue data shown on the card's recessed footer shelf — the diagnostics
 * counterpart to the transcription row's meta strip: where it happened, which
 * provider/model, how long it took, and a request id for cross-referencing logs.
 */
function issueFooterParts(
	issue: ObservabilityIssue,
	t: AboutT,
): EntryCardMetaPart[] {
	const parts: EntryCardMetaPart[] = [
		{
			icon: Clock01Icon,
			key: "time",
			title: t("issuesMetaTime"),
			value: formatIssueTime(issue.timestampMs),
		},
		{
			icon: Tag01Icon,
			key: "scope",
			title: t("issuesMetaArea"),
			truncate: true,
			value: `${issue.area} / ${issue.operation} / ${issue.kind}`,
		},
	];
	if (issue.provider) {
		parts.push({
			icon: CloudIcon,
			key: "provider",
			title: t("issuesMetaProvider"),
			value: issue.provider,
		});
	}
	if (issue.modelId) {
		parts.push({
			icon: CpuIcon,
			key: "model",
			logo: resolveProviderIcon(makerFromModelId(issue.modelId)),
			title: t("issuesMetaModel"),
			truncate: true,
			value: issue.modelId,
		});
	}
	if (issue.durationMs !== null && issue.durationMs !== undefined) {
		parts.push({
			icon: StopWatchIcon,
			key: "duration",
			title: t("issuesMetaDuration"),
			value: `${issue.durationMs}ms`,
		});
	}
	if (issue.requestId) {
		parts.push({
			icon: FingerPrintIcon,
			key: "request",
			title: t("issuesMetaRequestId"),
			truncate: true,
			value: issue.requestId,
		});
	}
	return parts;
}

/** Flatten an issue into a plain-text block suitable for pasting into a bug report. */
function buildIssueClipboardText(issue: ObservabilityIssue): string {
	const lines = [
		`[${issue.severity.toUpperCase()}] ${issue.summary}`,
		issueMeta(issue),
		`Time: ${formatIssueTime(issue.timestampMs)}`,
	];
	if (issue.requestId) {
		lines.push(`Request: ${issue.requestId}`);
	}
	if (issue.detail) {
		lines.push(`Detail: ${issue.detail}`);
	}
	// The extra typed fields the backend attaches (device, provider status codes,
	// etc.) — copied verbatim so the bug report carries the WHOLE issue, not just
	// the visible summary/detail.
	if (issue.context) {
		for (const [key, value] of Object.entries(issue.context)) {
			if (value) {
				lines.push(`${key}: ${value}`);
			}
		}
	}
	if (issue.remediation) {
		lines.push(`${CLIPBOARD_REMEDIATION_LABEL}: ${issue.remediation}`);
	}
	return lines.filter(Boolean).join("\n");
}

function IssueCopyButton({ issue }: { issue: ObservabilityIssue }): ReactNode {
	const t = useTranslations("about");
	const [copied, setCopied] = useState(false);
	const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (feedbackTimerRef.current) {
				clearTimeout(feedbackTimerRef.current);
			}
		},
		[],
	);

	const handleCopy = () => {
		copyToClipboard(buildIssueClipboardText(issue));
		setCopied(true);
		if (feedbackTimerRef.current) {
			clearTimeout(feedbackTimerRef.current);
		}
		feedbackTimerRef.current = setTimeout(
			() => setCopied(false),
			COPY_FEEDBACK_MS,
		);
	};

	const label = copied ? t("issuesCopied") : t("issuesCopy");

	// Icon-swap copy control matched to the history row's CopyButton: a contained
	// size-7 glyph that cross-fades copy → check. Sitting inside the ButtonGroup
	// shell (below) it reads as its own contained control instead of a bare icon
	// floating over the badges above it.
	return (
		<Tooltip content={label}>
			<Button
				aria-label={label}
				className="relative inline-flex size-7 items-center justify-center text-foreground-muted transition-[color,background-color,transform] hover:bg-surface-hover hover:text-foreground active:scale-95"
				onClick={handleCopy}
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
			</Button>
		</Tooltip>
	);
}

interface ObservabilityTimelineState {
	error: string | null;
	issues: ObservabilityIssue[];
	loading: boolean;
}

const INITIAL_OBSERVABILITY_TIMELINE: ObservabilityTimelineState = {
	error: null,
	issues: [],
	loading: true,
};

function ObservabilityActionGroup({
	canClear,
	clearing,
	loading,
	onClear,
	onRefresh,
}: {
	canClear: boolean;
	clearing: boolean;
	loading: boolean;
	onClear: () => void;
	onRefresh: () => void;
}): ReactNode {
	return (
		<ElevatedSurface className="w-52 shrink-0 overflow-hidden" inline>
			<ObservabilityActionGroupButtons
				canClear={canClear}
				clearing={clearing}
				loading={loading}
				onClear={onClear}
				onRefresh={onRefresh}
			/>
		</ElevatedSurface>
	);
}

function ObservabilityActionGroupButtons({
	canClear,
	clearing,
	loading,
	onClear,
	onRefresh,
}: {
	canClear: boolean;
	clearing: boolean;
	loading: boolean;
	onClear: () => void;
	onRefresh: () => void;
}): ReactNode {
	const t = useTranslations("about");
	const substrate = useSurface();
	const level = Math.min(substrate + 1, 8);
	const hoverLevel = Math.min(substrate + 2, 8);
	const busy = loading || clearing;

	return (
		<div
			aria-label={t("issuesActionsLabel")}
			className={cn(
				"flex h-8 w-full overflow-hidden rounded-lg",
				surfaceClasses(level),
			)}
			role="toolbar"
		>
			<Button
				className={cn(
					"flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 px-2 text-body text-foreground leading-normal transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50",
					surfaceHoverBg(hoverLevel),
				)}
				disabled={busy}
				onClick={onRefresh}
			>
				<HugeiconsIcon
					aria-hidden="true"
					className="shrink-0 text-foreground-muted"
					icon={RefreshIcon}
					size={14}
				/>
				<span className="min-w-0 truncate">{t("issuesRefresh")}</span>
			</Button>
			<span
				aria-hidden="true"
				className="my-1.5 w-px shrink-0 self-stretch bg-divider-strong"
				data-slot="observability-action-separator"
			/>
			{/* Named explicitly: the visible text is just "Clear all", and the log
			    console in this same section has its own "Clear". Without this the two
			    are only distinguishable by their enclosing group. */}
			<Button
				aria-label={t("issuesClearAllTitle")}
				className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 px-2 font-medium text-body text-error leading-normal transition-colors duration-150 hover:bg-error-dim/40 disabled:cursor-not-allowed disabled:opacity-50"
				disabled={busy || !canClear}
				onClick={onClear}
			>
				<HugeiconsIcon
					aria-hidden="true"
					className="shrink-0 text-current"
					icon={Delete02Icon}
					size={14}
				/>
				<span className="min-w-0 truncate">{t("issuesClearAll")}</span>
			</Button>
		</div>
	);
}

function isLongIssueDetail(detail: string): boolean {
	return (
		detail.length > ISSUE_DETAIL_COLLAPSE_LENGTH ||
		detail.split(/\r?\n/).length > ISSUE_DETAIL_COLLAPSE_LINES
	);
}

function IssueDetail({ detail }: { detail: string }): ReactNode {
	const t = useTranslations("about");
	const [expanded, setExpanded] = useState(false);
	const canCollapse = isLongIssueDetail(detail);
	const label = expanded ? t("issuesShowLess") : t("issuesShowMore");

	return (
		<div className="flex min-w-0 flex-col items-start gap-1">
			<p
				className={cn(
					"min-w-0 whitespace-pre-wrap break-words text-body-sm text-foreground-muted leading-snug",
					canCollapse && !expanded && "line-clamp-4",
				)}
			>
				{detail}
			</p>
			{canCollapse ? (
				<Button
					aria-expanded={expanded}
					className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 font-medium text-accent text-body-sm transition-colors duration-150 hover:bg-accent/10"
					onClick={() => setExpanded((current) => !current)}
				>
					<HugeiconsIcon
						aria-hidden="true"
						className="shrink-0"
						icon={expanded ? ChevronUpIcon : ChevronDownIcon}
						size={13}
					/>
					<span>{label}</span>
				</Button>
			) : null}
		</div>
	);
}

function IssueCard({ issue }: { issue: ObservabilityIssue }): ReactNode {
	const t = useTranslations("about");

	return (
		<EntryCard footer={issueFooterParts(issue, t)}>
			<div className="flex items-start gap-3">
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<span className="font-medium text-body-sm text-foreground leading-snug">
						{issue.summary}
					</span>
					{issue.detail ? <IssueDetail detail={issue.detail} /> : null}
					{issue.remediation ? (
						<span className="text-body-sm text-foreground-muted leading-snug">
							{/* Each locale carries its own punctuation in the label — ja/zh
							    use a fullwidth colon, fr spaces before it — so nothing here
							    concatenates a hardcoded separator onto a translated string. */}
							<span className="font-medium text-foreground">
								{t("issuesRemediation")}
							</span>{" "}
							<span>{issue.remediation}</span>
						</span>
					) : null}
				</div>
				<div className="flex shrink-0 flex-col items-end gap-2 self-start">
					<div className="flex max-w-[8rem] flex-wrap justify-end gap-1">
						<span
							className={cn(
								"inline-flex items-center rounded-md border px-1.5 py-0.5 font-medium text-2xs uppercase leading-none",
								issueSeverityClass(issue.severity),
							)}
						>
							{issue.severity}
						</span>
						<Badge variant="outline">
							{issue.userVisible
								? t("issuesShownToUser")
								: t("issuesBackgroundOnly")}
						</Badge>
					</div>
					<ButtonGroup
						aria-label={t("issuesCopy")}
						className="shrink-0"
						connected
						orientation="vertical"
						separator="inset-strong"
					>
						<IssueCopyButton issue={issue} />
					</ButtonGroup>
				</div>
			</div>
		</EntryCard>
	);
}

function ObservabilityTimeline(): ReactNode {
	const t = useTranslations("about");
	const [timeline, setTimeline] = useState<ObservabilityTimelineState>(
		INITIAL_OBSERVABILITY_TIMELINE,
	);
	const [clearing, setClearing] = useState(false);
	const { issues, loading } = timeline;

	const refresh = () => {
		setTimeline((current) => ({ ...current, error: null, loading: true }));
		diagObservabilityTimeline(ISSUE_FETCH_LIMIT)
			.then((issues) => {
				setTimeline({ error: null, issues, loading: false });
			})
			.catch((error: unknown) => {
				setTimeline((current) => ({
					...current,
					error: errorMessage(error),
					loading: false,
				}));
			});
	};

	const clearAll = () => {
		setClearing(true);
		diagClearObservabilityTimeline()
			.then(() => {
				setTimeline({ error: null, issues: [], loading: false });
			})
			.catch((error: unknown) => {
				setTimeline((current) => ({
					...current,
					error: errorMessage(error),
					loading: false,
				}));
			})
			.finally(() => {
				setClearing(false);
			});
	};

	useEffect(() => {
		let active = true;
		diagObservabilityTimeline(ISSUE_FETCH_LIMIT)
			.then((issues) => {
				if (active) {
					setTimeline({ error: null, issues, loading: false });
				}
			})
			.catch((error: unknown) => {
				if (active) {
					setTimeline((current) => ({
						...current,
						error: errorMessage(error),
						loading: false,
					}));
				}
			});
		return () => {
			active = false;
		};
	}, []);

	let body: ReactNode;
	if (loading && issues.length === 0) {
		body = (
			<div className="px-3 py-6 text-center text-body-sm text-foreground-muted">
				{t("issuesLoading")}
			</div>
		);
	} else if (issues.length === 0) {
		body = (
			<div className="px-3 py-6 text-center text-body-sm text-foreground-muted">
				{t("issuesEmpty")}
			</div>
		);
	} else {
		body = (
			<div
				className="overflow-y-auto px-1"
				style={{
					maxHeight: ISSUES_BODY_MAX_HEIGHT_PX,
					scrollbarGutter: "stable both-edges",
					touchAction: "pan-y",
					WebkitOverflowScrolling: "touch",
				}}
			>
				{issues.map((issue) => (
					<IssueCard issue={issue} key={issue.id} />
				))}
			</div>
		);
	}

	return (
		<div className="border-border border-t pt-4 pb-3">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<span className="font-medium text-body text-foreground leading-tight">
						{t("issuesTitle")}
					</span>
					<span className="text-body-sm text-foreground-muted leading-snug">
						{t("issuesSummary")}
					</span>
				</div>
				<ObservabilityActionGroup
					canClear={issues.length > 0}
					clearing={clearing}
					loading={loading}
					onClear={clearAll}
					onRefresh={refresh}
				/>
			</div>
			<div className="mt-3">
				{timeline.error ? (
					<p className="mb-2 text-body-sm text-error" role="alert">
						{timeline.error}
					</p>
				) : null}
				<EntryCardShell bare>{body}</EntryCardShell>
			</div>
		</div>
	);
}

export function DiagnosticsSection({ t }: { t: AboutT }): ReactNode {
	// One subject, one presentation: the log console owns every log action
	// (stream, copy/clear, open folder, save bundle) in its own toolbar, so the
	// section no longer stacks separate rows for the same files.
	return (
		<SettingSection
			boxed
			description={t("diagnosticsDescription")}
			divided
			icon={Bug01Icon}
			title={t("diagnosticsTitle")}
		>
			<LiveDebugLogViewer />
			<ObservabilityTimeline />
		</SettingSection>
	);
}
