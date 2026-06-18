import {
	assessDictationFitClient,
	useSystemResourcesStore,
} from "@/entities/system-resources";
import type { OnnxQuantization } from "@/shared/config/defaults";
import {
	localModelIdOrNull,
	quantForFit,
	requestedDeviceForFit,
} from "../lib/model-controls";
import type {
	DeviceValue,
	GetFitAssessment,
	ModelSettings,
	StatesById,
} from "../lib/types";

interface UseModelFitAssessmentArgs {
	currentQuantization: OnnxQuantization;
	deviceValue: DeviceValue;
	realtimeEnabled: boolean;
	selectedIsCloud: boolean;
	selectedModel: string;
	settings: ModelSettings;
	statesById: StatesById;
}

/**
 * Builds the resource-aware fit assessor used by both model sections. The
 * assessment folds the live host snapshot (RAM available, free VRAM, CPU%) with
 * the already-loaded main/realtime slots so the warning modal reflects what a
 * swap would actually cost. Extracted verbatim from the panel so the shell stays
 * a thin composition root; the live snapshot is read straight from its store
 * here rather than threaded through props.
 */
export function useModelFitAssessment({
	currentQuantization,
	deviceValue,
	realtimeEnabled,
	selectedIsCloud,
	selectedModel,
	settings,
	statesById,
}: UseModelFitAssessmentArgs): GetFitAssessment {
	const liveResources = useSystemResourcesStore((s) => s.liveResources);
	const getFitAssessment: GetFitAssessment = (modelId) => {
		if (liveResources === null) {
			return null;
		}
		const mainId = localModelIdOrNull(selectedModel, !selectedIsCloud);
		const realtimeId = localModelIdOrNull(
			settings?.realtimeModel,
			realtimeEnabled && !selectedIsCloud,
		);
		return assessDictationFitClient(modelId, {
			candidateQuant: quantForFit(statesById, modelId, currentQuantization),
			live: liveResources,
			loaded: {
				mainId,
				mainQuant: quantForFit(statesById, mainId, currentQuantization),
				realtimeId,
				realtimeQuant: quantForFit(
					statesById,
					realtimeId,
					currentQuantization,
				),
			},
			requestedDevice: requestedDeviceForFit(deviceValue),
			statesById,
		});
	};
	return getFitAssessment;
}
