"use client";

import type { FitAssessmentEntry } from "@/shared/api/ipc-client";
import { formatBytes } from "@/shared/lib/format-bytes";
import { OptInDialog } from "@/shared/ui/opt-in-dialog";

export type ResourceWarningKind = "dictation" | "ollama";

export interface ResourceWarningDialogProps {
	assessment: FitAssessmentEntry | null;
	cancelLabel: string;
	/** Display name shown in the title and body so the user knows what
	 *  candidate they're being warned about. */
	candidateName: string;
	confirmLabel: string;
	kind: ResourceWarningKind;
	onCancel: () => void;
	onConfirm: () => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	t: (key: string, vars?: Record<string, string | number>) => string;
}

/** Map a reason code to its localized line. We render every applicable
 * reason as a bullet so the user sees the full picture (e.g. "STT model
 * already uses your GPU" + "Candidate exceeds remaining VRAM"). */
function reasonLine(
	reason: FitAssessmentEntry["reasons"][number],
	available: string,
	required: string,
	t: ResourceWarningDialogProps["t"]
): string | null {
	switch (reason) {
		case "exceeds_vram":
			return t("reasonExceedsVram", { required, available });
		case "exceeds_ram":
			return t("reasonExceedsRam", { required, available });
		case "tight_vram":
			return t("reasonTightVram", { required, available });
		case "tight_ram":
			return t("reasonTightRam", { required, available });
		case "no_gpu_available":
			return t("reasonNoGpu");
		case "requires_cpu_quant":
			return t("reasonRequiresCpuQuant");
		case "stt_already_uses_gpu":
			return t("reasonSttUsesGpu");
		case "stt_already_uses_ram":
			return t("reasonSttUsesRam");
		case "unknown_footprint":
			return t("reasonUnknownFootprint");
		case "ok":
			return null;
		default:
			return null;
	}
}

/** Resource-warning modal that requires explicit "Proceed anyway" from
 * the user. Built on the existing ``OptInDialog`` so the look & behavior
 * (Escape = cancel, accent confirm button) stays consistent with the
 * rest of the app. */
export function ResourceWarningDialog(props: ResourceWarningDialogProps) {
	const { assessment, candidateName, kind, t, open } = props;
	if (!(open && assessment)) {
		// Render even when closed so the dialog can play its exit animation.
		return (
			<OptInDialog
				body={null}
				cancelLabel={props.cancelLabel}
				confirmLabel={props.confirmLabel}
				onCancel={props.onCancel}
				onConfirm={props.onConfirm}
				onOpenChange={props.onOpenChange}
				open={open}
				title={t("warningTitleDictation")}
			/>
		);
	}
	const required = formatBytes(assessment.required_bytes, { minUnit: "MB" }) ?? "?";
	const available = formatBytes(assessment.available_bytes, { minUnit: "MB" }) ?? "?";
	const lines = assessment.reasons
		.map((r) => reasonLine(r, available, required, t))
		.filter((s): s is string => s !== null);
	const title = kind === "ollama" ? t("warningTitleOllama") : t("warningTitleDictation");
	const intro =
		assessment.severity === "critical"
			? t("warningIntroCritical", { model: candidateName })
			: t("warningIntroWarning", { model: candidateName });

	const body = (
		<div className="flex flex-col gap-3">
			<p data-testid="resource-warning-intro">{intro}</p>
			<ul className="ml-1 flex list-disc flex-col gap-1 pl-4 text-foreground-muted">
				{lines.map((line, idx) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: line text is stable per render and order is meaningful (severity reason ordering matches server payload)
					<li key={idx}>{line}</li>
				))}
			</ul>
			<p className="text-foreground-secondary text-xs">
				{t("warningFootnote", { required, available })}
			</p>
		</div>
	);

	return (
		<OptInDialog
			body={body}
			cancelLabel={props.cancelLabel}
			confirmLabel={props.confirmLabel}
			onCancel={props.onCancel}
			onConfirm={props.onConfirm}
			onOpenChange={props.onOpenChange}
			open={open}
			title={title}
		/>
	);
}
