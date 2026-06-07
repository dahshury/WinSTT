/* eslint-disable i18next/no-literal-string -- debug-only window, not user-facing/shipped */
import { Button as BaseButton } from "@base-ui/react/button";
import { cn } from "@/shared/lib/cn";
import type { ContextPlaygroundController } from "../model/use-context-playground";
import { CopyButton } from "./CopyButton";

export function Header({
	ctl,
	now,
}: {
	ctl: ContextPlaygroundController;
	now: number;
}) {
	const { report, live, deepArmed } = ctl;
	const age = report ? formatAge(now - report.capturedAt) : null;

	return (
		<header className="flex shrink-0 flex-wrap items-center gap-2 border-border border-b bg-surface-primary px-3 py-2">
			<span className="font-semibold text-body-sm">Context Playground</span>
			<span className="rounded bg-warning-dim px-1.5 py-0.5 font-mono text-[10px] text-warning">
				DEBUG
			</span>

			<BaseButton
				className={cn(
					"flex items-center gap-1.5 rounded px-2 py-1 text-[11px] transition-colors",
					live
						? "bg-success-dim text-success"
						: "bg-surface-tertiary text-foreground-muted",
				)}
				onClick={ctl.toggleLive}
				type="button"
			>
				<span
					className={cn(
						"h-2 w-2 rounded-full",
						live ? "animate-pulse bg-success" : "bg-foreground-dim",
					)}
				/>
				{live ? "LIVE" : "PAUSED"}
			</BaseButton>

			<BaseButton
				className={cn(
					"rounded px-2 py-1 text-[11px] transition-colors",
					deepArmed
						? "bg-accent-glow-strong text-accent"
						: "bg-surface-tertiary text-foreground hover:bg-surface-hover",
				)}
				disabled={deepArmed}
				onClick={ctl.armDeep}
				type="button"
			>
				{deepArmed ? "Armed — focus target…" : "Deep capture (all modes)"}
			</BaseButton>

			<div className="ml-auto flex items-center gap-2 text-[11px] text-foreground-muted">
				{report ? (
					<>
						<span>{age}</span>
						<span className="text-foreground-dim">·</span>
						<span>{report.durationMs}ms</span>
						<CopyButton report={report} />
					</>
				) : (
					<span className="text-foreground-dim">no capture yet</span>
				)}
			</div>
		</header>
	);
}

function formatAge(deltaMs: number): string {
	const secs = Math.max(0, Math.round(deltaMs / 1000));
	if (secs < 1) {
		return "just now";
	}
	if (secs < 60) {
		return `${secs}s ago`;
	}
	const mins = Math.floor(secs / 60);
	return `${mins}m ago`;
}
