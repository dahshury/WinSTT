"use client";

import { useEffect } from "react";
import { useTranslations } from "use-intl";
import {
	CLOUD_CATALOG,
	CLOUD_PROVIDERS,
	defaultCloudModelId,
	providerDisplayName,
} from "@/entities/cloud-stt-provider";
import { useSettingsStore } from "@/entities/setting";
import { windowOpenSettings } from "@/shared/api/ipc-client";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import type { SelectOption } from "@/shared/ui/select";

interface CloudModelSelectProps {
	/**
	 * Open the combobox on mount. The detached picker window sets this so the
	 * cloud model list is visible immediately (the window exists only to show
	 * the picker); the inline settings usage leaves it closed.
	 */
	defaultOpen?: boolean;
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
export function CloudModelSelect({
	selectedId,
	onSelect,
	defaultOpen = false,
}: CloudModelSelectProps) {
	const t = useTranslations("integrations");
	const integrations = useSettingsStore((s) => s.settings.integrations);

	const availableProviders = CLOUD_PROVIDERS.filter(
		(provider) => integrations[provider].apiKey.trim().length > 0
	);

	const options: SelectOption[] = availableProviders.flatMap((provider) =>
		CLOUD_CATALOG[provider].map((m) => ({
			id: `${provider}:${m.id}`,
			label: m.displayName,
			badge: providerDisplayName(provider).slice(0, 4).toUpperCase(),
		}))
	);

	// Self-heal: when the persisted cloud model is no longer a selectable option
	// (e.g. a model dropped from the catalog after an @ai-sdk bump, or an empty
	// selection just after switching to Cloud), auto-pick the first available
	// provider's default so the picker never sits on a broken/empty value and a
	// hotkey press always has a usable model. Gated on primitives so it settles
	// after one swap instead of re-firing each render.
	const firstProvider = availableProviders[0];
	const hasValidSelection = options.some((o) => o.id === selectedId);
	useEffect(() => {
		if (firstProvider && !hasValidSelection) {
			onSelect(defaultCloudModelId(firstProvider));
		}
	}, [firstProvider, hasValidSelection, onSelect]);

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

	return (
		<div className="flex flex-col gap-2">
			<ElevatedSurface inline>
				<SearchableSelect
					defaultOpen={defaultOpen}
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
