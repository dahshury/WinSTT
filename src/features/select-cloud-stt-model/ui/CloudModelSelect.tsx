"use client";

import { OpenRouterModelSelector } from "@picker";
import { useEffect } from "react";
import { useTranslations } from "use-intl";
import {
	CLOUD_CATALOG,
	CLOUD_PROVIDERS,
	defaultCloudModelId,
	providerDisplayName,
	providerOf,
	useOpenRouterSttCatalogStore,
} from "@/entities/cloud-stt-provider";
import { useSettingsStore } from "@/entities/setting";
import { windowOpenSettings } from "@/shared/api/ipc-client";
import type {
	CloudSttProvider,
	OpenRouterModel,
	OpenRouterSttModel,
	OpenRouterVariant,
} from "@/shared/api/models";
import { Button } from "@/shared/ui/button";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import type { SelectOption, SelectOptionGroup } from "@/shared/ui/select";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";

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

/** Short provider badge for the simple grouped picker fallback. */
function providerBadge(provider: CloudSttProvider): string {
	return provider === "openrouter"
		? "OR"
		: providerDisplayName(provider).slice(0, 4).toUpperCase();
}

function scoreLabel(accuracyScore: number, speedScore: number): string {
	return `A${Math.round(accuracyScore * 100)} / S${Math.round(speedScore * 100)}`;
}

const OPENROUTER_SELECTION_PREFIX = "openrouter:";
const OPENROUTER_STT_SELECTOR_UI_STORAGE_KEY =
	"winstt:model-picker:openrouter-stt-ui";
const OPENROUTER_STT_FAVORITE_MODELS_STORAGE_KEY =
	"winstt:openrouter-stt-favorite-models";
const OPENROUTER_STT_FAVORITE_PROVIDERS_STORAGE_KEY =
	"winstt:openrouter-stt-favorite-providers";
const OPENROUTER_VARIANTS: readonly OpenRouterVariant[] = [
	"exacto",
	"extended",
	"floor",
	"free",
	"nitro",
	"online",
	"thinking",
];

function stripOpenrouterSelectionPrefix(modelId: string): string {
	return modelId.startsWith(OPENROUTER_SELECTION_PREFIX)
		? modelId.slice(OPENROUTER_SELECTION_PREFIX.length)
		: "";
}

function prefixOpenrouterSelection(modelId: string): string {
	return modelId
		? `${OPENROUTER_SELECTION_PREFIX}${modelId}`
		: defaultCloudModelId("openrouter");
}

function parseOpenrouterId(id: string): {
	maker?: string;
	modelName: string;
	variant?: OpenRouterVariant;
} {
	let base = id;
	let variant: OpenRouterVariant | undefined;
	for (const candidate of OPENROUTER_VARIANTS) {
		const suffix = `:${candidate}`;
		if (base.endsWith(suffix)) {
			base = base.slice(0, -suffix.length);
			variant = candidate;
			break;
		}
	}
	const parts = base.split("/").filter(Boolean);
	if (parts.length <= 1) {
		return {
			modelName: parts[0] ?? id,
			...(variant ? { variant } : {}),
		};
	}
	return {
		maker: (parts[0] as string).replace(/^~+/, ""),
		modelName: parts.slice(1).join("/"),
		...(variant ? { variant } : {}),
	};
}

function sttModelToOpenrouterPickerModel(
	model: OpenRouterSttModel,
): OpenRouterModel {
	const parsed = parseOpenrouterId(model.id);
	return {
		id: model.id,
		name: model.name,
		architecture: {
			input_modalities: ["audio"],
			output_modalities: ["transcription"],
		},
		accuracy_score: model.accuracy_score,
		speed_score: model.speed_score,
		model_name: parsed.modelName,
		provider: "openrouter",
		supported_parameters: [],
		...(model.endpoints ? { endpoints: model.endpoints } : {}),
		...(parsed.maker ? { maker: parsed.maker } : {}),
		...(parsed.variant ? { variant: parsed.variant } : {}),
		...(model.description ? { description: model.description } : {}),
		...(model.pricing ? { pricing: model.pricing } : {}),
	};
}

function modelIdForProvider(
	provider: CloudSttProvider,
	firstOpenrouterId: string | null,
	allowPendingOpenrouter = false,
): string | null {
	return provider === "openrouter"
		? (firstOpenrouterId ??
				(allowPendingOpenrouter ? defaultCloudModelId("openrouter") : null))
		: defaultCloudModelId(provider);
}

/**
 * Compact single-combobox picker for cloud STT models — replaces the older
 * inline `CloudSttSection` vertical accordion in places where the parent
 * provides a Local/Cloud mode switcher and only renders one picker at a time.
 *
 * Only providers whose API key has been configured contribute rows. ElevenLabs
 * reads its key from `integrations.elevenlabs.apiKey` and renders the curated
 * `CLOUD_CATALOG`; OpenRouter shares the LLM key (`llm.openrouterApiKey`) and
 * renders the LIVE transcription-model scan (`useOpenRouterSttCatalogStore`).
 * When no provider has a key, the picker collapses to a "Configure key →" link
 * so the user has a single discoverable affordance to land in Integrations.
 */
export function CloudModelSelect({
	selectedId,
	onSelect,
	defaultOpen = false,
}: CloudModelSelectProps) {
	const t = useTranslations("integrations");
	const integrations = useSettingsStore((s) => s.settings.integrations);
	const openrouterKey = useSettingsStore(
		(s) => s.settings.llm.openrouterApiKey,
	);
	const openrouterModels = useOpenRouterSttCatalogStore((s) => s.models);
	const openrouterScanning = useOpenRouterSttCatalogStore((s) => s.isScanning);
	const scanOpenrouterModels = useOpenRouterSttCatalogStore(
		(s) => s.scanModels,
	);

	const openrouterConfigured = openrouterKey.trim().length > 0;

	// Kick the live transcription-model scan when the OpenRouter key is present.
	// The store caches on first load and dedupes concurrent calls.
	useEffect(() => {
		if (openrouterConfigured) {
			scanOpenrouterModels().catch(() => undefined);
		}
	}, [openrouterConfigured, scanOpenrouterModels]);

	const isProviderConfigured = (provider: CloudSttProvider): boolean =>
		provider === "openrouter"
			? openrouterConfigured
			: integrations[provider].apiKey.trim().length > 0;

	const availableProviders = CLOUD_PROVIDERS.filter(isProviderConfigured);

	// Rows for one provider: the curated `CLOUD_CATALOG` for ElevenLabs;
	// the live scan store for OpenRouter (its static catalog is empty).
	const rowsFor = (provider: CloudSttProvider): SelectOption[] =>
		provider === "openrouter"
			? openrouterModels.map((m) => ({
					id: `openrouter:${m.id}`,
					label: `${m.name} - ${scoreLabel(m.accuracy_score, m.speed_score)}`,
				}))
			: CLOUD_CATALOG[provider].map((m) => ({
					id: `${provider}:${m.id}`,
					label: m.displayName,
				}));

	// One group per configured provider (header = provider name + badge); the
	// flat list is kept only for the self-heal / valid-selection checks.
	const groups: SelectOptionGroup[] = availableProviders.map((provider) => ({
		value: provider,
		label: providerDisplayName(provider),
		badge: providerBadge(provider),
		options: rowsFor(provider),
	}));
	const options: SelectOption[] = groups.flatMap((g) => [...g.options]);
	const openrouterPickerModels = openrouterModels.map(
		sttModelToOpenrouterPickerModel,
	);

	// Self-heal: when the persisted cloud model is no longer a selectable option
	// (e.g. a model dropped from the catalog, the bare `openrouter:` default just
	// after switching to Cloud, or an empty selection), auto-pick the first
	// available provider's default so the picker never sits on a broken/empty
	// value and a hotkey press always has a usable model. For OpenRouter the
	// default resolves from the first live-scanned row (so the effect re-fires
	// once the scan lands).
	const firstProvider = availableProviders[0];
	const firstOpenrouterId =
		openrouterModels.length > 0
			? `openrouter:${openrouterModels[0]?.id}`
			: null;
	const selectedProvider = providerOf(selectedId);
	const activeProvider =
		selectedProvider !== null && availableProviders.includes(selectedProvider)
			? selectedProvider
			: firstProvider;
	const hasValidSelection = options.some((o) => o.id === selectedId);
	useEffect(() => {
		if (activeProvider && !hasValidSelection) {
			const fallback = modelIdForProvider(activeProvider, firstOpenrouterId);
			if (fallback) {
				onSelect(fallback);
			}
		}
	}, [activeProvider, firstOpenrouterId, hasValidSelection, onSelect]);

	if (availableProviders.length === 0) {
		return (
			<div className="flex flex-col gap-2">
				<Button
					className="self-start text-warning text-xs underline-offset-2 hover:underline"
					onClick={windowOpenSettings}
					type="button"
				>
					{t("configureKey")} →
				</Button>
			</div>
		);
	}

	const providerOptions: SwitcherOption<CloudSttProvider>[] =
		availableProviders.map((provider) => ({
			value: provider,
			label: providerDisplayName(provider),
		}));
	const handleProviderChange = (provider: CloudSttProvider): void => {
		const fallback = modelIdForProvider(provider, firstOpenrouterId, true);
		if (fallback) {
			onSelect(fallback);
		}
	};
	const renderProviderToggle =
		activeProvider !== undefined && availableProviders.length > 1;
	const renderOpenrouterPicker = activeProvider === "openrouter";

	return (
		<div
			className={
				defaultOpen && renderOpenrouterPicker
					? "flex min-h-0 flex-1 flex-col gap-2"
					: "flex flex-col gap-2"
			}
		>
			{renderProviderToggle ? (
				<ElevatedSurface className="w-60 max-w-full">
					<Switcher
						fullWidth
						onChange={handleProviderChange}
						options={providerOptions}
						value={activeProvider}
					/>
				</ElevatedSurface>
			) : null}
			{renderOpenrouterPicker ? (
				<OpenRouterModelSelector
					favoriteModelsStorageKey={OPENROUTER_STT_FAVORITE_MODELS_STORAGE_KEY}
					favoriteProvidersStorageKey={
						OPENROUTER_STT_FAVORITE_PROVIDERS_STORAGE_KEY
					}
					inline={defaultOpen}
					isLoading={openrouterScanning}
					models={openrouterPickerModels}
					onChange={(modelId) => onSelect(prefixOpenrouterSelection(modelId))}
					onOpen={() => {
						scanOpenrouterModels().catch(() => undefined);
					}}
					placeholder={t("cloudModels")}
					popupWidthClass="w-[max(580px,var(--anchor-width))]"
					uiStorageKey={OPENROUTER_STT_SELECTOR_UI_STORAGE_KEY}
					value={stripOpenrouterSelectionPrefix(selectedId)}
				/>
			) : (
				<ElevatedSurface inline>
					<SearchableSelect
						defaultOpen={defaultOpen}
						groups={groups.filter((g) => g.value === activeProvider)}
						onChange={onSelect}
						placeholder={t("cloudModels")}
						value={selectedId}
					/>
				</ElevatedSurface>
			)}
			<span className="text-2xs text-foreground-muted">{t("cloudHelper")}</span>
		</div>
	);
}
