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

const BYTES_PER_PARAM_BY_QUANT: Record<string, number> = {
	"": 4,
	fp32: 4,
	fp16: 2,
	fp16w: 2,
	int8: 1.2,
	uint8: 1.2,
	q4: 0.75,
	q4f16: 0.75,
	bnb4: 0.75,
};

const GPU_COMPATIBLE_QUANTIZATIONS: ReadonlySet<string> = new Set([
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

function gpuAvailableBytes(total: number, free: number): number {
	if (free > 0) {
		return free;
	}
	return total;
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
	live: LiveResourcesEntry,
	reasons: FitReason[],
): FitAssessmentEntry {
	const { total, free } = largestGpu(live);
	const available = gpuAvailableBytes(total, free);
	pushIfPositive(reasons, loadedOther, "stt_already_uses_gpu");
	const severity = severityFor(required, available);
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
	live: LiveResourcesEntry,
	reasons: FitReason[],
): FitAssessmentEntry {
	const available = cpuBudgetBytes(live, loadedOther);
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
	live: LiveResourcesEntry,
	reasons: FitReason[],
): FitAssessmentEntry {
	if (target === "gpu") {
		return assessGpuFit(required, loadedOther, live, reasons);
	}
	if (target === "cpu") {
		return assessCpuFit(required, loadedOther, live, reasons);
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
	const loadedOther = loadedDictationFootprint(
		ctx.statesById,
		ctx.loaded,
		candidateId,
	);
	return dispatchFit(target, required, loadedOther, ctx.live, reasons);
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
