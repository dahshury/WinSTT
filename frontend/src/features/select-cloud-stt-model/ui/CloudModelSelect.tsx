"use client";

import { useTranslations } from "next-intl";
import {
	CLOUD_CATALOG,
	CLOUD_PROVIDERS,
	providerDisplayName,
	providerOf,
} from "@/entities/cloud-stt-provider";
import { useSettingsStore } from "@/entities/setting";
import { windowOpenSettings } from "@/shared/api/ipc-client";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import type { SelectOption } from "@/shared/ui/select";

interface CloudModelSelectProps {
	onSelect: (modelId: string) => void;
	selectedId: string;
}

/**
 * Compact single-combobox picker for cloud STT models — replaces the older
 * inline `CloudSttSection` vertical accordion in places where the parent
 * provides a Local/Cloud mode switcher and only renders one picker at a time.
 *
 * Every cloud model in the hand-curated catalog becomes a row in one flat
 * popup, prefixed by a short provider badge (`OPENAI` / `ELEV`). Persisted
 * id keeps the same `provider:model_id` envelope the server consumes.
 *
 * When the currently-selected option's provider has no API key configured,
 * we surface an inline "Configure key →" link beneath the picker instead of
 * the cloud-helper hint. The picker itself stays interactive so the user
 * can pick a *different* (configured) cloud model without first removing
 * the broken one.
 */
export function CloudModelSelect({ selectedId, onSelect }: CloudModelSelectProps) {
	const t = useTranslations("integrations");
	const integrations = useSettingsStore((s) => s.settings.integrations);

	// Flatten the catalog into one option list per provider. Badge is a short
	// uppercased tag derived from the display name (`OpenAI` → `OPEN`,
	// `ElevenLabs` → `ELEV`) — gives the user a per-row provider hint without
	// duplicating the full provider name on every row.
	const options: SelectOption[] = CLOUD_PROVIDERS.flatMap((provider) =>
		CLOUD_CATALOG[provider].map((m) => ({
			id: `${provider}:${m.id}`,
			label: m.displayName,
			badge: providerDisplayName(provider).slice(0, 4).toUpperCase(),
		}))
	);

	const selectedProvider = providerOf(selectedId);
	const selectedKeyMissing =
		selectedProvider !== null && integrations[selectedProvider].apiKey.trim().length === 0;

	return (
		<div className="flex flex-col gap-2">
			<ElevatedSurface inline>
				<SearchableSelect
					onChange={onSelect}
					options={options}
					placeholder={t("cloudModels")}
					value={selectedId}
				/>
			</ElevatedSurface>
			{selectedKeyMissing ? (
				<button
					className="self-start text-warning text-xs underline-offset-2 hover:underline"
					onClick={windowOpenSettings}
					type="button"
				>
					{t("configureKey")} →
				</button>
			) : (
				<span className="text-2xs text-foreground-muted">{t("cloudHelper")}</span>
			)}
		</div>
	);
}
