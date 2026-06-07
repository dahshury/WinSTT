import { EyeIcon, SparklesIcon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { useTranslations } from "use-intl";
import {
	getModelAssistance,
	type ModelAssistance,
	useCatalogStore,
} from "@/entities/model-catalog";
import {
	DEFAULT_SETTINGS,
	SettingField,
	SettingSection,
	useSettingsStore,
} from "@/entities/setting";
import { cn } from "@/shared/lib/cn";
import { Badge } from "@/shared/ui/badge";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { OptInDialog } from "@/shared/ui/opt-in-dialog";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { Toggle } from "@/shared/ui/toggle";
import { ContextAllowedAppsSection } from "./ContextAllowedAppsSection";
import { ContextDenyListSection } from "./ContextDenyListSection";

type GeneralSettings = NonNullable<
	ReturnType<typeof useSettingsStore.getState>["settings"]["general"]
>;
type UpdateGeneralFn = (patch: Partial<GeneralSettings>) => void;

type GeneralT = ReturnType<typeof useTranslations<"general">>;
type LlmT = ReturnType<typeof useTranslations<"llm">>;
type ContextAppMode = NonNullable<GeneralSettings["contextAppMode"]>;

const CONTEXT_APP_MODE_OPTIONS: readonly SwitcherOption<ContextAppMode>[] = [
	{
		value: "all-except-denied",
		label: "All apps except blocked",
	},
	{
		value: "selected-only",
		label: "Selected apps only",
	},
];

interface ContextAwarenessSectionProps {
	enabled: boolean;
	onCancel: () => void;
	onConfirm: () => void;
	tg: GeneralT;
}

function ContextAwarenessSection({
	enabled,
	onCancel,
	onConfirm,
	tg,
}: ContextAwarenessSectionProps) {
	const ts = useTranslations("settings");
	const general = useSettingsStore((s) => s.settings.general);
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const [dialogOpen, setDialogOpen] = useState(false);
	// Bumped to ask the allowed-apps combobox to pop open (on switching into
	// selected-only mode, or when the user tries to turn the toggle on while
	// that mode still has no apps).
	const [appsOpenNonce, setAppsOpenNonce] = useState(0);
	const requestAppsOpen = (): void => setAppsOpenNonce((n) => n + 1);
	const contextAppMode =
		general?.contextAppMode ?? DEFAULT_SETTINGS.general.contextAppMode;
	const hasAllowedApps = (general?.contextAllowList?.length ?? 0) > 0;
	// Selected-only mode with an empty allow-list captures nothing, so the
	// "on + selected-only + no apps" combination is a dead state. We make it
	// unreachable by gating the toggle's visible on-state on having ≥1 app:
	// the toggle reads off until an app is chosen, then lights up on its own.
	const selectedOnlyWithoutApps =
		contextAppMode === "selected-only" && !hasAllowedApps;
	const effectiveEnabled = enabled && !selectedOnlyWithoutApps;
	// Toggle ON ⇒ ask for consent the first time (the dialog's confirm path is
	// what flips the stored value); once consented, the only thing left to do in
	// selected-only mode is pick apps, so surface the picker instead of leaving a
	// dead toggle. Toggle OFF ⇒ persist immediately (no consent needed).
	const handleToggle = (next: boolean): void => {
		if (next) {
			if (!enabled) {
				setDialogOpen(true);
			} else if (selectedOnlyWithoutApps) {
				requestAppsOpen();
			}
			return;
		}
		onCancel();
	};
	// After consent, if we're in selected-only mode with no apps yet, open the
	// picker so the freshly-on toggle doesn't sit visibly off with nothing to do.
	const handleConfirm = (): void => {
		onConfirm();
		if (selectedOnlyWithoutApps) {
			requestAppsOpen();
		}
	};
	const handleScopeChange = (next: ContextAppMode): void => {
		updateGeneral({ contextAppMode: next });
		if (next === "selected-only") {
			requestAppsOpen();
		}
	};
	return (
		<SettingSection icon={EyeIcon} title={tg("contextAwarenessSection")}>
			<div className="flex flex-col divide-y divide-surface-1">
				<SettingField
					isDefault={
						effectiveEnabled === DEFAULT_SETTINGS.general.contextAwareness
					}
					label={tg("contextAwareness")}
					labelAddon={
						<Toggle checked={effectiveEnabled} onCheckedChange={handleToggle} />
					}
					onReset={onCancel}
					tooltip={
						effectiveEnabled
							? tg("contextAwarenessTooltip")
							: `${tg("contextAwarenessTooltip")} ${ts("disabledReason", { name: tg("contextAwareness") })}`
					}
				/>
				{/* The deny-list (apps/sites to skip) configures the same capture
				    pipeline this toggle gates, so it lives directly beneath it —
				    shown disabled (not hidden) until context awareness is on. */}
				<div
					className={cn(
						"transition-opacity duration-200 ease-out",
						!enabled && "pointer-events-none opacity-40",
					)}
				>
					<SettingField
						isDefault={
							contextAppMode === DEFAULT_SETTINGS.general.contextAppMode
						}
						label="Context scope"
						onReset={() =>
							updateGeneral({
								contextAppMode: DEFAULT_SETTINGS.general.contextAppMode,
							})
						}
						tooltip="Choose whether context awareness can read every app except blocked entries, or only apps you select."
					>
						<ElevatedSurface>
							<Switcher
								fullWidth
								onChange={handleScopeChange}
								options={CONTEXT_APP_MODE_OPTIONS}
								value={contextAppMode}
							/>
						</ElevatedSurface>
					</SettingField>
					{contextAppMode === "selected-only" ? (
						<ContextAllowedAppsSection openRequest={appsOpenNonce} />
					) : (
						<ContextDenyListSection />
					)}
				</div>
			</div>
			<OptInDialog
				body={tg("contextAwarenessDialogBody")}
				cancelLabel={tg("contextAwarenessDialogCancel")}
				confirmLabel={tg("contextAwarenessDialogConfirm")}
				onCancel={onCancel}
				onConfirm={handleConfirm}
				onOpenChange={setDialogOpen}
				open={dialogOpen}
				title={tg("contextAwarenessDialogTitle")}
			/>
		</SettingSection>
	);
}

function modelAssistanceCaption(
	t: LlmT,
	item: ModelAssistance,
	modelName: string,
): string {
	const values = { model: modelName };
	switch (item.reason) {
		case "ctc":
			return t("modelAssistanceCleanupCtc", values);
		case "raw":
			return t("modelAssistanceCleanupRaw", values);
		case "streaming":
			return t("modelAssistanceCleanupStreaming", values);
		case "transducer":
			return t("modelAssistanceCleanupTransducer", values);
		case "verbatim":
			return t("modelAssistanceCleanupVerbatim", values);
	}
}

function ModelAssistanceSection({
	assistance,
	cleanupEnabled,
	modelName,
	t,
}: {
	assistance: readonly ModelAssistance[];
	cleanupEnabled: boolean;
	modelName: string;
	t: LlmT;
}) {
	const cleanupItem = assistance.find(
		(item) => item.kind === "dictationCleanup",
	);
	if (!cleanupItem) {
		return null;
	}
	const setupSuffix = cleanupEnabled
		? ""
		: ` ${t("modelAssistanceCleanupNeedsModel")}`;
	return (
		<SettingSection
			divided
			icon={SparklesIcon}
			title={t("modelAssistanceTitle")}
			tooltip={t("modelAssistanceTooltip")}
		>
			<SettingField
				caption={`${modelAssistanceCaption(t, cleanupItem, modelName)}${setupSuffix}`}
				label={t("modelAssistanceCleanup")}
				labelAddon={
					<Badge variant={cleanupEnabled ? "secondary" : "outline"}>
						{cleanupEnabled
							? t("modelAssistanceAutoBadge")
							: t("modelAssistanceSetupBadge")}
					</Badge>
				}
				tooltip={t("modelAssistanceCleanupTooltip")}
			/>
		</SettingSection>
	);
}

/**
 * Extra controls that are NOT the LLM provider config. Renders after
 * `LlmSettingsPanel` on the Processing tab: model-specific assistance and
 * Context awareness (+ deny-list).
 */
export function ProcessingExtrasPanel() {
	const general = useSettingsStore((s) => s.settings.general);
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const llmDictationEnabled = useSettingsStore(
		(s) => s.settings.llm?.dictation?.enabled ?? false,
	);
	// Context awareness has two consumers (see relay-context-capture):
	//   1. ASR-side: Whisper-only via `<|startofprev|>`. Canary / Cohere
	//      have a `<|startofcontext|>` slot but the released checkpoints
	//      aren't trained on it — empirical bench shows broken / truncated
	//      / hallucinated outputs (see memory note `canary-cohere-prompt-
	//      slot-untrained`). Moonshine / SenseVoice / CTC families have
	//      no prompt mechanism at all.
	//   2. LLM cleanup: any engine benefits when the dictation LLM runs.
	// So the section is meaningful when EITHER condition is met; if
	// neither is, the toggle does nothing — hide it.
	const activeSttModelId = useSettingsStore(
		(s) => s.settings.model?.model ?? "",
	);
	const activeSttModel = useCatalogStore((s) => s.getModel(activeSttModelId));
	const activeSttFamily = activeSttModel?.family;
	const modelAssistance = getModelAssistance(activeSttModel);
	const modelAssistanceUseful = modelAssistance.length > 0;
	const contextAwarenessUseful =
		activeSttFamily === "whisper" || llmDictationEnabled;
	const tg = useTranslations("general");
	const tl = useTranslations("llm");

	const contextAwarenessEnabled = general?.contextAwareness ?? false;

	if (!(contextAwarenessUseful || modelAssistanceUseful)) {
		return null;
	}

	return (
		<div className="flex flex-col gap-2">
			{modelAssistanceUseful ? (
				<ModelAssistanceSection
					assistance={modelAssistance}
					cleanupEnabled={llmDictationEnabled}
					modelName={activeSttModel?.displayName ?? activeSttModelId}
					t={tl}
				/>
			) : null}
			{/* ── Context Awareness ────────────────────────────
				 Shown only when at least one consumer can actually act on
				 the captured snapshot:
				   * ASR-side: active model is a Whisper variant (the only
				     family whose released checkpoints accept and respond
				     to prior-text prompts — see memory note
				     `canary-cohere-prompt-slot-untrained` for the bench
				     evidence on Canary / Cohere / Moonshine).
				   * LLM-side: dictation LLM is enabled (the cleanup pass
				     consumes context regardless of which ASR engine ran).
				 With neither condition met the toggle does nothing, so we
				 hide it instead of advertising a dead setting. */}
			{contextAwarenessUseful ? (
				<ContextAwarenessSection
					enabled={contextAwarenessEnabled}
					onCancel={() => updateGeneral({ contextAwareness: false })}
					onConfirm={() => updateGeneral({ contextAwareness: true })}
					tg={tg}
				/>
			) : null}
		</div>
	);
}
