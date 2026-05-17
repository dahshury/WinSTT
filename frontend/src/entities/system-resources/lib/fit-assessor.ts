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
const DICTATION_OVERHEAD_BYTES = 500_000_000;
const OLLAMA_OVERHEAD_BYTES = 1_000_000_000;
const OLLAMA_SIZE_HEADROOM_FACTOR = 1.2;

const BYTES_PER_PARAM_BY_QUANT: Record<string, number> = {
	"": 4,
	fp32: 4,
	fp16: 2,
	int8: 1.2,
	uint8: 1.2,
	q4: 0.75,
	q4f16: 0.75,
	bnb4: 0.75,
};

const GPU_COMPATIBLE_QUANTIZATIONS: ReadonlySet<string> = new Set(["", "fp32", "fp16"]);

/** Sum of currently-loaded dictation footprints, excluding ``excludeId``
 * when the candidate is replacing an already-loaded slot. */
export function loadedDictationFootprint(
	statesById: Record<string, ModelStateEntry>,
	loaded: {
		mainId: string | null;
		mainQuant: string;
		realtimeId: string | null;
		realtimeQuant: string;
	},
	excludeId: string | null
): number {
	let total = 0;
	for (const { id, quant } of [
		{ id: loaded.mainId, quant: loaded.mainQuant },
		{ id: loaded.realtimeId, quant: loaded.realtimeQuant },
	]) {
		if (!id || id === excludeId) {
			continue;
		}
		const entry = statesById[id];
		if (!entry || entry.estimated_bytes <= 0) {
			continue;
		}
		total += estimateForQuant(entry.estimated_bytes, quant);
	}
	return total;
}

// fp32 is the reference baseline; "" maps to it. Captured as a constant so
// TypeScript doesn't need to re-narrow the indexed-access type below.
const BYTES_PER_PARAM_BASELINE = BYTES_PER_PARAM_BY_QUANT[""] ?? 4;

/** Approximate a model's runtime bytes at ``quant`` from its catalog
 * ``estimated_bytes`` (which the server reports at int8/q4 baseline).
 * We scale linearly from that baseline by ratio of bytes-per-param. */
function estimateForQuant(estimatedBytes: number, quant: string): number {
	const factor = BYTES_PER_PARAM_BY_QUANT[quant];
	if (factor === undefined) {
		return estimatedBytes;
	}
	return Math.round(estimatedBytes * (factor / BYTES_PER_PARAM_BASELINE));
}

function predictedTarget(
	quantization: string,
	live: LiveResourcesEntry,
	requestedDevice: string | null
): FitTarget {
	if (live.ram_total_bytes <= 0 && live.gpus.length === 0) {
		return "neither";
	}
	if (requestedDevice === "cpu") {
		return "cpu";
	}
	if (live.gpus.length === 0) {
		return "cpu";
	}
	if (!GPU_COMPATIBLE_QUANTIZATIONS.has(quantization)) {
		return "cpu";
	}
	return "gpu";
}

function largestGpu(live: LiveResourcesEntry): { total: number; free: number } {
	const first = live.gpus[0];
	if (!first) {
		return { total: 0, free: 0 };
	}
	let biggest = first;
	for (const gpu of live.gpus) {
		if (gpu.total_vram_bytes > biggest.total_vram_bytes) {
			biggest = gpu;
		}
	}
	return { total: biggest.total_vram_bytes, free: biggest.free_vram_bytes };
}

function severityFor(required: number, available: number): FitSeverity {
	if (available <= 0) {
		return "critical";
	}
	if (required > available) {
		return "critical";
	}
	if (required > available * WARNING_THRESHOLD) {
		return "warning";
	}
	return "ok";
}

interface AssessContext {
	candidateQuant: string;
	live: LiveResourcesEntry;
	loaded: {
		mainId: string | null;
		mainQuant: string;
		realtimeId: string | null;
		realtimeQuant: string;
	};
	requestedDevice: string | null;
	statesById: Record<string, ModelStateEntry>;
}

/** Pure client-side mirror of ``assess_dictation_fit`` for instant
 * per-row badges. Returns the same shape the server sends so the
 * renderer treats both sources identically. */
export function assessDictationFitClient(
	candidateId: string,
	ctx: AssessContext
): FitAssessmentEntry {
	const entry = ctx.statesById[candidateId];
	if (!entry || entry.estimated_bytes <= 0) {
		return {
			severity: "ok",
			target: predictedTarget(ctx.candidateQuant, ctx.live, ctx.requestedDevice),
			required_bytes: 0,
			available_bytes: 0,
			reasons: ["unknown_footprint"],
		};
	}
	const required = estimateForQuant(entry.estimated_bytes, ctx.candidateQuant);
	const target = predictedTarget(ctx.candidateQuant, ctx.live, ctx.requestedDevice);
	const reasons: FitReason[] = [];

	if (ctx.live.gpus.length > 0 && !GPU_COMPATIBLE_QUANTIZATIONS.has(ctx.candidateQuant)) {
		reasons.push("requires_cpu_quant");
	}
	if (ctx.live.gpus.length === 0 && ctx.requestedDevice !== "cpu") {
		reasons.push("no_gpu_available");
	}

	const loadedOther = loadedDictationFootprint(ctx.statesById, ctx.loaded, candidateId);

	if (target === "gpu") {
		const { total, free } = largestGpu(ctx.live);
		let available = free;
		if (loadedOther > 0) {
			reasons.push("stt_already_uses_gpu");
		}
		if (available <= 0 && total > 0) {
			available = total;
		}
		const severity = severityFor(required, available);
		reasons.push(
			severity === "critical" ? "exceeds_vram" : severity === "warning" ? "tight_vram" : "ok"
		);
		return { severity, target, required_bytes: required, available_bytes: available, reasons };
	}

	if (target === "cpu") {
		const usableTotal = Math.floor(ctx.live.ram_total_bytes * RAM_USABLE_FRACTION);
		const liveAvail = ctx.live.ram_available_bytes;
		const budget = liveAvail > 0 ? Math.min(liveAvail, usableTotal) : usableTotal;
		const available = Math.max(0, budget - loadedOther);
		if (loadedOther > 0) {
			reasons.push("stt_already_uses_ram");
		}
		const severity = severityFor(required, available);
		reasons.push(
			severity === "critical" ? "exceeds_ram" : severity === "warning" ? "tight_ram" : "ok"
		);
		return { severity, target, required_bytes: required, available_bytes: available, reasons };
	}

	return {
		severity: "critical",
		target: "neither",
		required_bytes: required,
		available_bytes: 0,
		reasons: ["exceeds_ram"],
	};
}

/** Client-side mirror of ``assess_ollama_fit``. */
export function assessOllamaFitClient(
	sizeBytes: number,
	ctx: Omit<AssessContext, "candidateQuant" | "requestedDevice">
): FitAssessmentEntry {
	if (sizeBytes <= 0) {
		return {
			severity: "ok",
			target: "neither",
			required_bytes: 0,
			available_bytes: 0,
			reasons: ["unknown_footprint"],
		};
	}
	const required = Math.round(sizeBytes * OLLAMA_SIZE_HEADROOM_FACTOR) + OLLAMA_OVERHEAD_BYTES;
	const loadedOther = loadedDictationFootprint(ctx.statesById, ctx.loaded, null);
	const reasons: FitReason[] = [];

	if (ctx.live.gpus.length > 0) {
		const { total, free } = largestGpu(ctx.live);
		const available = free > 0 ? free : total;
		if (loadedOther > 0) {
			reasons.push("stt_already_uses_gpu");
		}
		if (required <= available) {
			const severity: FitSeverity = required > available * WARNING_THRESHOLD ? "warning" : "ok";
			reasons.push(severity === "warning" ? "tight_vram" : "ok");
			return {
				severity,
				target: "gpu",
				required_bytes: required,
				available_bytes: available,
				reasons,
			};
		}
		reasons.push("exceeds_vram");
		return {
			severity: "critical",
			target: "neither",
			required_bytes: required,
			available_bytes: available,
			reasons,
		};
	}

	const usableTotal = Math.floor(ctx.live.ram_total_bytes * RAM_USABLE_FRACTION);
	const liveAvail = ctx.live.ram_available_bytes;
	const budget = liveAvail > 0 ? Math.min(liveAvail, usableTotal) : usableTotal;
	const available = Math.max(0, budget - loadedOther);
	if (loadedOther > 0) {
		reasons.push("stt_already_uses_ram");
	}
	const severity = severityFor(required, available);
	let target: FitTarget;
	if (severity === "critical") {
		reasons.push("exceeds_ram");
		target = "neither";
	} else if (severity === "warning") {
		reasons.push("tight_ram");
		target = "cpu";
	} else {
		reasons.push("ok");
		target = "cpu";
	}
	return { severity, target, required_bytes: required, available_bytes: available, reasons };
}

export const TEST_ONLY = {
	BYTES_PER_PARAM_BY_QUANT,
	WARNING_THRESHOLD,
	estimateForQuant,
	largestGpu,
	predictedTarget,
	severityFor,
};
