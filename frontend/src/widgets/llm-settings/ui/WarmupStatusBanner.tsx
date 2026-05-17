"use client";

import { useTranslations } from "next-intl";
import type { LlmWarmupModelStatus, LlmWarmupStatus } from "@/shared/api/ipc-client";
import { Button } from "@/shared/ui/button";

/**
 * Per-feature banner that translates warmup-status broadcasts from the
 * main process into a single message the user can act on. Renders nothing
 * when the configured model is healthy.
 *
 * Decision: we never *disable* the dictation/transforms toggle when warmup
 * fails. The user already authorized the feature by enabling it; a hard
 * disable is hostile because it bounces back to off on every retry, hides
 * the underlying cause, and makes recovery feel mysterious. Instead we
 * keep the toggle on and surface the failure inline with a specific
 * action — pull the model, install Ollama, retry — so the user can see
 * exactly what's wrong and fix it without re-enabling anything.
 */

type TranslateFn = ReturnType<typeof useTranslations>;

interface WarmupStatusBannerProps {
	feature: "dictation" | "transforms";
	model: string;
	onOpenManager?: () => void;
	onRetry?: () => void;
	provider: "ollama" | "openrouter";
	status: LlmWarmupStatus | null;
}

function findModelStatus(
	status: LlmWarmupStatus | null,
	model: string
): LlmWarmupModelStatus | null {
	if (!(status && model)) {
		return null;
	}
	return status.models.find((m) => m.model === model) ?? null;
}

/** Two severities cover the three warmup-failure outcomes: unreachable +
 *  missing-model are recoverable (start Ollama / pull the model) so they
 *  show as warnings; load-failed is the destructive case (corrupted
 *  file, OOM) so it's an error. The token strings below are the *only*
 *  per-variant difference — everything else is shared markup. */
type StatusSeverity = "warning" | "error";

const STATUS_SEVERITY_CLASSES: Record<
	StatusSeverity,
	{ container: string; button: string; detail: string }
> = {
	warning: {
		container: "col-span-2 rounded bg-warning/10 p-3 text-sm text-warning",
		button:
			"rounded border border-warning/40 bg-warning/10 px-3 py-1 text-warning text-xs transition-colors hover:bg-warning/20",
		detail: "mt-2 max-h-20 overflow-auto rounded bg-warning/5 p-2 font-mono text-xs",
	},
	error: {
		container: "col-span-2 rounded bg-error/10 p-3 text-error text-sm",
		button:
			"rounded border border-error/40 bg-error/10 px-3 py-1 text-error text-xs transition-colors hover:bg-error/20",
		detail: "mt-2 max-h-20 overflow-auto rounded bg-error/5 p-2 font-mono text-xs",
	},
};

interface StatusBannerProps {
	action?: { label: string; onClick: () => void };
	description: string;
	/** Verbatim server error body shown in a monospace box. Used only by
	 *  load-failed today; other variants omit this and get no detail box. */
	detail?: string;
	severity: StatusSeverity;
	title: string;
}

/** One banner for all three warmup-failure outcomes. Caller picks the
 *  severity + supplies strings/action; per-variant token lookups happen
 *  in {@link STATUS_SEVERITY_CLASSES} so the JSX shape stays single-
 *  source. Restyling the banner later only touches this one function. */
function StatusBanner({ action, detail, description, severity, title }: StatusBannerProps) {
	const classes = STATUS_SEVERITY_CLASSES[severity];
	return (
		<div aria-live="polite" className={classes.container} role="status">
			<div className="font-medium">{title}</div>
			<div className="mt-1">{description}</div>
			{detail ? <div className={classes.detail}>{detail}</div> : null}
			{action ? (
				<div className="mt-2">
					<Button className={classes.button} onClick={action.onClick}>
						{action.label}
					</Button>
				</div>
			) : null}
		</div>
	);
}

function buildUnreachableProps(
	feature: "dictation" | "transforms",
	installed: boolean,
	t: TranslateFn,
	onRetry?: () => void
): StatusBannerProps {
	const featureLabel = t(
		feature === "dictation" ? "warmupFeatureDictation" : "warmupFeatureTransforms"
	);
	return {
		severity: "warning",
		title: t("warmupOllamaUnreachableTitle"),
		description: installed
			? t("warmupOllamaUnreachableInstalled")
			: t("warmupOllamaUnreachableMissing", { feature: featureLabel }),
		action: onRetry ? { label: t("warmupRetryNow"), onClick: onRetry } : undefined,
	};
}

function buildModelMissingProps(
	model: string,
	t: TranslateFn,
	onOpenManager?: () => void
): StatusBannerProps {
	return {
		severity: "warning",
		title: t("warmupModelMissingTitle", { model }),
		description: t("warmupModelMissingDescription"),
		action: onOpenManager ? { label: t("warmupOpenManager"), onClick: onOpenManager } : undefined,
	};
}

function buildLoadFailedProps(
	model: string,
	errorBody: string | undefined,
	t: TranslateFn,
	onOpenManager?: () => void
): StatusBannerProps {
	return {
		severity: "error",
		title: t("warmupModelLoadFailedTitle", { model }),
		description: t("warmupModelLoadFailedDescription"),
		detail: errorBody,
		action: onOpenManager ? { label: t("warmupOpenManager"), onClick: onOpenManager } : undefined,
	};
}

export function WarmupStatusBanner({
	feature,
	model,
	provider,
	status,
	onOpenManager,
	onRetry,
}: WarmupStatusBannerProps) {
	const t = useTranslations("llm");

	// Status broadcasts only describe Ollama warmups. OpenRouter has no
	// cold-start to surface; the existing OpenRouter API-key check already
	// gates that path at toggle time.
	if (provider !== "ollama") {
		return null;
	}

	// `null` reachability = "no Ollama feature enabled right now" — the
	// banner has nothing to say. `false` reachability is the genuine
	// "Ollama is down" case and applies to all enabled models.
	if (status?.reachable === false) {
		return <StatusBanner {...buildUnreachableProps(feature, status.ollamaInstalled, t, onRetry)} />;
	}

	const modelStatus = findModelStatus(status, model);
	if (!modelStatus) {
		return null;
	}
	if (modelStatus.outcome === "model-not-found") {
		return <StatusBanner {...buildModelMissingProps(model, t, onOpenManager)} />;
	}
	if (modelStatus.outcome === "load-failed") {
		return (
			<StatusBanner {...buildLoadFailedProps(model, modelStatus.errorBody, t, onOpenManager)} />
		);
	}
	return null;
}

// Test-only exports
export const __warmup_banner_test_helpers__ = {
	findModelStatus,
};
