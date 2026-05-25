"use client";

import { useTranslations } from "next-intl";
import { CLOUD_CATALOG, CLOUD_PROVIDERS, providerDisplayName } from "@/entities/cloud-stt-provider";
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
 * Only providers whose API key has been configured contribute rows. When no
 * provider has a key, the picker collapses to a "Configure key →" link so
 * the user has a single discoverable affordance to land in Integrations.
 */
export function CloudModelSelect({ selectedId, onSelect }: CloudModelSelectProps) {
	const t = useTranslations("integrations");
	const integrations = useSettingsStore((s) => s.settings.integrations);

	const availableProviders = CLOUD_PROVIDERS.filter(
		(provider) => integrations[provider].apiKey.trim().length > 0
	);

	if (availableProviders.length === 0) {
		return (
			<div className="flex flex-col gap-2">
				<button
					className="self-start text-warning text-xs underline-offset-2 hover:underline"
					onClick={windowOpenSettings}
					type="button"
				>
					{t("configureKey")} →
				</button>
			</div>
		);
	}

	const options: SelectOption[] = availableProviders.flatMap((provider) =>
		CLOUD_CATALOG[provider].map((m) => ({
			id: `${provider}:${m.id}`,
			label: m.displayName,
			badge: providerDisplayName(provider).slice(0, 4).toUpperCase(),
		}))
	);

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
			<span className="text-2xs text-foreground-muted">{t("cloudHelper")}</span>
		</div>
	);
}
