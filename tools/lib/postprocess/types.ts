import type { SpeedSample } from "./clients";
import type { GuardReport } from "./metrics";
import type { JudgeScores } from "./judge";

export interface TrialRecord {
	modifierId: string;
	model: string;
	sampleId: string;
	sampleKind: "corpus" | "capability";
	trial: number;
	output: string;
	speed: SpeedSample;
	surfaceDelta: number;
	semanticDelta: number | null;
	magnitude: string;
	guards: GuardReport;
	judge: JudgeScores | null;
	/** Deterministic capability check pass-rate (0..1), when the sample had checks. */
	capabilityPass: number | null;
	error: string | null;
}

export interface ModifierModelAgg {
	modifierId: string;
	model: string;
	trials: number;
	errors: number;
	/** Mean judge style_match, 0..100 (null if the judge was disabled/failed). */
	style: number | null;
	/** Blended meaning/fidelity/adherence, guard-gated, 0..100. */
	accuracy: number;
	/** Quality composite blending style + accuracy + guards, 0..100. */
	composite: number;
	guardPassRate: number;
	/** Capability-check pass-rate across capability samples, 0..1 (null if none). */
	adherence: number | null;
	meanSurfaceDelta: number;
	meanSemanticDelta: number | null;
	medianWallMs: number;
	medianGenMs: number | null;
	medianTokensPerSec: number | null;
	magnitudeCounts: Record<string, number>;
	judgeCoverage: number;
}

export interface BenchmarkReport {
	generatedAt: string;
	runnerProvider: string;
	judgeProvider: string | null;
	judgeModel: string | null;
	embedModel: string | null;
	models: string[];
	modifiers: string[];
	trialsPerCell: number;
	samples: { corpus: number; capability: number };
	aggregates: ModifierModelAgg[];
	trials: TrialRecord[];
}
