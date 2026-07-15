"use client";

import { Input } from "@base-ui/react/input";
import { BrainIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { cn } from "@/shared/lib/cn";
import { InfoTooltip } from "@/shared/ui/info-tooltip";
import type {
	ReasoningEffort,
	Verbosity,
} from "../config/model-selector-options";
import { ReasoningEffortDropdown } from "./ReasoningEffortDropdown";
import { VerbosityDropdown } from "./VerbosityDropdown";

export interface ReasoningControlsProps {
	className?: string | undefined;
	effectiveReasoningEffort: ReasoningEffort;
	effectiveVerbosity: Verbosity;
	isReasoningSelected: boolean;
	maxOutputTokens?: number | null | undefined;
	onMaxOutputTokensChange?: ((value: number | null) => void) | undefined;
	onReasoningEffortChange?: ((value: ReasoningEffort) => void) | undefined;
	onVerbosityChange?: ((value: Verbosity) => void) | undefined;
	supportsMaxTokens: boolean;
	supportsVerbosity: boolean;
}

const REASONING_TIP =
	"Tell reasoning models how much internal thinking they should do before responding. Higher effort improves quality on hard tasks at the cost of latency and tokens.";

const VERBOSITY_TIP =
	"Control how concise or expansive the model's reply should be. Verbose responses include more detail and reasoning summary.";

const RESPONSE_LENGTH_TIP =
	"Cap the response length. Leave blank to let the model decide based on the request.";

function FieldLabel({
	children,
	tip,
}: {
	children: React.ReactNode;
	tip: string;
}) {
	return (
		<div className="flex min-w-0 flex-wrap items-center gap-1 text-xs uppercase tracking-wide">
			<span className="min-w-0 break-words text-foreground-secondary">
				{children}
			</span>
			<InfoTooltip content={tip} />
		</div>
	);
}

/**
 * Bundles the three OpenRouter request-parameter controls — reasoning effort,
 * verbosity, and max output tokens — into a single grid. Each control auto-
 * hides when the selected model doesn't advertise support for it, so the
 * whole block collapses for non-reasoning chat models.
 */
export function ReasoningControls({
	className,
	effectiveReasoningEffort,
	effectiveVerbosity,
	isReasoningSelected,
	maxOutputTokens,
	onMaxOutputTokensChange,
	onReasoningEffortChange,
	onVerbosityChange,
	supportsMaxTokens,
	supportsVerbosity,
}: ReasoningControlsProps) {
	const t = useTranslations("modelPicker");
	// Non-empty input that doesn't parse to a positive integer is silently
	// dropped below; surface a brief hint instead so the user isn't left
	// wondering why "0" or a stray letter had no effect.
	const [maxTokensInvalid, setMaxTokensInvalid] = useState(false);
	const showReasoning = isReasoningSelected && !!onReasoningEffortChange;
	const showVerbosity = supportsVerbosity && !!onVerbosityChange;
	const showMaxTokens = supportsMaxTokens && !!onMaxOutputTokensChange;

	if (!(showReasoning || showVerbosity || showMaxTokens)) {
		return null;
	}

	const handleMaxTokensInput = (raw: string) => {
		if (!onMaxOutputTokensChange) {
			return;
		}
		if (raw === "") {
			setMaxTokensInvalid(false);
			onMaxOutputTokensChange(null);
			return;
		}
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed > 0) {
			setMaxTokensInvalid(false);
			onMaxOutputTokensChange(parsed);
			return;
		}
		// Keep the previously committed value, but flag the rejected input.
		setMaxTokensInvalid(true);
	};

	return (
		<div
			className={cn(
				"grid grid-cols-1 gap-3 rounded-md border border-border bg-surface-secondary/40 p-3 md:grid-cols-2 xl:grid-cols-3",
				className,
			)}
			data-slot="reasoning-controls"
		>
			{showReasoning ? (
				<div className="min-w-0 space-y-1">
					<FieldLabel tip={REASONING_TIP}>{t("reasoningEffort")}</FieldLabel>
					<ReasoningEffortDropdown
						disabled={!onReasoningEffortChange}
						onChange={(next) => onReasoningEffortChange?.(next)}
						value={effectiveReasoningEffort}
					/>
				</div>
			) : null}
			{showVerbosity ? (
				<div className="min-w-0 space-y-1">
					<FieldLabel tip={VERBOSITY_TIP}>{t("verbosity")}</FieldLabel>
					<VerbosityDropdown
						disabled={!onVerbosityChange}
						onChange={(next) => onVerbosityChange?.(next)}
						value={effectiveVerbosity}
					/>
				</div>
			) : null}
			{showMaxTokens ? (
				<div className="min-w-0 space-y-1">
					<FieldLabel tip={RESPONSE_LENGTH_TIP}>
						{t("maxOutputTokens")}
					</FieldLabel>
					<div className="flex h-9 items-center gap-1 rounded-sm border border-border bg-surface-secondary/60 px-2">
						<HugeiconsIcon
							aria-hidden="true"
							className="size-3.5 shrink-0 text-foreground-muted"
							icon={BrainIcon}
						/>
						<Input
							aria-invalid={maxTokensInvalid || undefined}
							aria-label="Max output tokens"
							className="h-full w-full bg-transparent text-body text-foreground tabular-nums outline-none placeholder:text-foreground-muted"
							inputMode="numeric"
							min={1}
							onChange={(e) => handleMaxTokensInput(e.target.value)}
							placeholder="Default"
							type="number"
							value={maxOutputTokens ?? ""}
						/>
					</div>
					{maxTokensInvalid ? (
						<p
							aria-live="polite"
							className="text-error text-xs-tight leading-[14px]"
							role="alert"
						>
							{t("maxOutputTokensInvalid")}
						</p>
					) : null}
				</div>
			) : null}
		</div>
	);
}
