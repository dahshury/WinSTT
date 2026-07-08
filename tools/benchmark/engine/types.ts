import type { ReasoningEffort } from "@/widgets/model-picker/config/model-selector-options";

import type { Provider } from "../../lib/postprocess/clients";
import type {
	ModifierModelAgg,
	TrialRecord,
} from "../../lib/postprocess/types";

export interface RunnerSpec {
	provider: Provider;
	model: string;
}

export interface BenchmarkConfig {
	runners: RunnerSpec[];
	ollamaEndpoint: string;
	openrouterKey: string;
	/** Applied to runner calls (Ollama think flag / OpenRouter reasoning.effort). */
	thinkingEffort: ReasoningEffort;
	judgeEnabled: boolean;
	judgeProvider: Provider;
	judgeModel: string;
	embedEnabled: boolean;
	embedModel: string;
	modifiers: string[];
	corpusLimit: number;
	includeCapability: boolean;
	trials: number;
}

/** One persisted benchmark run. Aggregates are kept in full; per-trial sample
 *  outputs are capped when stored so the JSON file stays small. */
export interface StoredRun {
	id: string;
	startedAt: string;
	durationMs: number;
	config: BenchmarkConfig;
	models: string[];
	modifiers: string[];
	aggregates: ModifierModelAgg[];
	samples: SampleRecord[];
}

export type SampleRecord = Pick<
	TrialRecord,
	| "modifierId"
	| "model"
	| "sampleId"
	| "sampleKind"
	| "output"
	| "surfaceDelta"
	| "semanticDelta"
	| "magnitude"
	| "guards"
	| "judge"
	| "capabilityPass"
	| "speed"
	| "error"
>;

export interface RunProgress {
	done: number;
	total: number;
	label: string;
	phase: "runner" | "judge" | "done";
}
