import { useEffect, useRef, useState } from "react";
import { listTtsVoices, type TtsVoiceCatalog } from "@/shared/api/ipc-client";

// The Kokoro voice catalog is a STATIC server-side list, so an empty fetch
// result is never legitimate — it only ever means the `list_tts_voices`
// request timed out because the server's asyncio loop was briefly starved
// (GIL-bound) by a TTS warm-up / model-load. That warm-up now fires whenever
// the TTS source is toggled cloud↔local, so a user flipping to "Local" to
// pick a voice can race it. Retry on empty so a transient stall doesn't strand
// the picker on "no voices loaded yet". Each `listTtsVoices()` blocks up to the
// IPC request timeout, so the attempts are already naturally spaced.
const VOICE_CATALOG_RETRY_ATTEMPTS = 5;
const VOICE_CATALOG_RETRY_MS = 2000;

/** Apply a stale-voice fallback when the saved voice isn't in the catalog. */
type ApplyVoiceFallback = (patch: { voice: string; lang: string }) => void;

/**
 * Fetch (and main-side cache) the Kokoro voice catalog whenever the TTS section
 * is enabled, retrying through transient empty responses. Also self-heals a
 * stale saved `voice`: if the catalog doesn't offer it, the first voice is
 * applied via `update` so the dropdown never sits in an empty-selection state
 * (which would crash synth at request time).
 *
 * The fetch keys only on `enabled`; the freshest `voice` / `update` are read
 * through refs so re-enabling doesn't re-run the effect on every keystroke.
 */
export function useTtsVoiceCatalog(
	enabled: boolean,
	modelId: string,
	voice: string,
	update: ApplyVoiceFallback,
): TtsVoiceCatalog {
	const [catalog, setCatalog] = useState<TtsVoiceCatalog>({
		voices: [],
		languages: [],
	});

	// Latest-value refs for the on-enable catalog fetch. We only want to run the
	// fetch when `enabled` flips, but the .then() callback needs the freshest
	// `voice` / `update` to apply the stale-voice fallback. Refs are written in an
	// effect (NOT during render) to comply with React's no-side-effects-in-render
	// rule.
	const voiceRef = useRef(voice);
	const updateRef = useRef(update);
	useEffect(() => {
		voiceRef.current = voice;
		updateRef.current = update;
	});

	useEffect(() => {
		if (!enabled) {
			return;
		}
		let cancelled = false;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;

		const applyCatalog = (result: TtsVoiceCatalog): void => {
			setCatalog(result);
			const currentVoice = voiceRef.current;
			const valid = result.voices.some((v) => v.id === currentVoice);
			if (valid) {
				return;
			}
			const first = result.voices[0];
			if (first) {
				updateRef.current({ voice: first.id, lang: first.language });
			}
		};

		// Empty == the request timed out (the catalog is never legitimately
		// empty — see VOICE_CATALOG_RETRY_* above). Keep any previously-loaded
		// catalog instead of blanking it, and retry until the server's loop is
		// free again. A successful fetch is cached main-side, so a later re-open
		// resolves instantly.
		const fetchVoices = (attemptsLeft: number): void => {
			listTtsVoices(modelId).then((result) => {
				if (cancelled) {
					return;
				}
				if (result.voices.length > 0) {
					applyCatalog(result);
					return;
				}
				if (attemptsLeft > 0) {
					retryTimer = setTimeout(
						() => fetchVoices(attemptsLeft - 1),
						VOICE_CATALOG_RETRY_MS,
					);
				}
			});
		};
		fetchVoices(VOICE_CATALOG_RETRY_ATTEMPTS);

		return () => {
			cancelled = true;
			if (retryTimer) {
				clearTimeout(retryTimer);
			}
		};
	}, [enabled, modelId]);

	return catalog;
}
