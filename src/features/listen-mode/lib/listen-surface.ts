const LISTEN_SURFACE_AUDIO_LEVEL_THRESHOLD = 0.01;

export interface ListenSurfaceActivity {
	audioLevel: number;
	hasEphemeral: boolean;
	isListenMode: boolean;
	isSpeaking: boolean;
	liveText: string;
}

export function shouldUseListenSurface({
	audioLevel,
	hasEphemeral,
	isListenMode,
	isSpeaking,
	liveText,
}: ListenSurfaceActivity): boolean {
	if (!isListenMode) {
		return false;
	}
	return (
		isSpeaking ||
		audioLevel > LISTEN_SURFACE_AUDIO_LEVEL_THRESHOLD ||
		liveText.trim().length > 0 ||
		hasEphemeral
	);
}
