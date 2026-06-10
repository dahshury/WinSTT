import type { OpenRouterModel, OpenRouterTtsModel } from "@/shared/api/models";
import { parseOpenrouterId } from "@/shared/lib/openrouter-picker-id";

/**
 * Adapt a scanned `OpenRouterTtsModel` (`output_modalities=speech`) into the
 * shared OpenRouter picker's `OpenRouterModel` shape — the cloud TTS twin of
 * `sttModelToOpenrouterPickerModel`. The picker renders speed/accuracy perf
 * bars from `speed_score`/`accuracy_score`; OpenRouter publishes no TTS
 * benchmark, so the catalog's editorial `quality_score` rides the accuracy
 * slot (the picker labels it "Accuracy"; the value is the model's quality).
 * `supported_voices` is forwarded so downstream consumers keep the per-model
 * voice list, and `output_modalities: ["speech"]` keeps the modality chip
 * honest. No `endpoints` (the TTS scan is not endpoint-enriched), so the
 * picker shows no provider rows and `onChange` only ever emits a bare model id.
 */
export function ttsModelToOpenrouterPickerModel(
	model: OpenRouterTtsModel,
): OpenRouterModel {
	const parsed = parseOpenrouterId(model.id);
	return {
		id: model.id,
		name: model.name,
		architecture: {
			input_modalities: ["text"],
			output_modalities: ["speech"],
		},
		accuracy_score: model.quality_score,
		speed_score: model.speed_score,
		model_name: parsed.modelName,
		provider: "openrouter",
		supported_parameters: [],
		supported_voices: model.supported_voices,
		...(parsed.maker ? { maker: parsed.maker } : {}),
		...(parsed.variant ? { variant: parsed.variant } : {}),
		...(model.description ? { description: model.description } : {}),
		...(model.pricing ? { pricing: model.pricing } : {}),
	};
}
