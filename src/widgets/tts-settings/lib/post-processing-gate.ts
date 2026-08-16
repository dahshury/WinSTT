import type { AppSettingsOutput } from "@/shared/config/settings-schema";

/** Just the slice of settings the gate reads — keeps the helper callable from a
 *  test without building a whole settings tree. */
export type PostProcessingGateSettings = Pick<
	AppSettingsOutput["llm"],
	"dictation" | "openrouterApiKey"
>;

/**
 * Renderer mirror of the backend's `post_processing_ready`
 * (`src-tauri/src/winstt/commands/tts_voice.rs`).
 *
 * There is no master LLM switch in this app: a post-processing feature runs iff
 * its OWN `enabled` flag is true AND a model is actually configured for the
 * selected provider. `generate_voice_design_prompt` refuses loudly when either
 * half is missing, so the UI must ask the same question before it offers the
 * button — otherwise the affordance renders and then only ever errors.
 *
 * Deliberately as strict as the Rust side on the OpenRouter arm: a saved API
 * key with no model selected is NOT ready (the backend would otherwise fall
 * through to `openrouter/auto`, which is a different, unasked-for model).
 */
export function isPostProcessingReady(
	llm: PostProcessingGateSettings | undefined,
): boolean {
	const dictation = llm?.dictation;
	if (!dictation?.enabled) {
		return false;
	}
	if (dictation.provider === "openrouter") {
		return (
			(llm?.openrouterApiKey ?? "").trim().length > 0 &&
			dictation.openrouterModel.trim().length > 0
		);
	}
	// Apple Intelligence is selected by the OS and has no user model id. The
	// native bridge remains the authoritative device/OS availability gate.
	if (dictation.provider === "apple-intelligence") {
		return true;
	}
	return dictation.model.trim().length > 0;
}
