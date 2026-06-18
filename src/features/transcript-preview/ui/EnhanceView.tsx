import {
	AiMagicIcon,
	ArrowLeft01Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import { useSettingsStore } from "@/entities/setting";
import { runLlmPreview } from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { ALL_PRESET_KEYS } from "@/shared/lib/preset-prompts";
import { buildTranscriptDiff } from "@/shared/lib/transcript-diff";
import { Button } from "@/shared/ui/button";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { IconButton } from "@/shared/ui/icon-button";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { ThinkingIndicator } from "@/shared/ui/thinking-indicator";
import {
	type TranscriptDiffLabels,
	TranscriptDiffView,
} from "@/shared/ui/transcript-diff";
import {
	buildEnhanceRun,
	PRESET_LABEL_KEY,
	sendPreview,
} from "../lib/preview-config";
import {
	type EnhanceScope,
	type EnhanceSource,
	useTranscriptPreviewStore,
} from "../model/preview-store";
import {
	ModifierChip,
	SectionPanel,
	StaggerReveal,
} from "./preview-primitives";

/** Bottom half of the enhance layout — the AI controls (source/scope, modifier
 *  chips, custom instruction) plus the Run + Send footer. Always mounted so the
 *  user can re-run while reviewing a diff above. */
function EnhanceControls() {
	const tp = useTranslations("preview");
	const tl = useTranslations("llm");
	const store = useTranscriptPreviewStore();
	const dictation = useSettingsStore((s) => s.settings.llm?.dictation);
	const customModifiers = dictation?.customModifiers ?? [];
	const hasSelection = store.selEnd > store.selStart;
	const scopeEnabled = hasSelection && store.source === "current";

	const sourceOptions: SwitcherOption<EnhanceSource>[] = [
		{ value: "current", label: tp("sourceCurrent") },
		{ value: "original", label: tp("sourceOriginal") },
	];
	const scopeOptions: SwitcherOption<EnhanceScope>[] = [
		{ value: "whole", label: tp("scopeWhole") },
		{ value: "selection", label: tp("scopeSelection") },
	];

	const runEnhance = async () => {
		const { config, input, range } = buildEnhanceRun(
			dictation,
			customModifiers,
		);
		useTranscriptPreviewStore.getState().beginProcessing(input, range);
		try {
			const result = await runLlmPreview(input, "dictation", config);
			useTranscriptPreviewStore.getState().finishProcessing(result ?? null);
		} catch (error) {
			console.error("[preview] LLM preview failed:", error);
			useTranscriptPreviewStore.getState().finishProcessing(null);
		}
	};

	return (
		<SectionPanel title={tp("enhanceControlsTitle")}>
			<div className="flex flex-wrap items-center gap-2">
				<ElevatedSurface>
					<Switcher
						onChange={(v) => store.setSource(v)}
						options={sourceOptions}
						value={store.source}
					/>
				</ElevatedSurface>
				<ElevatedSurface
					className={cn(
						"transition-opacity",
						!scopeEnabled && "pointer-events-none opacity-40",
					)}
				>
					<Switcher
						onChange={(v) => store.setScope(v)}
						options={scopeOptions}
						value={scopeEnabled ? store.scope : "whole"}
					/>
				</ElevatedSurface>
			</div>

			<div className="flex max-h-20 flex-wrap gap-1.5 overflow-y-auto">
				{ALL_PRESET_KEYS.map((key) => (
					<ModifierChip
						active={store.selectedPresetKeys.includes(key)}
						key={key}
						label={tl(PRESET_LABEL_KEY[key] ?? key)}
						onToggle={() => store.togglePreset(key)}
					/>
				))}
				{customModifiers.map((m) => (
					<ModifierChip
						active={store.selectedModifierIds.includes(m.id)}
						key={m.id}
						label={m.name || tl("modifierUnnamed")}
						onToggle={() => store.toggleModifier(m.id)}
					/>
				))}
			</div>

			<textarea
				aria-label={tp("customInstructionPlaceholder")}
				className="min-h-[2.25rem] w-full resize-none rounded-md border border-border bg-surface-1 px-2.5 py-1.5 text-foreground text-sm placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-accent/60"
				dir="auto"
				onChange={(e) => store.setCustomInstruction(e.currentTarget.value)}
				placeholder={tp("customInstructionPlaceholder")}
				rows={2}
				value={store.customInstruction}
			/>

			<div className="flex items-center justify-end gap-2">
				<Button
					className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-foreground-muted text-sm transition-colors hover:text-foreground"
					onClick={runEnhance}
				>
					<HugeiconsIcon icon={AiMagicIcon} size={15} />
					{tp("run")}
				</Button>
				<Button
					className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-1.5 font-medium text-sm text-on-accent transition-colors hover:bg-accent-hover"
					onClick={sendPreview}
				>
					<HugeiconsIcon icon={Tick02Icon} size={15} />
					{tp("send")}
				</Button>
			</div>
		</SectionPanel>
	);
}

/** Top half (no pending result): the editable, selectable transcript. */
function TranscriptTopPanel() {
	const tp = useTranslations("preview");
	const store = useTranscriptPreviewStore();
	return (
		<SectionPanel title={tp("transcriptLabel")}>
			<textarea
				aria-label={tp("transcriptLabel")}
				className="max-h-44 min-h-[3rem] w-full resize-none rounded-md border border-border bg-surface-1 px-2.5 py-2 text-foreground text-sm leading-snug placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-accent/60"
				dir="auto"
				onChange={(e) => {
					store.setText(e.currentTarget.value);
					store.setSelection(
						e.currentTarget.selectionStart,
						e.currentTarget.selectionEnd,
					);
				}}
				onSelect={(e) =>
					store.setSelection(
						e.currentTarget.selectionStart,
						e.currentTarget.selectionEnd,
					)
				}
				placeholder={tp("placeholder")}
				value={store.text}
			/>
		</SectionPanel>
	);
}

/** Top half (pending result): the interactive diff (Previous vs AI edits). */
function DiffReviewTopPanel({
	base,
	candidate,
}: {
	base: string;
	candidate: string;
}) {
	const tp = useTranslations("preview");
	const store = useTranscriptPreviewStore();
	const diff = buildTranscriptDiff(base, candidate);
	const labels: TranscriptDiffLabels = {
		aiEdits: tp("aiEdits"),
		before: tp("previousTranscript"),
		after: tp("aiEdits"),
		inserted: tp("diffInserted"),
		removed: tp("diffRemoved"),
		largeRewrite: tp("diffLargeRewrite"),
		changeCount: (count) => tp("changeCount", { count }),
		moreChanges: (count) => tp("moreChanges", { count }),
	};
	const rejected = new Set(store.rejectedChanges);

	if (diff === null) {
		// The AI returned text equivalent to the base — nothing to review.
		return (
			<SectionPanel title={tp("aiEdits")}>
				<p className="text-foreground-muted text-sm">{tp("noChanges")}</p>
				<div className="flex justify-end">
					<Button
						className="rounded-md border border-border px-3 py-1.5 text-foreground-muted text-sm transition-colors hover:text-foreground"
						onClick={() => store.discardEnhancement()}
					>
						{tp("dismissEnhancement")}
					</Button>
				</div>
			</SectionPanel>
		);
	}

	return (
		<SectionPanel title={tp("aiEdits")}>
			<div className="max-h-56 overflow-y-auto pr-1">
				<TranscriptDiffView
					diff={diff}
					labels={labels}
					review={{
						rejected,
						onToggle: (i) => store.toggleChangeDecision(i),
						onCommit: () => store.applyEnhancement(),
						onDiscard: () => store.discardEnhancement(),
						applyLabel:
							rejected.size === 0 ? tp("acceptAll") : tp("applyEdits"),
						discardLabel: tp("discardEnhancement"),
						acceptLabel: tp("accept"),
						rejectLabel: tp("reject"),
					}}
				/>
			</div>
		</SectionPanel>
	);
}

/** The split enhance layout: top = transcript/diff, bottom = AI controls. */
export function EnhanceView() {
	const tp = useTranslations("preview");
	const store = useTranscriptPreviewStore();
	const reviewing = store.candidate !== null && store.diffBase !== null;

	return (
		<div className="flex flex-col gap-2.5 px-1">
			<div className="flex items-center gap-2">
				<IconButton
					aria-label={tp("back")}
					icon={<HugeiconsIcon icon={ArrowLeft01Icon} size={16} />}
					onClick={() => store.setView("edit")}
				/>
				<span className="font-medium text-foreground text-sm">
					{tp("enhanceTitle")}
				</span>
			</div>

			{/* Top half — the transcript, or the AI-edit diff once a run completes. */}
			{reviewing && store.candidate !== null && store.diffBase !== null ? (
				<DiffReviewTopPanel base={store.diffBase} candidate={store.candidate} />
			) : (
				<TranscriptTopPanel />
			)}

			{/* Bottom half — AI controls, or the reasoning stream while processing. */}
			{store.isProcessing ? (
				<SectionPanel title={tp("enhanceControlsTitle")}>
					<StaggerReveal className="px-1 py-1">
						<ThinkingIndicator
							fluidWidth
							reasoning={store.reasoning}
							startedAt={store.processStartedAt}
						/>
					</StaggerReveal>
				</SectionPanel>
			) : (
				<EnhanceControls />
			)}
		</div>
	);
}
