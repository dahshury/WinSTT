export type AsrPromptCapability = "none" | "task" | "cleanup";

export function asrPromptCapability(modelId: string): AsrPromptCapability {
	if (modelId === "nemotron-3.5-transcribe-30b-a4b") {
		return "cleanup";
	}
	if (modelId === "granite-speech-4.1-2b-plus") {
		return "task";
	}
	return "none";
}

interface PromptSettings {
	general?: { recordingMode?: string };
	model: {
		model: string;
		asrPromptSource?: string;
		asrInstruction?: string;
		asrPromptModel?: string;
		asrAllowSeparateCleanup?: boolean;
	};
}

export function nativeAsrCleanupActive(settings: PromptSettings): boolean {
	return (
		settings.general?.recordingMode !== "listen" &&
		asrPromptCapability(settings.model.model) === "cleanup" &&
		settings.model.asrPromptModel === settings.model.model &&
		(settings.model.asrPromptSource === "cleanupPresets" ||
			(settings.model.asrPromptSource === "custom" &&
				(settings.model.asrInstruction ?? "").trim().length > 0))
	);
}

export function shouldConfirmSeparateCleanup(
	settings: PromptSettings,
): boolean {
	return (
		nativeAsrCleanupActive(settings) && !settings.model.asrAllowSeparateCleanup
	);
}
