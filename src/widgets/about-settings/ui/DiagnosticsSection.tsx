import {
	Bug01Icon,
	FileZipIcon,
	Folder01Icon,
	RefreshIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { useEffect, useState, type ReactNode } from "react";
import { SettingSection } from "@/entities/setting";
import {
	diagObservabilityTimeline,
	diagOpenLogsFolder,
	diagSaveBundle,
	type ObservabilityIssue,
} from "@/shared/api/ipc-client";
import { AboutActionButton } from "./AboutActionButton";
import type { AboutT } from "./types";

const OBSERVABILITY_COPY = {
	backgroundOnly: "Background only",
	empty: "No recent operational issues recorded.",
	loading: "Loading recent issues...",
	recentSummary:
		"Latest startup, model, provider, download, and inference failures captured locally.",
	recentTitle: "Recent Operational Issues",
	refresh: "Refresh",
	remediationLabel: "Suggested action: ",
	shownToUser: "Shown to user",
};

const ISSUE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	month: "short",
});

interface DiagnosticsActionRowProps {
	buttonLabel: string;
	icon: IconSvgElement;
	onClick: () => void;
	summary: string;
	title: string;
}

function DiagnosticsActionRow({
	buttonLabel,
	icon,
	onClick,
	summary,
	title,
}: DiagnosticsActionRowProps): ReactNode {
	return (
		<div className="flex items-center gap-4 py-3">
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<span className="font-medium text-body text-foreground leading-tight">
					{title}
				</span>
				<span className="text-body-sm text-foreground-muted leading-snug">
					{summary}
				</span>
			</div>
			<AboutActionButton icon={icon} onClick={onClick}>
				{buttonLabel}
			</AboutActionButton>
		</div>
	);
}

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

interface ObservabilityTimelineState {
	issues: ObservabilityIssue[];
	loading: boolean;
}

const INITIAL_OBSERVABILITY_TIMELINE: ObservabilityTimelineState = {
	issues: [],
	loading: true,
};

function ObservabilityTimeline(): ReactNode {
	const [timeline, setTimeline] = useState<ObservabilityTimelineState>(
		INITIAL_OBSERVABILITY_TIMELINE,
	);
	const { issues, loading } = timeline;

	const refresh = () => {
		setTimeline((current) => ({ ...current, loading: true }));
		diagObservabilityTimeline(10)
			.then((issues) => {
				setTimeline({ issues, loading: false });
			})
			.catch(() => {
				setTimeline((current) => ({ ...current, loading: false }));
			});
	};

	useEffect(() => {
		let active = true;
		diagObservabilityTimeline(10)
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

			{loading && issues.length === 0 ? (
				<p className="mt-3 text-body-sm text-foreground-muted">
					{OBSERVABILITY_COPY.loading}
				</p>
			) : null}

			{!loading && issues.length === 0 ? (
				<p className="mt-3 text-body-sm text-foreground-muted">
					{OBSERVABILITY_COPY.empty}
				</p>
			) : null}

			{issues.length > 0 ? (
				<ol className="mt-3 flex flex-col gap-2">
					{issues.map((issue) => (
						<li
							className="rounded-md border border-border bg-surface px-3 py-2"
							key={issue.id}
						>
							<div className="flex flex-wrap items-center gap-2">
								<span
									className={`rounded-sm border px-1.5 py-0.5 font-medium text-[11px] uppercase ${issueSeverityClass(issue.severity)}`}
								>
									{issue.severity}
								</span>
								<span className="text-body-sm text-foreground-muted">
									{formatIssueTime(issue.timestampMs)}
								</span>
								<span className="text-body-sm text-foreground-muted">
									{issue.userVisible
										? OBSERVABILITY_COPY.shownToUser
										: OBSERVABILITY_COPY.backgroundOnly}
								</span>
							</div>
							<div className="mt-2 flex flex-col gap-1">
								<span className="font-medium text-body-sm text-foreground leading-snug">
									{issue.summary}
								</span>
								<span className="text-[12px] text-foreground-muted leading-snug">
									{issueMeta(issue)}
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
						</li>
					))}
				</ol>
			) : null}
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
			<DiagnosticsActionRow
				buttonLabel={t("openLogsFolder")}
				icon={Folder01Icon}
				onClick={handleOpenLogsFolder}
				summary={t("openLogsFolderSummary")}
				title={t("openLogsFolder")}
			/>
			<DiagnosticsActionRow
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
