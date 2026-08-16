import { useEffect, useRef, useState } from "react";
import { commands, type VoiceCatalogPayload } from "@/bindings";

/** Apply a stale-voice fallback when the saved voice isn't in the catalog. */
type ApplyVoiceFallback = (patch: { voice: string; lang: string }) => void;

/**
 * Fetch the selected model's native voice catalog once whenever the TTS section
 * is enabled or the model changes. Also self-heals a stale saved `voice`: if the
 * catalog doesn't offer it, the first voice is applied via `update` so the
 * dropdown never sits in an empty-selection state (which would crash synth at
 * request time).
 *
 * The freshest `voice` / `update` are read through refs so voice changes don't
 * re-fetch the static catalog.
 */
export function useTtsVoiceCatalog(
	enabled: boolean,
	modelId: string,
	voice: string,
	update: ApplyVoiceFallback,
	keepUnlistedVoice = false,
): VoiceCatalogPayload {
	const [catalog, setCatalog] = useState<VoiceCatalogPayload>({
		voices: [],
		languages: [],
	});

	// Latest-value refs for the catalog fetch. We only want to run the fetch when
	// `enabled` or `modelId` changes, but the .then() callback needs the freshest
	// `voice` / `update` to apply the stale-voice fallback. Refs are written in an
	// effect (NOT during render) to comply with React's no-side-effects-in-render
	// rule.
	const voiceRef = useRef(voice);
	const updateRef = useRef(update);
	const keepUnlistedRef = useRef(keepUnlistedVoice);
	useEffect(() => {
		voiceRef.current = voice;
		updateRef.current = update;
		keepUnlistedRef.current = keepUnlistedVoice;
	});

	useEffect(() => {
		if (!enabled) {
			return;
		}
		let cancelled = false;

		const applyCatalog = (result: VoiceCatalogPayload): void => {
			setCatalog(result);
			const currentVoice = voiceRef.current;
			const valid = result.voices.some((v) => v.id === currentVoice);
			// A cloning model's `voice` legitimately holds a reference-clip PATH,
			// which is never in the catalog. Healing it would silently delete the
			// user's clip the next time the section re-enabled or the catalog
			// refetched, so unlisted values are left alone for those models.
			if (valid || keepUnlistedRef.current) {
				return;
			}
			const first = result.voices[0];
			if (first) {
				updateRef.current({ voice: first.id, lang: first.language });
			}
		};

		// The native catalog command is synchronous and authoritative. Fetch once
		// for this enabled/model lifecycle; an empty result keeps the last visible
		// catalog instead of blanking the picker.
		commands
			.ttsListVoices(modelId)
			.then((result) => {
				if (cancelled) {
					return;
				}
				if (result.voices.length > 0) {
					applyCatalog(result);
				}
			})
			.catch((error: unknown) => {
				if (!cancelled) {
					console.error("[tts] failed to load voice catalog", error);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [enabled, modelId]);

	return catalog;
}
