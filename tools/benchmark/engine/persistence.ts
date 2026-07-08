import { aggregate } from "../../lib/postprocess/aggregate";
import type { TrialRecord } from "../../lib/postprocess/types";
import type { BenchmarkConfig, SampleRecord, StoredRun } from "./types";

const ENDPOINT = "/api/benchmark-runs";

export async function fetchRuns(): Promise<StoredRun[]> {
	try {
		const res = await fetch(ENDPOINT);
		if (!res.ok) return [];
		const data = (await res.json()) as { runs?: unknown };
		return Array.isArray(data.runs) ? (data.runs as StoredRun[]) : [];
	} catch {
		return [];
	}
}

export async function saveRun(run: StoredRun): Promise<void> {
	await fetch(ENDPOINT, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(run),
	});
}

export async function clearRuns(): Promise<void> {
	await fetch(ENDPOINT, { method: "DELETE" });
}

const MAX_SAMPLES_PER_CELL = 2;

function toSample(t: TrialRecord): SampleRecord {
	return {
		modifierId: t.modifierId,
		model: t.model,
		sampleId: t.sampleId,
		sampleKind: t.sampleKind,
		output: t.output,
		surfaceDelta: t.surfaceDelta,
		semanticDelta: t.semanticDelta,
		magnitude: t.magnitude,
		guards: t.guards,
		judge: t.judge,
		capabilityPass: t.capabilityPass,
		speed: t.speed,
		error: t.error,
	};
}

/** Build a persisted run: full aggregates, but only a couple of sample outputs
 *  per (model, modifier) so the JSON file stays small across many runs. */
export function toStoredRun(
	config: BenchmarkConfig,
	trials: TrialRecord[],
	durationMs: number,
	startedAt: string,
	id: string,
): StoredRun {
	const perCell = new Map<string, number>();
	const samples: SampleRecord[] = [];
	for (const t of trials) {
		const key = `${t.model}::${t.modifierId}`;
		const n = perCell.get(key) ?? 0;
		if (n < MAX_SAMPLES_PER_CELL) {
			samples.push(toSample(t));
			perCell.set(key, n + 1);
		}
	}
	return {
		id,
		startedAt,
		durationMs,
		config,
		models: config.runners.map((r) => r.model),
		modifiers: config.modifiers,
		aggregates: aggregate(trials),
		samples,
	};
}
