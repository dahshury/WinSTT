"use client";

import { useTtsPlayback } from "../model/use-tts-playback";

/**
 * Headless mount component. Owns the Web Audio queue + IPC
 * subscriptions for TTS playback. Renders nothing; mount once in the
 * root layout alongside ``TransformToast``.
 */
export function TtsPlaybackMount() {
	useTtsPlayback();
	return null;
}
