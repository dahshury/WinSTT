import { ApiIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import { SettingSection } from "@/entities/setting";
import { KeyProviderCard } from "./KeyProviderCard";
import { OllamaCard } from "./OllamaCard";

/**
 * The Integrations tab: one card per provider, in a single flat column.
 *
 * The previous layout split the same three providers across two capability
 * sections ("Language Models" / "Cloud Speech-to-Text"), which forced OpenRouter
 * — a provider that backs LLM cleanup, cloud transcription AND cloud voices — to
 * live under one heading and silently gate surfaces belonging to the other. Each
 * card now states its own capabilities, so the grouping has no work left to do.
 *
 * Order is local-first: Ollama needs no account at all, so it leads; the two
 * hosted providers follow, widest reach first.
 */
export function IntegrationsSettingsPanel() {
	const t = useTranslations("integrations");
	const tLlm = useTranslations("llm");

	return (
		<SettingSection
			description={t("description")}
			icon={ApiIcon}
			title={t("title")}
		>
			<div className="flex flex-col gap-3 pt-2">
				<OllamaCard />
				{/* The OpenRouter key is deliberately dual-purpose: besides the LLM
				    provider it unlocks OpenRouter cloud transcription (Model tab →
				    Cloud) and OpenRouter cloud voices, all off the one key. That used
				    to be discoverable only by reading a tooltip; it is now spelled out
				    by the card's capability chips. */}
				<KeyProviderCard
					description={t("openrouterDescription")}
					keyLabel={tLlm("openrouterApiKey")}
					placeholder={tLlm("openrouterApiKeyPlaceholder")}
					provider="openrouter"
				/>
				<KeyProviderCard
					description={t("elevenlabsDescription")}
					keyLabel={t("elevenlabsApiKey")}
					placeholder={t("elevenlabsApiKeyPlaceholder")}
					provider="elevenlabs"
				/>
			</div>
		</SettingSection>
	);
}
