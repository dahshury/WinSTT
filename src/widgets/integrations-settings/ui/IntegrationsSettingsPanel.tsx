import { ApiIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import { SettingSection } from "@/entities/setting";
import { ProviderIntegrationSection } from "@/features/verify-credentials";
import { LlmIntegrationSection } from "./LlmIntegrationSection";

export function IntegrationsSettingsPanel() {
	const t = useTranslations("integrations");

	return (
		<div className="flex flex-col">
			{/* ── Language Models (LLM) ───────────────────────────────────
			 *  Powers dictation cleanup, context-aware edits and translation.
			 *  Backed by a LOCAL Ollama server (endpoint) or a CLOUD OpenRouter
			 *  key. NOTE: the OpenRouter key is dual-purpose — besides the LLM
			 *  provider it ALSO unlocks OpenRouter cloud *transcription* models
			 *  in the Model tab's Cloud source (it shares the single key). The
			 *  STT-only providers (OpenAI / ElevenLabs) live in the section
			 *  below. */}
			<LlmIntegrationSection />

			{/* ── Cloud Speech-to-Text ────────────────────────────────────
			 *  STT-only provider key that unlocks the Local/Cloud Source switcher
			 *  in the Transcription tab. ElevenLabs (Scribe) lives here; OpenRouter
			 *  is the other cloud STT provider but reuses its LLM key above, so
			 *  `hasAnyCloudKey` (MainModelSection / ModelPickerWindow) gates on the
			 *  ElevenLabs key PLUS `llm.openrouterApiKey`. (OpenAI was removed — its
			 *  Whisper / GPT-4o transcribe models are served via OpenRouter.) */}
			<SettingSection
				boxed
				description={t("sttSectionCaption")}
				icon={ApiIcon}
				title={t("sttSectionTitle")}
			>
				<div className="flex flex-col">
					<ProviderIntegrationSection
						keyCaption={t("elevenlabsApiKeyCaption")}
						keyLabel={t("elevenlabsApiKey")}
						placeholder={t("elevenlabsApiKeyPlaceholder")}
						provider="elevenlabs"
					/>
				</div>
			</SettingSection>
		</div>
	);
}
