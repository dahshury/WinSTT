import {
	Bug01Icon,
	Clock01Icon,
	CloudIcon,
	Copy01Icon,
	CpuIcon,
	FileZipIcon,
	FingerPrintIcon,
	Folder01Icon,
	RefreshIcon,
	StopWatchIcon,
	Tag01Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { SettingSection } from "@/entities/setting";
import {
	diagObservabilityTimeline,
	diagOpenLogsFolder,
	diagSaveBundle,
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
import {
	EntryCard,
	type EntryCardMetaPart,
	EntryCardShell,
} from "@/shared/ui/entry-card-list";
import { AboutActionButton } from "./AboutActionButton";
import { AboutActionRow } from "./AboutActionRow";
import type { AboutT } from "./types";

const OBSERVABILITY_COPY = {
	backgroundOnly: "Background only",
	copied: "Copied",
	copy: "Copy issue",
	empty: "No recent operational issues recorded.",
	loading: "Loading recent issues...",
	recentSummary:
		"Latest startup, model, provider, download, and inference failures captured locally.",
	recentTitle: "Recent Operational Issues",
	refresh: "Refresh",
	remediationLabel: "Suggested action: ",
	shownToUser: "Shown to user",
};

// Pull a generous slice of the backend ring buffer (capped at 200) so the list
// is meaningfully scrollable rather than a fixed inline dump.
const ISSUE_FETCH_LIMIT = 50;
// Bound the scroll region so the issue list stays a contained, paginated box
// under the diagnostics actions instead of growing the whole section.
const ISSUES_BODY_MAX_HEIGHT_PX = 420;

const ISSUE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	month: "short",
});

const handleOpenLogsFolder = async () => {
	await diagOpenLogsFolder();
};

const handleSaveDiagnosticBundle = async () => {
	await diagSaveBundle();
};

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
function issueFooterParts(issue: ObservabilityIssue): EntryCardMetaPart[] {
	const parts: EntryCardMetaPart[] = [
		{
			icon: Clock01Icon,
			key: "time",
			title: "Time",
			value: formatIssueTime(issue.timestampMs),
		},
		{
			icon: Tag01Icon,
			key: "scope",
			title: "Area / operation / kind",
			truncate: true,
			value: `${issue.area} / ${issue.operation} / ${issue.kind}`,
		},
	];
	if (issue.provider) {
		parts.push({
			icon: CloudIcon,
			key: "provider",
			title: "Provider",
			value: issue.provider,
		});
	}
	if (issue.modelId) {
		parts.push({
			icon: CpuIcon,
			key: "model",
			logo: resolveProviderIcon(makerFromModelId(issue.modelId)),
			title: "Model",
			truncate: true,
			value: issue.modelId,
		});
	}
	if (issue.durationMs !== null && issue.durationMs !== undefined) {
		parts.push({
			icon: StopWatchIcon,
			key: "duration",
			title: "Duration",
			value: `${issue.durationMs}ms`,
		});
	}
	if (issue.requestId) {
		parts.push({
			icon: FingerPrintIcon,
			key: "request",
			title: "Request id",
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
	if (issue.remediation) {
		lines.push(`${OBSERVABILITY_COPY.remediationLabel}${issue.remediation}`);
	}
	return lines.filter(Boolean).join("\n");
}

function IssueCopyButton({ issue }: { issue: ObservabilityIssue }): ReactNode {
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

	const label = copied ? OBSERVABILITY_COPY.copied : OBSERVABILITY_COPY.copy;

	return (
		<Button
			aria-label={label}
			className={cn(
				"flex items-center gap-1 px-2 py-1 text-xs transition-colors",
				copied ? "text-accent" : "hover:text-accent",
			)}
			onClick={handleCopy}
			title={label}
		>
			<HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={14} />
		</Button>
	);
}

interface ObservabilityTimelineState {
	issues: ObservabilityIssue[];
	loading: boolean;
}

const INITIAL_OBSERVABILITY_TIMELINE: ObservabilityTimelineState = {
	issues: [],
	loading: true,
};

function IssueCard({ issue }: { issue: ObservabilityIssue }): ReactNode {
	return (
		<EntryCard footer={issueFooterParts(issue)}>
			<div className="flex items-start gap-3">
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<span className="font-medium text-body-sm text-foreground leading-snug">
						{issue.summary}
					</span>
					{issue.detail ? (
						<span className="text-body-sm text-foreground-muted leading-snug">
							{issue.detail}
						</span>
					) : null}
					{issue.remediation ? (
						<span className="text-body-sm text-foreground-muted leading-snug">
							<span className="font-medium text-foreground">
								{OBSERVABILITY_COPY.remediationLabel}
							</span>
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
								? OBSERVABILITY_COPY.shownToUser
								: OBSERVABILITY_COPY.backgroundOnly}
						</Badge>
					</div>
					<IssueCopyButton issue={issue} />
				</div>
			</div>
		</EntryCard>
	);
}

function ObservabilityTimeline(): ReactNode {
	const [timeline, setTimeline] = useState<ObservabilityTimelineState>(
		INITIAL_OBSERVABILITY_TIMELINE,
	);
	const { issues, loading } = timeline;

	const refresh = () => {
		setTimeline((current) => ({ ...current, loading: true }));
		diagObservabilityTimeline(ISSUE_FETCH_LIMIT)
			.then((issues) => {
				setTimeline({ issues, loading: false });
			})
			.catch(() => {
				setTimeline((current) => ({ ...current, loading: false }));
			});
	};

	useEffect(() => {
		let active = true;
		diagObservabilityTimeline(ISSUE_FETCH_LIMIT)
			.then((issues) => {
				if (active) {
					setTimeline({ issues, loading: false });
				}
			})
			.catch(() => {
				if (active) {
					setTimeline((current) => ({ ...current, loading: false }));
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
				{OBSERVABILITY_COPY.loading}
			</div>
		);
	} else if (issues.length === 0) {
		body = (
			<div className="px-3 py-6 text-center text-body-sm text-foreground-muted">
				{OBSERVABILITY_COPY.empty}
			</div>
		);
	} else {
		body = (
			<div
				className="overflow-y-auto"
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
		<div className="border-border border-t pt-4">
			<div className="flex items-start gap-4">
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<span className="font-medium text-body text-foreground leading-tight">
						{OBSERVABILITY_COPY.recentTitle}
					</span>
					<span className="text-body-sm text-foreground-muted leading-snug">
						{OBSERVABILITY_COPY.recentSummary}
					</span>
				</div>
				<AboutActionButton icon={RefreshIcon} onClick={refresh}>
					{OBSERVABILITY_COPY.refresh}
				</AboutActionButton>
			</div>
			<div className="mt-3">
				<EntryCardShell>{body}</EntryCardShell>
			</div>
		</div>
	);
}

export function DiagnosticsSection({ t }: { t: AboutT }): ReactNode {
	return (
		<SettingSection
			description={t("diagnosticsDescription")}
			divided
			icon={Bug01Icon}
			title={t("diagnosticsTitle")}
		>
			<AboutActionRow
				buttonLabel={t("openLogsFolder")}
				icon={Folder01Icon}
				onClick={handleOpenLogsFolder}
				summary={t("openLogsFolderSummary")}
				title={t("openLogsFolder")}
			/>
			<AboutActionRow
				buttonLabel={t("saveDiagnosticBundleButton")}
				icon={FileZipIcon}
				onClick={handleSaveDiagnosticBundle}
				summary={t("saveDiagnosticBundleSummary")}
				title={t("saveDiagnosticBundle")}
			/>
			<ObservabilityTimeline />
		</SettingSection>
	);
}
