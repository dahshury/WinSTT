"use client";

import { Combobox } from "@base-ui/react/combobox";
import {
	ArrowDown01Icon,
	BinaryCodeIcon,
	GlobeIcon,
	HardDriveDownloadIcon,
	LiveStreaming02Icon,
	NeuralNetworkIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentPropsWithoutRef, MouseEvent } from "react";
import { useTranslations } from "use-intl";
import {
	type ModelInfo,
	resolveEffectiveQuant,
	type SwapQuant,
	useModelSwapStore,
} from "@/entities/model-catalog";
import { estimateForQuant } from "@/entities/system-resources";
import type { ModelStateEntry } from "@/shared/api/ipc-client";
import { formatBytes } from "@/shared/lib/format-bytes";
import { Button } from "@/shared/ui/button";
import { ModelSpecHoverCard } from "@/shared/ui/model-spec-card";
import { PulseDot } from "@/shared/ui/pulse-dot";
import {
	buildSwitchingClassName,
	MODEL_TRIGGER_GLASS_CLASSES,
	SwapSweepBar,
	SwitchingFromToRow,
	SwitchingPill,
	SwitchingQuantBadge,
} from "@/shared/ui/switching-trigger";
import { publicAsset } from "@/shared/lib/public-asset";
import { AuthorBadge } from "../../ui/AuthorBadge";
import {
	SelectedModelSummary,
	type SelectedModelMetaItem,
	type SelectedModelNameParts,
} from "../../ui/SelectedModelSummary";
import {
	getAuthorLabel,
	getFamilyConfig,
	variantDisplayName,
} from "../lib/family-helpers";
import { buildSttSpec } from "../lib/build-stt-spec";
import { formatLanguages } from "../lib/language-names";
import {
	activeLatencyModel,
	findDisplayModelByBackingId,
	type PrecisionRoutedSttModel,
} from "../lib/streaming-precision-merge";
import { variantMeta } from "../lib/variant-helpers";

export interface SttModelSelectorTriggerProps {
	/** Models known to the parent picker. Used to resolve the previous-model
	 *  id (held in the swap store) back to a `ModelInfo` for the `from` leg
	 *  of the in-flight transition view. */
	catalog: readonly ModelInfo[];
	disabled: boolean;
	/** Live model-download progress observed by the consumer (parsed out of
	 *  the renderer's `useDownloadStore`). When the in-flight download target
	 *  matches the in-flight swap target, the trigger replaces the
	 *  `[from → ◌ → to]` "Switching" view with a download-aware
	 *  `[currently selected] · Downloading X · 23%` view — so the user sees
	 *  the picker remain on the model that's actually loaded right now,
	 *  while still being told the new variant is on its way.
	 *
	 *  ``count`` and ``averagePercent`` describe the full aggregate across
	 *  ``quantDownloads`` plus the legacy singleton slot. ``count >= 2``
	 *  switches the trigger to the multi-download "Downloading N items · X%"
	 *  body so parallel per-quant downloads collapse into one readable chip
	 *  instead of fighting for the same single-line slot. ``modelId`` /
	 *  ``percent`` describe the highest-progress single download — used by
	 *  the single-download view and as the swap-target match probe.
	 *
	 *  The model-picker package is self-contained (no `@/shared/*` imports
	 *  by design — see `package.json`); the consumer is responsible for
	 *  wiring the store. ``percent`` and ``averagePercent`` are ``null``
	 *  when no chunk-progress event has landed yet (indeterminate start). */
	downloadProgress?: {
		averagePercent?: number | null;
		count?: number;
		modelId: string;
		percent: number | null;
	} | null;
	/** Which swap-store slot this trigger should react to. */
	kind: "main" | "realtime";
	open: boolean;
	placeholder: string;
	currentQuantization: string;
	selectedId: string | undefined;
	selectedModel: ModelInfo | undefined;
	statesById: Record<string, ModelStateEntry>;
}

/** Author/maker chip — the shared {@link AuthorBadge} fed from the STT family
 *  metadata (logo + author label, e.g. "NVIDIA", "OpenAI"). */
function AuthorChip({
	family,
	muted = false,
}: {
	family: ModelInfo["family"];
	muted?: boolean;
}) {
	const config = getFamilyConfig(family);
	return (
		<AuthorBadge
			icon={config.icon}
			label={getAuthorLabel(family)}
			logoSrc={config.logoSrc ? publicAsset(config.logoSrc) : null}
			muted={muted}
		/>
	);
}

const STT_VERSION_VARIANT_RE =
	/^(?<main>.+?)\s+(?<variant>v\d+(?:\.\d+)?(?:\s+(?:Turbo|Flash))?)$/i;
const STT_SIZE_VARIANT_RE =
	/^(?<main>.+?)\s+(?<variant>\d+(?:\.\d+)?[MB]\s+\S.+)$/i;
const STT_TURBO_VARIANT_RE = /^(?<main>.+?)\s+(?<variant>Turbo)$/i;

function splitSttVariantName(label: string): SelectedModelNameParts {
	const trimmed = label.trim();
	for (const re of [
		STT_VERSION_VARIANT_RE,
		STT_SIZE_VARIANT_RE,
		STT_TURBO_VARIANT_RE,
	]) {
		const match = re.exec(trimmed);
		const main = match?.groups?.["main"]?.trim();
		const variant = match?.groups?.["variant"]?.trim();
		if (main && variant) {
			return { full: trimmed, main, variant };
		}
	}
	return { full: trimmed, main: trimmed };
}

function sttNameParts(label: string): SelectedModelNameParts {
	const parts = splitSttVariantName(label);
	return parts.main.length > 0 ? parts : { full: label, main: label };
}

function quantLabel(quantization: string): string {
	if (quantization === "") {
		return "FP32";
	}
	return quantization.toUpperCase();
}

function selectedQuantLabel(
	effectiveQuantization: string,
	currentQuantization: string,
): string {
	if (currentQuantization === "auto") {
		if (effectiveQuantization === "auto") {
			return "Auto";
		}
		return `Auto: ${quantLabel(effectiveQuantization)}`;
	}
	return quantLabel(effectiveQuantization);
}

function positiveSize(value: number | null | undefined): number | null {
	return typeof value === "number" && value > 0 ? value : null;
}

/** The size shown in the trigger's spec badge, in bytes, plus whether it's the
 *  AUTHORITATIVE per-quant download size (real on-disk bytes) or the param-count
 *  runtime estimate. The download size is exact and — for these weight-dominated
 *  ONNX models — closely tracks the loaded RAM, so it's preferred over the
 *  estimate (which the old code showed ~2.7× too small before the baseline fix).
 *  The param estimate is only the fallback for the few catalog rows that ship no
 *  per-quant size. */
function selectedSttBytes(
	model: ModelInfo,
	state: ModelStateEntry | undefined,
	effectiveQuantization: string,
	currentQuantization: string,
): { bytes: number | null; fromCatalogSize: boolean } {
	const actual =
		positiveSize(model.sizeBytesByQuantization[effectiveQuantization]) ??
		positiveSize(model.sizeBytesByQuantization[currentQuantization]) ??
		positiveSize(model.sizeBytesByQuantization[""]);
	if (actual !== null) {
		return { bytes: actual, fromCatalogSize: true };
	}
	if (state && state.estimated_bytes > 0) {
		return {
			bytes: estimateForQuant(state.estimated_bytes, effectiveQuantization),
			fromCatalogSize: false,
		};
	}
	return { bytes: null, fromCatalogSize: false };
}

function selectedSttMeta(
	model: ModelInfo,
	state: ModelStateEntry | undefined,
	currentQuantization: string,
): SelectedModelMetaItem[] {
	const effectiveQuantization = resolveEffectiveQuant(
		state,
		currentQuantization,
	);
	const { bytes, fromCatalogSize } = selectedSttBytes(
		model,
		state,
		effectiveQuantization,
		currentQuantization,
	);
	const sizeLabel = formatBytes(bytes);
	const { multilingual } = variantMeta(model);
	const items: SelectedModelMetaItem[] = [];
	// Capability facts first (icon-only), then the numeric spec facts — one
	// connected badge, aligned to the trigger's right edge (shares the Ollama
	// picker's badge strategy).
	if (multilingual) {
		items.push({
			key: "multilingual",
			label: "",
			icon: GlobeIcon,
			tone: "teal",
			title: "Multilingual",
			// Same roster the in-list card tooltip shows.
			description:
				model.languages.length > 0
					? `Supports ${model.languages.length} languages: ${formatLanguages(model.languages)}`
					: "Transcribes many languages, not just English.",
		});
	}
	// Only NATIVELY streaming models — the realtime slot no longer accepts
	// "fast enough" offline models (the legacy always-true preview flag would
	// over-mark, e.g. Parakeet TDT, which never appears in the realtime selector).
	if (model.nativeStreaming) {
		items.push({
			key: "streaming",
			label: "",
			icon: LiveStreaming02Icon,
			tone: "accent",
			title: "Streaming",
			description: "Feeds live audio into a stateful streaming decoder.",
		});
	}
	if (model.sizeLabel) {
		items.push({
			key: "params",
			label: model.sizeLabel,
			icon: NeuralNetworkIcon,
			title: "Parameters",
			description: `${model.sizeLabel} parameters`,
		});
	}
	items.push({
		key: "quant",
		label: selectedQuantLabel(effectiveQuantization, currentQuantization),
		icon: BinaryCodeIcon,
		tone: "warning",
		title: "Selected quantization",
	});
	if (sizeLabel) {
		items.push({
			key: "memory",
			label: sizeLabel,
			icon: HardDriveDownloadIcon,
			tone: "success",
			title: fromCatalogSize
				? "Size on device (≈ memory when loaded)"
				: "Estimated runtime memory",
		});
	}
	return items;
}

function SelectedContent({
	selectedModel,
	peers,
	currentQuantization,
	selectedId,
	statesById,
}: {
	currentQuantization: string;
	selectedModel: ModelInfo;
	selectedId: string | undefined;
	statesById: Record<string, ModelStateEntry>;
	peers?: readonly ModelInfo[] | undefined;
}) {
	const activeModel = activeLatencyModel(
		selectedModel as PrecisionRoutedSttModel,
		selectedId,
	);
	const activeState =
		statesById[activeModel.id] ?? statesById[selectedModel.id];
	return (
		<ModelSpecHoverCard spec={buildSttSpec(activeModel)}>
			<div className="flex min-w-0 flex-1">
				<SelectedModelSummary
					leading={<AuthorChip family={selectedModel.family} />}
					meta={selectedSttMeta(activeModel, activeState, currentQuantization)}
					metaPlacement="right"
					name={sttNameParts(variantDisplayName(selectedModel, peers))}
				/>
			</div>
		</ModelSpecHoverCard>
	);
}

/** STT-flavored chip+name pair used as a slot inside `SwitchingFromToRow`. */
function SttModelLabel({
	model,
	side,
	peers,
}: {
	model: ModelInfo;
	side: "from" | "to";
	peers?: readonly ModelInfo[] | undefined;
}) {
	if (side === "from") {
		return (
			<>
				<AuthorChip family={model.family} muted />
				<span className="min-w-0 max-w-[8rem] truncate font-medium text-body text-foreground-dim leading-tight tracking-tight line-through decoration-foreground-dim/40">
					{variantDisplayName(model, peers)}
				</span>
			</>
		);
	}
	return (
		<>
			<AuthorChip family={model.family} />
			<span className="min-w-0 truncate font-semibold text-accent text-body leading-tight tracking-tight">
				{variantDisplayName(model, peers)}
			</span>
		</>
	);
}

/** Pure same-model quant swap: the `from → to` model legs are identical, so
 *  the model→model row would be redundant. Show the model once + the precision
 *  transition ("FP32 → INT8") so the trigger says exactly what is changing. */
function QuantSwitchRow({
	ariaLabel,
	model,
	quant,
	peers,
}: {
	ariaLabel: string | undefined;
	model: ModelInfo;
	peers?: readonly ModelInfo[] | undefined;
	quant: SwapQuant;
}) {
	return (
		<output
			aria-label={ariaLabel}
			aria-live="polite"
			className="flex min-w-0 flex-1 items-center gap-1.5"
			data-slot="switching-quant"
		>
			<AuthorChip family={model.family} />
			<span className="min-w-0 truncate font-semibold text-body text-foreground leading-tight tracking-tight">
				{variantDisplayName(model, peers)}
			</span>
			<PulseDot className="size-2.5 shrink-0 text-accent" />
			<SwitchingQuantBadge
				from={quantLabel(quant.from)}
				to={quantLabel(quant.to)}
			/>
		</output>
	);
}

/** Downloading body — shows the selected (still-active) model on the left
 *  and either "Downloading <target> · 23%" (single download) or
 *  "Downloading N items · 47%" (multiple in-flight downloads) on the right.
 *  Distinct from the `[from → ◌ → to]` switching view because here the
 *  picker is NOT in a swap window: bytes are still flowing into the HF
 *  cache and the server hasn't restarted yet. The user can still pick
 *  another already-cached model from the popup — kicking off a new swap
 *  cancels this download via the server-restart path.
 *
 *  The multi-download case collapses parallel ``(model_id, quantization)``
 *  downloads into one readable chip rather than letting them fight for the
 *  trigger's single-line slot. Each badge inside the popup keeps its own
 *  per-quant progress fill regardless. */
function DownloadingBody({
	ariaLabel,
	currentQuantization,
	selectedModel,
	selectedId,
	toModel,
	percent,
	count = 1,
	averagePercent = null,
	peers,
	statesById,
}: {
	ariaLabel: string | undefined;
	averagePercent?: number | null;
	count?: number;
	currentQuantization: string;
	peers?: readonly ModelInfo[] | undefined;
	percent: number | null;
	selectedId: string | undefined;
	selectedModel: ModelInfo | undefined;
	statesById: Record<string, ModelStateEntry>;
	toModel: ModelInfo | undefined;
}) {
	const t = useTranslations("modelPicker");
	const multi = count >= 2;
	const singleTargetLabel = toModel
		? variantDisplayName(toModel, peers)
		: "model";
	const targetLabel = multi ? `${count} downloads` : singleTargetLabel;
	const reportedPercent = multi ? averagePercent : percent;
	const percentLabel =
		reportedPercent === null ? "Starting…" : `${reportedPercent}%`;
	return (
		<output
			aria-label={ariaLabel}
			aria-live="polite"
			className="flex min-w-0 flex-1 items-center gap-2"
			data-slot="downloading-body"
		>
			{selectedModel ? (
				<SelectedContent
					currentQuantization={currentQuantization}
					peers={peers}
					selectedId={selectedId}
					selectedModel={selectedModel}
					statesById={statesById}
				/>
			) : (
				<span className="font-medium text-body text-foreground-muted italic tracking-tight">
					{t("noModel")}
				</span>
			)}
			<span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-surface-secondary/60 px-2 py-0.5 font-medium text-[10px] text-foreground-secondary leading-none">
				<PulseDot className="size-1.5 text-accent" />
				<span className="truncate">↓ {targetLabel}</span>
				<span className="font-mono text-foreground tabular-nums">
					{percentLabel}
				</span>
			</span>
		</output>
	);
}

/** The `from → to` (or precision-only) row shown while a swap is in flight.
 *  Split out of {@link TriggerBody} so its branching (pure quant swap vs
 *  model→model + target precision) stays under Biome's complexity cap. */
function SwitchingBody({
	ariaLabel,
	fromModel,
	toModel,
	swapQuant,
	peers,
}: {
	ariaLabel: string | undefined;
	fromModel: ModelInfo | undefined;
	peers?: readonly ModelInfo[] | undefined;
	swapQuant: SwapQuant | null;
	toModel: ModelInfo | undefined;
}) {
	// Pure quant swap (same model on both legs) → precision-focused row.
	if (swapQuant && fromModel && toModel && fromModel.id === toModel.id) {
		return (
			<QuantSwitchRow
				ariaLabel={ariaLabel}
				model={toModel}
				peers={peers}
				quant={swapQuant}
			/>
		);
	}
	return (
		<SwitchingFromToRow
			ariaLabel={ariaLabel}
			from={
				fromModel ? (
					<SttModelLabel model={fromModel} peers={peers} side="from" />
				) : undefined
			}
			to={
				toModel ? (
					<span className="flex min-w-0 items-center gap-1.5">
						<SttModelLabel model={toModel} peers={peers} side="to" />
						{swapQuant ? (
							<SwitchingQuantBadge to={quantLabel(swapQuant.to)} />
						) : null}
					</span>
				) : undefined
			}
		/>
	);
}

function TriggerBody({
	isSwitching,
	isDownloadingTarget,
	isBackgroundDownload,
	currentQuantization,
	downloadPercent,
	downloadCount,
	downloadAveragePercent,
	downloadingModel,
	fromModel,
	toModel,
	swapQuant,
	selectedModel,
	selectedId,
	placeholder,
	ariaLabel,
	peers,
	statesById,
}: {
	ariaLabel: string | undefined;
	currentQuantization: string;
	/** Precision transition for the in-flight swap, or null when the swap keeps
	 *  the precision. Drives the "FP32 → INT8" badge in the switching view. */
	swapQuant: SwapQuant | null;
	/** Catalog of known models — lets {@link variantDisplayName} keep the size
	 *  token when two would collide (Canary 180M Flash vs Canary 1B Flash). */
	peers?: readonly ModelInfo[] | undefined;
	/** Mean percent across all in-flight downloads — drives the percent
	 *  label when ``downloadCount >= 2``. */
	downloadAveragePercent: number | null;
	/** Total in-flight downloads (per-quant + legacy singleton). When 2+,
	 *  ``DownloadingBody`` switches to the aggregate "N downloads · X%"
	 *  view. */
	downloadCount: number;
	downloadPercent: number | null;
	/** Resolved ``ModelInfo`` for whatever model the active download is
	 *  fetching — may be the swap target or, in the per-quant streaming
	 *  case, the model the user clicked "Download" on from a badge. */
	downloadingModel: ModelInfo | undefined;
	fromModel: ModelInfo | undefined;
	/** Per-quant streaming download running while NO swap is active.
	 *  Renders the same ``DownloadingBody`` chrome the swap-target case
	 *  uses, so the trigger consistently surfaces in-flight bytes
	 *  regardless of whether they were kicked off by selection or by
	 *  the per-badge Download button. */
	isBackgroundDownload: boolean;
	isDownloadingTarget: boolean;
	isSwitching: boolean;
	placeholder: string;
	selectedId: string | undefined;
	selectedModel: ModelInfo | undefined;
	statesById: Record<string, ModelStateEntry>;
	toModel: ModelInfo | undefined;
}) {
	if (isSwitching && isDownloadingTarget) {
		return (
			<DownloadingBody
				ariaLabel={ariaLabel}
				averagePercent={downloadAveragePercent}
				count={downloadCount}
				currentQuantization={currentQuantization}
				peers={peers}
				percent={downloadPercent}
				selectedId={selectedId}
				selectedModel={selectedModel}
				statesById={statesById}
				toModel={toModel}
			/>
		);
	}
	if (isBackgroundDownload) {
		return (
			<DownloadingBody
				ariaLabel={ariaLabel}
				averagePercent={downloadAveragePercent}
				count={downloadCount}
				currentQuantization={currentQuantization}
				peers={peers}
				percent={downloadPercent}
				selectedId={selectedId}
				selectedModel={selectedModel}
				statesById={statesById}
				toModel={downloadingModel}
			/>
		);
	}
	if (isSwitching) {
		return (
			<SwitchingBody
				ariaLabel={ariaLabel}
				fromModel={fromModel}
				peers={peers}
				swapQuant={swapQuant}
				toModel={toModel}
			/>
		);
	}
	if (selectedModel) {
		return (
			<SelectedContent
				currentQuantization={currentQuantization}
				peers={peers}
				selectedId={selectedId}
				selectedModel={selectedModel}
				statesById={statesById}
			/>
		);
	}
	return (
		<span className="font-medium text-body text-foreground-muted italic tracking-tight">
			{placeholder}
		</span>
	);
}

function resolveToModel(
	targetName: string | null,
	selectedModel: ModelInfo | undefined,
	catalog: readonly ModelInfo[],
): ModelInfo | undefined {
	if (!targetName) {
		return;
	}
	if (selectedModel && selectedModel.id === targetName) {
		return selectedModel;
	}
	return findDisplayModelByBackingId(catalog, targetName) ?? undefined;
}

interface AriaLabelInputs {
	downloadAveragePercent: number | null;
	downloadCount: number;
	downloadingModel: ModelInfo | undefined;
	downloadPercent: number | null;
	fromModel: ModelInfo | undefined;
	isBackgroundDownload: boolean;
	isDownloadingTarget: boolean;
	isMultiDownload: boolean;
	isSwitching: boolean;
	selectedModel: ModelInfo | undefined;
	swapQuant: SwapQuant | null;
	toModel: ModelInfo | undefined;
}

/** Pulled out of {@link TriggerButton} so its body stays under Biome's
 *  cognitive-complexity cap. Returns the screen-reader caption that
 *  describes the trigger's current state — multi-download, single
 *  background download, swap+download, or plain swap. */
function buildAriaLabel(inputs: AriaLabelInputs): string | undefined {
	const loadedName = inputs.selectedModel?.displayName ?? "none";
	if (
		inputs.isMultiDownload &&
		(inputs.isBackgroundDownload || inputs.isDownloadingTarget)
	) {
		const pct =
			inputs.downloadAveragePercent === null
				? "starting"
				: `${inputs.downloadAveragePercent} percent average`;
		return `Downloading ${inputs.downloadCount} models (${pct}). Currently loaded: ${loadedName}.`;
	}
	if (inputs.isBackgroundDownload && inputs.downloadingModel) {
		const pct =
			inputs.downloadPercent === null
				? "starting"
				: `${inputs.downloadPercent} percent`;
		return `Downloading ${inputs.downloadingModel.displayName} (${pct}). Currently loaded: ${loadedName}.`;
	}
	if (!(inputs.isSwitching && inputs.toModel)) {
		return;
	}
	if (inputs.isDownloadingTarget) {
		const pct =
			inputs.downloadPercent === null
				? "starting"
				: `${inputs.downloadPercent} percent`;
		return `Downloading ${inputs.toModel.displayName} (${pct}). Currently loaded: ${loadedName}.`;
	}
	// Pure quant swap (same model both legs) → announce the precision change.
	if (
		inputs.swapQuant &&
		inputs.fromModel &&
		inputs.fromModel.id === inputs.toModel.id
	) {
		return `Switching ${inputs.toModel.displayName} precision from ${quantLabel(inputs.swapQuant.from)} to ${quantLabel(inputs.swapQuant.to)}`;
	}
	const fromClause = inputs.fromModel
		? ` from ${inputs.fromModel.displayName}`
		: "";
	const quantClause = inputs.swapQuant
		? ` at ${quantLabel(inputs.swapQuant.to)}`
		: "";
	return `Switching${fromClause} to ${inputs.toModel.displayName}${quantClause}`;
}

interface TriggerButtonProps extends SttModelSelectorTriggerProps {
	buttonProps: ComponentPropsWithoutRef<"button">;
}

// Glass-card trigger. Material vocabulary matches the pill: theme-token
// vertical gradient + hairline inset ring + tinted drop shadow + inset top
// highlight. The accent (Docker blue) appears only when open, as a 1px
// hairline at the top edge — the single saturated moment in the control.
//
// In-flight swap state: the card backdrop picks up a faint accent tint
// (`data-[switching=true]`), the chevron is swapped for a "SWITCHING" pill,
// the static `[author] name` row is replaced by a `from → ◌ → to` row, and
// an accent gradient sweeps across the bottom edge — together a continuous,
// readable transition view that lasts the full swap. All three pieces come
// from `@/shared/ui/switching-trigger` so the Ollama picker reads identically.
function TriggerButton({ buttonProps, ...rest }: TriggerButtonProps) {
	const { kind, catalog, selectedModel, downloadProgress } = rest;
	const swapTargetName = useModelSwapStore((s) =>
		kind === "main" ? s.activeMain : s.activeRealtime,
	);
	const swapFromName = useModelSwapStore((s) =>
		kind === "main" ? s.fromMain : s.fromRealtime,
	);
	const swapQuant = useModelSwapStore((s) =>
		kind === "main" ? s.quantMain : s.quantRealtime,
	);
	const isSwitching = swapTargetName !== null;
	const fromModel = swapFromName
		? resolveToModel(swapFromName, undefined, catalog)
		: undefined;
	const toModel = resolveToModel(swapTargetName, selectedModel, catalog);
	// We're in the "downloading" sub-phase of the swap when a download is
	// active AND its model id matches the in-flight swap target. The UI
	// must read this from the caller-supplied download snapshot rather
	// than peeking at the store directly — the model-picker package is
	// self-contained (see package.json).
	const isDownloadingTarget =
		downloadProgress != null &&
		swapTargetName !== null &&
		downloadProgress.modelId === swapTargetName;
	// Per-quant streaming download running on its own (the user hit the
	// Download button on a badge, no swap was kicked off): surface the
	// same trigger chrome without claiming a swap is in flight.
	const isBackgroundDownload = !isSwitching && downloadProgress != null;
	const downloadingModel = downloadProgress
		? resolveToModel(downloadProgress.modelId, undefined, catalog)
		: undefined;
	const downloadPercent =
		isDownloadingTarget || isBackgroundDownload
			? (downloadProgress?.percent ?? null)
			: null;
	const downloadCount = downloadProgress?.count ?? (downloadProgress ? 1 : 0);
	const downloadAveragePercent = downloadProgress?.averagePercent ?? null;
	const isMultiDownload = downloadCount >= 2;
	const ariaLabel = buildAriaLabel({
		downloadAveragePercent,
		downloadCount,
		downloadPercent,
		downloadingModel,
		fromModel,
		isBackgroundDownload,
		isDownloadingTarget,
		isMultiDownload,
		isSwitching,
		selectedModel,
		swapQuant,
		toModel,
	});
	// Treat a background per-quant download as "trigger-active" for the
	// visual treatments shared with swaps — the accent hairline, the
	// pill, the sweep bar — so the user gets the same "something is in
	// flight" affordance regardless of which pathway initiated the bytes.
	const isTriggerActive = isSwitching || isBackgroundDownload;
	const baseClass = MODEL_TRIGGER_GLASS_CLASSES;
	return (
		<Button
			{...buttonProps}
			aria-expanded={rest.open}
			aria-label={ariaLabel}
			className={`${baseClass} ${buildSwitchingClassName(isTriggerActive)}`}
			data-slot="stt-model-selector-trigger"
			data-state={rest.open ? "open" : "closed"}
			data-switching={isTriggerActive}
			disabled={rest.disabled}
			type="button"
		>
			{/* Accent hairline — fades in when the popup is open, a swap is in
			    flight, OR a per-quant streaming download is running. Same
			    one-accent-moment vocabulary across all three states. */}
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r from-transparent via-accent/55 to-transparent opacity-0 transition-opacity duration-200 group-data-[state=open]:opacity-100 group-data-[switching=true]:opacity-100"
			/>
			<TriggerBody
				ariaLabel={ariaLabel}
				currentQuantization={rest.currentQuantization}
				downloadAveragePercent={downloadAveragePercent}
				downloadCount={downloadCount}
				downloadingModel={downloadingModel}
				downloadPercent={downloadPercent}
				fromModel={fromModel}
				isBackgroundDownload={isBackgroundDownload}
				isDownloadingTarget={isDownloadingTarget}
				isSwitching={isSwitching}
				peers={catalog}
				placeholder={rest.placeholder}
				selectedId={rest.selectedId}
				selectedModel={rest.selectedModel}
				statesById={rest.statesById}
				swapQuant={swapQuant}
				toModel={toModel}
			/>
			{isTriggerActive ? (
				<SwitchingPill
					label={
						isDownloadingTarget || isBackgroundDownload
							? "Downloading"
							: "Switching"
					}
				/>
			) : (
				<HugeiconsIcon
					className="ms-2 size-4 shrink-0 text-foreground-muted transition-[transform,color] duration-200 ease-out group-data-[state=open]:rotate-180 group-data-[state=open]:text-foreground"
					icon={ArrowDown01Icon}
				/>
			)}
			{isTriggerActive ? <SwapSweepBar /> : null}
		</Button>
	);
}

export function SttModelSelectorTrigger(props: SttModelSelectorTriggerProps) {
	return (
		<Combobox.Trigger
			nativeButton
			render={(p) => (
				<TriggerButton
					{...props}
					buttonProps={p as ComponentPropsWithoutRef<"button">}
				/>
			)}
		/>
	);
}

/** Standalone trigger button — same glass-card visual, swap/download states,
 *  and ``data-slot`` as {@link SttModelSelectorTrigger}, but WITHOUT the
 *  ``Combobox.Trigger`` wrapper. For consumers that open the detached picker
 *  BrowserWindow on click (extending beyond the host window) instead of an
 *  in-window popup — the settings panel and the footer chip share this path. */
export function SttModelSelectorTriggerButton({
	onActivate,
	...props
}: SttModelSelectorTriggerProps & {
	onActivate: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
	return (
		<TriggerButton
			{...props}
			buttonProps={{ type: "button", onClick: onActivate }}
		/>
	);
}
