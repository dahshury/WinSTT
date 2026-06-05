interface ProcessingStartedAtArgs {
	isThinking: boolean;
	isTranscribing: boolean;
	thinkingStartedAt: number | null;
	transcribingStartedAt: number | null;
}

export function getProcessingStartedAt({
	isThinking,
	isTranscribing,
	thinkingStartedAt,
	transcribingStartedAt,
}: ProcessingStartedAtArgs): number | null {
	if (isThinking) {
		return transcribingStartedAt ?? thinkingStartedAt;
	}
	if (isTranscribing) {
		return transcribingStartedAt;
	}
	return null;
}
