"use client";

import { OpenRouterModelSelector } from "@/widgets/model-picker";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type MouseEvent, useLayoutEffect } from "react";
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
} from "@/shared/api/models";
import { fireAndForget } from "@/shared/lib/fire-and-forget";
import { parseOpenrouterId } from "@/shared/lib/openrouter-picker-id";
import { brandLogoFor } from "@/shared/ui/brand-logo";
import { Button } from "@/shared/ui/button";
import { SearchableSelect } from "@/shared/ui/searchable-select";
import type { SelectOption, SelectOptionGroup } from "@/shared/ui/select";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { MODEL_TRIGGER_GLASS_CLASSES } from "@/shared/ui/switching-trigger";

interface CloudModelSelectProps {
	disabled?: boolean;
	disabledTooltip?: string | undefined;
	/**
	 * Open the combobox on mount. The detached picker window sets this so the
	 * cloud model list is visible immediately (the window exists only to show
	 * the picker); the inline settings usage leaves it closed.
	 */
	defaultOpen?: boolean;
	/**
	 * What to render when NO provider has a configured key.
	 *   - `"configure-link"` (default): a "Configure key →" link into
	 *     Settings → Integrations — the right affordance from a settings surface.
	 *   - `"disabled"`: an inert, disabled selector. Used by onboarding, where
	 *     the key is entered on the very same page, so a link back to Settings
	 *     makes no sense — the selector simply unlocks once a key lands.
	 */
	emptyState?: "configure-link" | "disabled";
	/** When set, the trigger opens the detached cloud picker window (passing its
	 *  on-screen rect) instead of rendering the inline combobox/picker — used by
	 *  the Settings panel so the picker can extend beyond the settings window. */
	onOpenDetached?: (rect: DOMRect) => void;
	onSelect: (modelId: string) => void;
	selectedId: string;
}

/** Glass-card trigger button for the detached cloud picker — mirrors the STT /
 *  TTS detached triggers. Shows the selected cloud model's label (resolved by
 *  the parent from the live option list) or the placeholder. */
function CloudModelSelectTrigger({
	disabled,
	disabledTooltip,
	label,
	placeholder,
	onActivate,
}: {
	disabled: boolean;
	disabledTooltip: string | undefined;
	label: string | undefined;
	placeholder: string;
	onActivate: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
	return (
		<Button
			aria-expanded={false}
			className={MODEL_TRIGGER_GLASS_CLASSES}
			data-slot="cloud-model-selector-trigger"
			disabled={disabled}
			onClick={onActivate}
			title={disabled ? disabledTooltip : undefined}
			type="button"
		>
			<span
				className={
					label
						? "flex min-w-0 flex-1 items-center truncate font-medium text-body text-foreground leading-tight tracking-tight"
						: "flex min-w-0 flex-1 items-center font-medium text-body text-foreground-muted italic tracking-tight"
				}
			>
				{label ?? placeholder}
			</span>
			<HugeiconsIcon
				className="ms-2 size-4 shrink-0 text-foreground-muted"
				icon={ArrowDown01Icon}
			/>
		</Button>
	);
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
	disabled = false,
	disabledTooltip,
	selectedId,
	onSelect,
	defaultOpen = false,
	emptyState = "configure-link",
	onOpenDetached,
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
	useLayoutEffect(() => {
		if (!disabled && openrouterConfigured) {
			fireAndForget(scanOpenrouterModels(), "cloud-stt.scanOpenrouterModels");
		}
	}, [disabled, openrouterConfigured, scanOpenrouterModels]);

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

	// One group per configured provider (header = brand logo + provider name);
	// the flat list is kept only for the self-heal / valid-selection checks. The
	// brand mark replaces the old short text code so each provider is recognizable
	// at a glance, matching the Integrations tab and provider switcher.
	const groups: SelectOptionGroup[] = availableProviders.map((provider) => ({
		value: provider,
		label: providerDisplayName(provider),
		icon: brandLogoFor(provider, { className: "size-3.5" }),
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
	const fallbackSelection =
		activeProvider === undefined
			? null
			: modelIdForProvider(activeProvider, firstOpenrouterId);
	const effectiveSelectedId = hasValidSelection
		? selectedId
		: (fallbackSelection ?? "");
	if (!disabled && !hasValidSelection && fallbackSelection) {
		queueMicrotask(() => {
			onSelect(fallbackSelection);
		});
	}

	if (availableProviders.length === 0) {
		// Onboarding enters the key on the same page, so the link-into-Settings
		// affordance is wrong there — show an inert selector that unlocks once a
		// key is configured instead.
		if (emptyState === "disabled") {
			return (
				<div className="flex flex-col gap-2">
					<SearchableSelect
						disabled
						groups={[]}
						onChange={() => undefined}
						placeholder={t("cloudModels")}
						value=""
					/>

					<span className="text-2xs text-foreground-muted">
						{t("cloudHelper")}
					</span>
				</div>
			);
		}
		return (
			<div className="flex flex-col gap-2">
				<Button
					className="self-start text-warning text-xs underline-offset-2 hover:underline"
					disabled={disabled}
					onClick={windowOpenSettings}
					title={disabled ? disabledTooltip : undefined}
					type="button"
				>
					{t("configureKey")} →
				</Button>
			</div>
		);
	}

	// Detached-open mode (Settings panel): render a trigger button that opens the
	// floating cloud picker window instead of the inline combobox/picker.
	if (onOpenDetached) {
		const selectedOption = options.find((o) => o.id === effectiveSelectedId);
		return (
			<div className="flex flex-col gap-2">
				<CloudModelSelectTrigger
					disabled={disabled}
					disabledTooltip={disabledTooltip}
					label={selectedOption?.label}
					onActivate={(event) =>
						onOpenDetached(event.currentTarget.getBoundingClientRect())
					}
					placeholder={t("cloudModels")}
				/>
				<span className="text-2xs text-foreground-muted">
					{t("cloudHelper")}
				</span>
			</div>
		);
	}

	const providerOptions: SwitcherOption<CloudSttProvider>[] =
		availableProviders.map((provider) => ({
			value: provider,
			label: providerDisplayName(provider),
			iconNode: brandLogoFor(provider),
			...(disabled ? { disabled: true } : {}),
			...(disabled && disabledTooltip ? { tooltip: disabledTooltip } : {}),
		}));
	const handleProviderChange = (provider: CloudSttProvider): void => {
		if (disabled) {
			return;
		}
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
				<Switcher
					className="w-60 max-w-full"
					fullWidth
					onChange={handleProviderChange}
					options={providerOptions}
					value={activeProvider}
				/>
			) : null}
			{renderOpenrouterPicker ? (
				<OpenRouterModelSelector
					disabled={disabled}
					favoriteModelsStorageKey={OPENROUTER_STT_FAVORITE_MODELS_STORAGE_KEY}
					favoriteProvidersStorageKey={
						OPENROUTER_STT_FAVORITE_PROVIDERS_STORAGE_KEY
					}
					inline={defaultOpen}
					isLoading={openrouterScanning}
					models={openrouterPickerModels}
					onChange={(modelId) => {
						if (!disabled) {
							onSelect(prefixOpenrouterSelection(modelId));
						}
					}}
					onOpen={() => {
						if (!disabled) {
							fireAndForget(
								scanOpenrouterModels(),
								"cloud-stt.scanOpenrouterModels",
							);
						}
					}}
					placeholder={t("cloudModels")}
					popupWidthClass={
						defaultOpen
							? "w-full max-w-none"
							: "w-[max(580px,var(--anchor-width))]"
					}
					uiStorageKey={OPENROUTER_STT_SELECTOR_UI_STORAGE_KEY}
					value={stripOpenrouterSelectionPrefix(effectiveSelectedId)}
				/>
			) : (
				<SearchableSelect
					defaultOpen={defaultOpen}
					disabled={disabled}
					groups={groups.filter((g) => g.value === activeProvider)}
					onChange={(value) => {
						if (!disabled) {
							onSelect(value);
						}
					}}
					placeholder={t("cloudModels")}
					value={effectiveSelectedId}
				/>
			)}
			<span className="text-2xs text-foreground-muted">{t("cloudHelper")}</span>
		</div>
	);
}
