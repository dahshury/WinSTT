/**
 * Client-side mirror of the server's fit-assessment logic.
 *
 * The server is authoritative — when the user actually picks a model we
 * always round-trip ``assess_dictation_model_fit`` to populate the warning
 * dialog. But the picker renders N rows on open, and each row wants its
 * own "fits / tight / won't fit" badge. Round-tripping N times per render
 * would be wasteful, so we mirror the formulas here using the same
 * thresholds and per-quantization byte costs.
 *
 * Source of truth for tuning constants lives in
 * ``server/src/recorder/infrastructure/fit_assessment.py``. Keep them in
 * sync — both copies are covered by unit tests so drift surfaces fast.
 */

import type {
	FitAssessmentEntry,
	FitReason,
	FitSeverity,
	FitTarget,
	LiveResourcesEntry,
	ModelStateEntry,
} from "@/shared/api/ipc-client";

const WARNING_THRESHOLD = 0.8;
const RAM_USABLE_FRACTION = 0.7;

/** Runtime footprint of the on-device encoder dictionary model (the int8
 * mmBERT masked-LM, ~310 MB on disk). It isn't in the model catalog and runs
 * CPU-only (no EP registration — see `encoder_dict/engine.rs`), so its fit is a
 * fixed RAM check rather than a catalog/quant-scaled one. Exported as the
 * SINGLE source of this size — the status-bar breakdown and the suggestion
 * budget calculator import it rather than duplicating the constant. */
export const ENCODER_DICT_MODEL_BYTES = 310 * 1024 * 1024;

const BYTES_PER_PARAM_BY_QUANT: Record<string, number> = {
	"": 4,
	fp32: 4,
	fp16: 2,
	fp16w: 2,
	int8: 1.2,
	uint8: 1.2,
	int4: 0.75,
	q4: 0.75,
	q4f16: 0.75,
	bnb4: 0.75,
};

/** Quantizations the DirectML/GPU execution provider can actually run — every
 * other precision (int8/uint8/q4/…) is CPU-routed and consumes RAM, not VRAM.
 * Exported so the model-suggestion engine's device-resolution fallback uses the
 * same set as `predictedTarget` (single source of truth). */
export const GPU_COMPATIBLE_QUANTIZATIONS: ReadonlySet<string> = new Set([
	"",
	"fp32",
	"fp16",
	"fp16w",
]);

interface LoadedSlots {
	mainId: string | null;
	mainQuant: string;
	realtimeId: string | null;
	realtimeQuant: string;
}

interface SlotEntry {
	id: string | null;
	quant: string;
}

function slotsOf(loaded: LoadedSlots): readonly SlotEntry[] {
	return [
		{ id: loaded.mainId, quant: loaded.mainQuant },
		{ id: loaded.realtimeId, quant: loaded.realtimeQuant },
	];
}

function isSlotCounted(
	slot: SlotEntry,
	excludeId: string | null,
): slot is SlotEntry & { id: string } {
	return slot.id !== null && slot.id !== excludeId;
}

function hasUsableEstimate(
	entry: ModelStateEntry | undefined,
): entry is ModelStateEntry {
	return entry !== undefined && entry.estimated_bytes > 0;
}

function slotBytes(
	slot: SlotEntry,
	statesById: Record<string, ModelStateEntry>,
	excludeId: string | null,
): number {
	if (!isSlotCounted(slot, excludeId)) {
		return 0;
	}
	const entry = statesById[slot.id];
	if (!hasUsableEstimate(entry)) {
		return 0;
	}
	return estimateForQuant(entry.estimated_bytes, slot.quant);
}

/** Sum of currently-loaded dictation footprints, excluding ``excludeId``
 * when the candidate is replacing an already-loaded slot. */
function loadedDictationFootprint(
	statesById: Record<string, ModelStateEntry>,
	loaded: LoadedSlots,
	excludeId: string | null,
): number {
	return slotsOf(loaded).reduce(
		(total, slot) => total + slotBytes(slot, statesById, excludeId),
		0,
	);
}

/** Runtime bytes the swap FREES before loading the candidate: the footprint of
 * the model currently occupying the slot the candidate will take. A swap always
 * unloads the outgoing model first, so this memory is available to the incoming
 * model even though the live measurement (taken with it still resident) doesn't
 * reflect that yet. Zero when the slot is empty or its estimate is unknown. */
function freedSlotFootprint(
	statesById: Record<string, ModelStateEntry>,
	loaded: LoadedSlots,
	freedId: string | null,
): number {
	if (freedId === null) {
		return 0;
	}
	return slotsOf(loaded)
		.filter((slot) => slot.id === freedId)
		.reduce((total, slot) => total + slotBytes(slot, statesById, null), 0);
}

// fp32 is the reference baseline; "" maps to it. Captured as a constant so
// TypeScript doesn't need to re-narrow the indexed-access type below.
const BYTES_PER_PARAM_BASELINE = BYTES_PER_PARAM_BY_QUANT[""] ?? 4;

/** Approximate a model's runtime bytes at ``quant`` from its catalog
 * ``estimated_bytes`` (which the server reports at int8/q4 baseline).
 * We scale linearly from that baseline by ratio of bytes-per-param.
 *
 * Exported so the status-bar GPU/CPU breakdown can render the same
 * per-quant runtime footprint the picker badges use (single source of
 * truth for the bytes-per-param scaling). */
export function estimateForQuant(
	estimatedBytes: number,
	quant: string,
): number {
	const factor = BYTES_PER_PARAM_BY_QUANT[quant];
	if (factor === undefined) {
		return estimatedBytes;
	}
	return Math.round(estimatedBytes * (factor / BYTES_PER_PARAM_BASELINE));
}

function hasNoHardware(live: LiveResourcesEntry): boolean {
	return live.ram_total_bytes <= 0 && live.gpus.length === 0;
}

function canUseGpu(quantization: string, live: LiveResourcesEntry): boolean {
	return live.gpus.length > 0 && GPU_COMPATIBLE_QUANTIZATIONS.has(quantization);
}

function gpuOrCpuTarget(
	quantization: string,
	live: LiveResourcesEntry,
): FitTarget {
	return canUseGpu(quantization, live) ? "gpu" : "cpu";
}

function predictedTarget(
	quantization: string,
	live: LiveResourcesEntry,
	requestedDevice: string | null,
): FitTarget {
	if (hasNoHardware(live)) {
		return "neither";
	}
	if (requestedDevice === "cpu") {
		return "cpu";
	}
	return gpuOrCpuTarget(quantization, live);
}

function pickBiggerGpu(
	a: LiveResourcesEntry["gpus"][number],
	b: LiveResourcesEntry["gpus"][number],
): LiveResourcesEntry["gpus"][number] {
	return b.total_vram_bytes > a.total_vram_bytes ? b : a;
}

function largestGpu(live: LiveResourcesEntry): { total: number; free: number } {
	const first = live.gpus[0];
	if (!first) {
		return { total: 0, free: 0 };
	}
	const biggest = live.gpus.reduce(pickBiggerGpu, first);
	return { total: biggest.total_vram_bytes, free: biggest.free_vram_bytes };
}

function isCriticalFit(required: number, available: number): boolean {
	return available <= 0 || required > available;
}

function severityFor(required: number, available: number): FitSeverity {
	if (isCriticalFit(required, available)) {
		return "critical";
	}
	return required > available * WARNING_THRESHOLD ? "warning" : "ok";
}

interface AssessContext {
	candidateQuant: string;
	live: LiveResourcesEntry;
	loaded: LoadedSlots;
	/** Model currently in the slot this candidate will occupy — the swap unloads
	 * it BEFORE loading the candidate, so its footprint is freed and must be
	 * added back to available memory. Omit (or null) to default to the candidate
	 * itself, which still corrects the "already-loaded model shows Won't fit"
	 * case; pass the target slot's resident id so a swap to a *different* model
	 * is also measured against post-removal memory. */
	replacedId?: string | null;
	requestedDevice: string | null;
	statesById: Record<string, ModelStateEntry>;
}

const VRAM_REASON_BY_SEVERITY: Record<FitSeverity, FitReason> = {
	critical: "exceeds_vram",
	warning: "tight_vram",
	ok: "ok",
};

const RAM_REASON_BY_SEVERITY: Record<FitSeverity, FitReason> = {
	critical: "exceeds_ram",
	warning: "tight_ram",
	ok: "ok",
};

function vramReasonFor(severity: FitSeverity): FitReason {
	return VRAM_REASON_BY_SEVERITY[severity];
}

function ramReasonFor(severity: FitSeverity): FitReason {
	return RAM_REASON_BY_SEVERITY[severity];
}

interface GpuAvailability {
	available: number;
	/** True when `free_vram_bytes` was a real measurement. The DXGI backend
	 * reports either the live free budget or a `total` fallback, so a genuine
	 * `0` means the card is FULL — not "unmeasured". */
	freeKnown: boolean;
}

function gpuAvailability(total: number, free: number): GpuAvailability {
	if (free > 0) {
		return { available: free, freeKnown: true };
	}
	// free === 0: the GPU is (reported) full. We still expose `total` so the
	// dialog can show the capacity, but the caller must not treat this as a
	// confident fit — see `assessGpuFit`.
	return { available: total, freeKnown: false };
}

function pushIfPositive(
	reasons: FitReason[],
	value: number,
	reason: FitReason,
): void {
	if (value > 0) {
		reasons.push(reason);
	}
}

function assessGpuFit(
	required: number,
	loadedOther: number,
	freed: number,
	live: LiveResourcesEntry,
	reasons: FitReason[],
): FitAssessmentEntry {
	const { total, free } = largestGpu(live);
	const base = gpuAvailability(total, free);
	const freeKnown = base.freeKnown;
	// Add back the VRAM the swap frees by unloading the model currently in the
	// target slot (the live free reading was taken with it still resident).
	const available = base.available + freed;
	pushIfPositive(reasons, loadedOther, "stt_already_uses_gpu");
	let severity = severityFor(required, available);
	// A full GPU (free === 0) fell back to `total` capacity, which is optimistic
	// — never report a confident "ok" off a guessed number; downgrade to a soft
	// "tight" so the user still gets a heads-up before loading onto a busy card.
	if (!freeKnown && severity === "ok") {
		severity = "warning";
	}
	reasons.push(vramReasonFor(severity));
	return {
		severity,
		target: "gpu",
		required_bytes: required,
		available_bytes: available,
		reasons,
	};
}

function cpuBudgetBytes(live: LiveResourcesEntry, loadedOther: number): number {
	const usableTotal = Math.floor(live.ram_total_bytes * RAM_USABLE_FRACTION);
	const liveAvail = live.ram_available_bytes;
	const budget = liveAvail > 0 ? Math.min(liveAvail, usableTotal) : usableTotal;
	return Math.max(0, budget - loadedOther);
}

function assessCpuFit(
	required: number,
	loadedOther: number,
	freed: number,
	live: LiveResourcesEntry,
	reasons: FitReason[],
): FitAssessmentEntry {
	// Add back the RAM the swap frees by unloading the outgoing slot model — the
	// live measurement was taken with it still resident.
	const available = cpuBudgetBytes(live, loadedOther) + freed;
	pushIfPositive(reasons, loadedOther, "stt_already_uses_ram");
	const severity = severityFor(required, available);
	reasons.push(ramReasonFor(severity));
	return {
		severity,
		target: "cpu",
		required_bytes: required,
		available_bytes: available,
		reasons,
	};
}

function neitherFit(required: number): FitAssessmentEntry {
	return {
		severity: "critical",
		target: "neither",
		required_bytes: required,
		available_bytes: 0,
		reasons: ["exceeds_ram"],
	};
}

function unknownFootprintFit(target: FitTarget): FitAssessmentEntry {
	return {
		severity: "ok",
		target,
		required_bytes: 0,
		available_bytes: 0,
		reasons: ["unknown_footprint"],
	};
}

function gpuMismatchReason(
	quant: string,
	live: LiveResourcesEntry,
): FitReason | null {
	if (live.gpus.length > 0 && !GPU_COMPATIBLE_QUANTIZATIONS.has(quant)) {
		return "requires_cpu_quant";
	}
	return null;
}

function missingGpuReason(
	live: LiveResourcesEntry,
	requestedDevice: string | null,
): FitReason | null {
	if (live.gpus.length === 0 && requestedDevice !== "cpu") {
		return "no_gpu_available";
	}
	return null;
}

function pushIfPresent<T>(arr: T[], value: T | null): void {
	if (value !== null) {
		arr.push(value);
	}
}

function collectDictationReasons(ctx: AssessContext): FitReason[] {
	const reasons: FitReason[] = [];
	pushIfPresent(reasons, gpuMismatchReason(ctx.candidateQuant, ctx.live));
	pushIfPresent(reasons, missingGpuReason(ctx.live, ctx.requestedDevice));
	return reasons;
}

function dispatchFit(
	target: FitTarget,
	required: number,
	loadedOther: number,
	freed: number,
	live: LiveResourcesEntry,
	reasons: FitReason[],
): FitAssessmentEntry {
	if (target === "gpu") {
		return assessGpuFit(required, loadedOther, freed, live, reasons);
	}
	if (target === "cpu") {
		return assessCpuFit(required, loadedOther, freed, live, reasons);
	}
	return neitherFit(required);
}

/** Pure client-side mirror of ``assess_dictation_fit`` for instant
 * per-row badges. Returns the same shape the server sends so the
 * renderer treats both sources identically. */
export function assessDictationFitClient(
	candidateId: string,
	ctx: AssessContext,
): FitAssessmentEntry {
	const entry = ctx.statesById[candidateId];
	if (!entry || entry.estimated_bytes <= 0) {
		return unknownFootprintFit(
			predictedTarget(ctx.candidateQuant, ctx.live, ctx.requestedDevice),
		);
	}
	const required = estimateForQuant(entry.estimated_bytes, ctx.candidateQuant);
	const target = predictedTarget(
		ctx.candidateQuant,
		ctx.live,
		ctx.requestedDevice,
	);
	const reasons = collectDictationReasons(ctx);
	// The swap frees the model in the target slot first. Default the outgoing id
	// to the candidate so a re-select of the already-loaded model correctly frees
	// its own footprint; callers that know the slot pass ``replacedId`` so a swap
	// to a *different* model is also measured against post-removal memory.
	const outgoingId = ctx.replacedId ?? candidateId;
	const loadedOther = loadedDictationFootprint(
		ctx.statesById,
		ctx.loaded,
		outgoingId,
	);
	const freed = freedSlotFootprint(ctx.statesById, ctx.loaded, outgoingId);
	return dispatchFit(target, required, loadedOther, freed, ctx.live, reasons);
}

/** CPU-only fit assessment for the on-device encoder dictionary model.
 *
 * Unlike catalog STT models, the encoder dictionary isn't in the model
 * catalog and always runs on CPU (int8, no execution-provider registration),
 * so we assess its fixed ~310 MB footprint against live RAM only — never VRAM.
 * Returns the same ``FitAssessmentEntry`` shape as the STT path so it can drive
 * the shared ``ResourceWarningDialog`` unchanged. ``loadedOther`` is 0 because
 * ``ram_available_bytes`` already reflects everything currently resident (the
 * STT model, Ollama, etc.) — we're only judging whether ~310 MB fits on top. */
export function assessEncoderDictFitClient(
	live: LiveResourcesEntry,
	requiredBytes: number = ENCODER_DICT_MODEL_BYTES,
): FitAssessmentEntry {
	if (hasNoHardware(live)) {
		return neitherFit(requiredBytes);
	}
	return assessCpuFit(requiredBytes, 0, 0, live, []);
}

export const TEST_ONLY = {
	BYTES_PER_PARAM_BY_QUANT,
	WARNING_THRESHOLD,
	estimateForQuant,
	largestGpu,
	predictedTarget,
	severityFor,
	slotBytes,
};
