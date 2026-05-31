import { useEffect } from "react";
import { useSettingsStore } from "@/entities/setting";

/**
 * Mutual-exclusion between the STT decoder's "Translate to English" pass and
 * the LLM dictation "Translate" modifier. Both translate the same transcript,
 * so running them together double-translates (and fights over the target
 * language). When the STT toggle is effectively active we drop the `translate`
 * entry from the dictation presets; the LLM panel additionally disables the row
 * so it can't be re-enabled while this holds. Mirrors `useLockRealtimeToMain`'s
 * "force setting B from setting A" shape.
 *
 * One-way by design: turning the STT toggle back off does NOT restore a
 * previously-enabled translate modifier (matching `useLockRealtimeToMain` and
 * the Smart-Endpoint mutual-exclusion, which also don't auto-restore). The user
 * re-enables it manually — the LLM panel remembers the last target language, so
 * re-enabling is one click.
 *
 * The deps are the two booleans that gate the action, so the effect doesn't
 * re-run on unrelated preset edits; it reads the latest presets via `getState()`
 * at action time to avoid a stale closure. Idempotent: once `translate` is gone
 * `llmTranslateEnabled` is false, so it no-ops (no update loop).
 */
export function useLockLlmTranslate(
	sttTranslateActive: boolean,
	llmTranslateEnabled: boolean
): void {
	useEffect(() => {
		if (!(sttTranslateActive && llmTranslateEnabled)) {
			return;
		}
		const { settings, updateLlmDictation } = useSettingsStore.getState();
		updateLlmDictation({
			presets: settings.llm.dictation.presets.filter((p) => p.key !== "translate"),
		});
	}, [sttTranslateActive, llmTranslateEnabled]);
}
