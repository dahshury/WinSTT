import type { ModifierModelAgg, TrialRecord } from "./types";

// Shared aggregation for the CLI benchmark and the interactive tool: fold raw
// per-trial records into per-(modifier, model) style / accuracy / speed / guard
// numbers plus the quality composite.

export function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((a, b) => a + b, 0) / values.length;
}

export function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = values.toSorted((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[mid - 1]! + sorted[mid]!) / 2
		: sorted[mid]!;
}

/** Blend judge meaning/fidelity with deterministic capability pass-rate, or
 *  fall back to a semantic-preservation proxy when neither is available. */
export function trialAccuracy(t: TrialRecord): number | null {
	const parts: number[] = [];
	if (t.judge) parts.push(t.judge.meaningPreservation, t.judge.fidelity);
	if (t.capabilityPass !== null) parts.push(t.capabilityPass * 100);
	if (parts.length === 0) {
		if (t.semanticDelta !== null && t.modifierId !== "translate")
			return Math.min(100, Math.max(0, (1 - t.semanticDelta) * 100));
		return null;
	}
	return mean(parts);
}

export function aggregate(trials: TrialRecord[]): ModifierModelAgg[] {
	const groups = new Map<string, TrialRecord[]>();
	for (const t of trials) {
		const key = `${t.modifierId} ${t.model}`;
		const bucket = groups.get(key);
		if (bucket) bucket.push(t);
		else groups.set(key, [t]);
	}
	const aggs: ModifierModelAgg[] = [];
	for (const [key, group] of groups) {
		const [modifierId, model] = key.split(" ") as [string, string];
		const ok = group.filter((t) => t.error === null);
		const styleScores = ok
			.filter((t) => t.judge !== null)
			.map((t) => t.judge!.styleMatch);
		const accScores = ok
			.map(trialAccuracy)
			.filter((v): v is number => v !== null);
		const guardPassRate = ok.length
			? mean(ok.map((t) => (t.guards.pass ? 1 : 0)))
			: 0;
		const style = styleScores.length ? mean(styleScores) : null;
		const accuracy = accScores.length ? mean(accScores) : 0;
		const base = style !== null ? 0.5 * style + 0.5 * accuracy : accuracy;
		const composite = base * (0.5 + 0.5 * guardPassRate);

		const capTrials = ok.filter((t) => t.capabilityPass !== null);
		const adherence = capTrials.length
			? mean(capTrials.map((t) => t.capabilityPass!))
			: null;
		const semDeltas = ok
			.map((t) => t.semanticDelta)
			.filter((v): v is number => v !== null);
		const genMsAll = ok
			.map((t) => t.speed.genMs)
			.filter((v): v is number => v !== null);
		const tpsAll = ok
			.map((t) => t.speed.tokensPerSec)
			.filter((v): v is number => v !== null);

		const magnitudeCounts: Record<string, number> = {};
		for (const t of ok)
			magnitudeCounts[t.magnitude] = (magnitudeCounts[t.magnitude] ?? 0) + 1;

		aggs.push({
			modifierId,
			model,
			trials: group.length,
			errors: group.length - ok.length,
			style,
			accuracy,
			composite,
			guardPassRate,
			adherence,
			meanSurfaceDelta: ok.length ? mean(ok.map((t) => t.surfaceDelta)) : 0,
			meanSemanticDelta: semDeltas.length ? mean(semDeltas) : null,
			medianWallMs: ok.length ? median(ok.map((t) => t.speed.wallMs)) : 0,
			medianGenMs: genMsAll.length ? median(genMsAll) : null,
			medianTokensPerSec: tpsAll.length ? median(tpsAll) : null,
			magnitudeCounts,
			judgeCoverage: ok.length ? styleScores.length / ok.length : 0,
		});
	}
	aggs.sort(
		(a, b) =>
			a.modifierId.localeCompare(b.modifierId) ||
			a.model.localeCompare(b.model),
	);
	return aggs;
}
