import { Button as BaseButton } from "@base-ui/react/button";
import { Tabs } from "@base-ui/react/tabs";
import {
	AiChat02Icon,
	AiEditingIcon,
	AiVoiceGeneratorIcon,
	Books02Icon,
	Cancel01Icon,
	ChartHistogramIcon,
	InformationCircleIcon,
	KeyboardIcon,
	Mic01Icon,
	PackageSentIcon,
	PaintBrush03Icon,
	PlugSocketIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, type ReactNode } from "react";
import { useTranslations } from "use-intl";
import { useSettingsStore, useSettingsTabStore } from "@/entities/setting";
import { useLlmModelPickerStore } from "@/features/llm-model-picker";
import { useModelAssistanceAutoEnable } from "@/features/model-assistance";
import { useCloudKeyAutoRevert } from "@/features/revert-cloud-on-key-removal";
import {
	type SettingsHydrationStatus,
	useSettingsHydrationStore,
} from "@/features/update-settings";
import { settingsWindowReady, windowCloseSelf } from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { Elevated, SurfaceProvider } from "@/shared/lib/surface";
import { useTouchActivation } from "@/shared/lib/use-touch-activation";
import { useEscapeToClose } from "@/shared/lib/window-effects";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { AboutSettingsPanel } from "@/widgets/about-settings";
import { AppearanceSettingsPanel } from "@/widgets/appearance-settings";
import {
	DictionarySettingsPanel,
	EncoderModelCard,
	useEncoderModel,
} from "@/widgets/dictionary-settings";
import { IntegrationsSettingsPanel } from "@/widgets/integrations-settings";
import { LlmSettingsPanel } from "@/widgets/llm-settings";
import { ModelSettingsPanel } from "@/widgets/model-settings";
import { OllamaModelManagerDialog } from "@/widgets/ollama-model-manager";
import {
	OutputSettingsPanel,
	PlaybackSettingsPanel,
} from "@/widgets/output-settings";
import { ProcessingExtrasPanel } from "@/widgets/processing-extras";
import { RecordingSettingsPanel } from "@/widgets/recording-settings";
import { ShortcutsSettingsPanel } from "@/widgets/shortcuts-settings";
import { SnippetsSettingsPanel } from "@/widgets/snippets-settings";
import { TranscriptionHistoryPanel } from "@/widgets/transcription-history-settings";
import { TtsModelPickerHost, TtsModelSection } from "@/widgets/tts-settings";
import { useSettingsSearchKeywords } from "../lib/settings-search";
import { SettingsSidebar, type SidebarLink } from "./SettingsSidebar";

// Composes the Dictionary + Snippets ("vocabulary") tab. The dictionary works with OR without LLM
// cleanup: the LLM owns it when cleanup is on, otherwise the on-device encoder model does (when the
// user has it both enabled and downloaded). The encoder card carries the master on/off switch —
// turning it off disables the feature and removes the model. When neither path can act, the editing
// UI is disabled (greyed + inert), leaving only the encoder card interactive.
function VocabularyTab(): ReactNode {
	const llmCleanupEnabled = useSettingsStore(
		(s) => s.settings.llm?.dictation?.enabled ?? false,
	);
	const encoderEnabled = useSettingsStore(
		(s) => s.settings.general?.encoderDictionaryEnabled ?? true,
	);
	const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
	const model = useEncoderModel();
	const handleEncoderToggle = useCallback(
		(next: boolean) => {
			// Enable/disable only — the downloaded model stays on disk so re-enabling is instant.
			// Deleting it (to reclaim ~310 MB) is an explicit action via the card's trash button.
			updateGeneral({ encoderDictionaryEnabled: next });
			// Preload + warm immediately on enable so the first dictation is fast; drop it from
			// memory on disable to free the session it was holding. Both no-op if not downloaded.
			if (next) {
				model.preload();
			} else {
				model.unload();
			}
		},
		[updateGeneral, model],
	);
	// The non-LLM path can act only when the feature is on AND the model is present.
	const encoderActive = encoderEnabled && model.state === "present";
	const disabled =
		!llmCleanupEnabled && !encoderActive && model.state !== "loading";
	return (
		<>
			{llmCleanupEnabled ? null : (
				<EncoderModelCard
					enabled={encoderEnabled}
					model={model}
					onToggle={handleEncoderToggle}
				/>
			)}
			<div
				className={cn(
					!llmCleanupEnabled && "pt-5",
					disabled && "pointer-events-none select-none opacity-50",
				)}
				{...(disabled ? { inert: true } : {})}
			>
				<DictionarySettingsPanel />
				<SnippetsSettingsPanel />
			</div>
		</>
	);
}

function SettingsPanelContent({ tab }: { tab: string }): ReactNode {
	switch (tab) {
		case "recording":
			return <RecordingSettingsPanel />;
		case "model":
			return <ModelSettingsPanel />;
		case "processing":
			return (
				<>
					<LlmSettingsPanel />
					<ProcessingExtrasPanel />
				</>
			);
		case "vocabulary":
			return <VocabularyTab />;
		case "output":
			return (
				<>
					<OutputSettingsPanel />
					<PlaybackSettingsPanel />
				</>
			);
		case "readAloud":
			return <TtsModelSection />;
		case "shortcuts":
			return <ShortcutsSettingsPanel />;
		case "appearance":
			return <AppearanceSettingsPanel />;
		case "history":
			return <TranscriptionHistoryPanel />;
		case "integrations":
			return <IntegrationsSettingsPanel />;
		case "about":
			return <AboutSettingsPanel />;
		default:
			return <RecordingSettingsPanel />;
	}
}

/**
 * Host for the LLM Ollama model-picker modal. The dialog is a widget, so it
 * can't be rendered from the LLM settings *widget* (FSD widget→widget ban) —
 * the LLM panel only drives `useLlmModelPickerStore`, and this view-level host
 * renders the actual modal. On install it commits the model (and `enabled` when
 * the open was a toggle-driven turn-on), so the feature is never enabled
 * without a model.
 */
function LlmModelPickerHost() {
	const open = useLlmModelPickerStore((s) => s.open);
	const feature = useLlmModelPickerStore((s) => s.feature);
	const close = useLlmModelPickerStore((s) => s.close);
	const commitInstalled = useLlmModelPickerStore((s) => s.commitInstalled);
	const currentModel = useSettingsStore((s) =>
		feature === "transforms"
			? s.settings.llm.transforms.model
			: s.settings.llm.dictation.model,
	);
	return (
		<OllamaModelManagerDialog
			currentModel={currentModel}
			isOpen={open}
			onClose={close}
			onModelInstalled={commitInstalled}
		/>
	);
}

function SettingsReadySignal() {
	useEffect(() => {
		settingsWindowReady();
	}, []);
	return null;
}

function SettingsHydrationPanel({
	error,
	status,
}: {
	error: string | null;
	status: SettingsHydrationStatus;
}) {
	const common = useTranslations("common");
	const settings = useTranslations("settings");
	const message =
		status === "error" ? (error ?? common("loading")) : common("loading");

	return (
		<div
			aria-live="polite"
			className="flex min-h-[320px] flex-col items-center justify-center gap-2 px-6 text-center text-foreground-secondary"
			role={status === "error" ? "alert" : "status"}
		>
			<HugeiconsIcon icon={InformationCircleIcon} size={22} />
			<div className="font-medium text-foreground">{settings("title")}</div>
			<div className="max-w-md text-sm leading-6">{message}</div>
		</div>
	);
}

export function SettingsPage() {
	const isLoaded = useSettingsStore((s) => s.isLoaded);
	const hydrationStatus = useSettingsHydrationStore((s) => s.status);
	const hydrationError = useSettingsHydrationStore((s) => s.error);
	const canRenderSettings =
		isLoaded &&
		(hydrationStatus === "ready" || hydrationStatus === "unavailable");
	const shouldSignalReady = canRenderSettings || hydrationStatus === "error";
	// Auto-revert any cloud surface (STT model / LLM provider / cloud TTS) to a
	// local engine when its API key is removed. Mounted HERE (not the main
	// window) because keys are edited in this window and the OpenRouter key
	// shares the `llm` section with the LLM provider/enabled flags — a revert
	// from another window loses the cross-window user-dirty merge.
	useCloudKeyAutoRevert(undefined, hydrationStatus === "ready");
	const openLlmModelPicker = useLlmModelPickerStore((s) => s.openFor);
	const openDictationCleanupPicker = useCallback(() => {
		openLlmModelPicker("dictation", true);
	}, [openLlmModelPicker]);
	useModelAssistanceAutoEnable({
		enabled: canRenderSettings,
		onOpenOllamaPicker: openDictationCleanupPicker,
	});
	const t = useTranslations("settings");
	// Per-tab search keywords (section headings + setting names) so the sidebar
	// search surfaces a tab by its contents, not just its label/tooltip.
	const keywords = useSettingsSearchKeywords();
	// Controlled tab state so siblings (e.g. the Cloud-disabled badge in
	// ModelSettingsPanel) can navigate the sidebar by calling setActiveTab.
	const activeTab = useSettingsTabStore((s) => s.activeTab);
	const setActiveTab = useSettingsTabStore((s) => s.setActiveTab);
	const closeActivation = useTouchActivation(windowCloseSelf);
	useEscapeToClose(windowCloseSelf);

	const links: SidebarLink[] = [
		{
			key: "recording",
			label: t("tabRecording"),
			icon: Mic01Icon,
			tooltip: t("tabRecordingTooltip"),
			keywords: keywords.recording,
		},
		{
			key: "model",
			label: t("tabTranscription"),
			icon: AiChat02Icon,
			tooltip: t("tabTranscriptionTooltip"),
			keywords: keywords.model,
		},
		{
			key: "processing",
			label: t("tabProcessing"),
			icon: AiEditingIcon,
			tooltip: t("tabProcessingTooltip"),
			keywords: keywords.processing,
		},
		{
			key: "vocabulary",
			label: t("tabVocabulary"),
			icon: Books02Icon,
			tooltip: t("tabVocabularyTooltip"),
			keywords: keywords.vocabulary,
		},
		{
			key: "output",
			label: t("tabDelivery"),
			icon: PackageSentIcon,
			tooltip: t("tabDeliveryTooltip"),
			keywords: keywords.output,
		},
		{
			key: "readAloud",
			label: t("tabReadAloud"),
			icon: AiVoiceGeneratorIcon,
			tooltip: t("tabReadAloudTooltip"),
			keywords: keywords.readAloud,
			groupEnd: true,
		},
		{
			key: "shortcuts",
			label: t("tabShortcuts"),
			icon: KeyboardIcon,
			tooltip: t("tabShortcutsTooltip"),
			keywords: keywords.shortcuts,
		},
		{
			key: "appearance",
			label: t("tabAppearance"),
			icon: PaintBrush03Icon,
			tooltip: t("tabAppearanceTooltip"),
			keywords: keywords.appearance,
			groupEnd: true,
		},
		{
			key: "history",
			label: t("tabHistory"),
			icon: ChartHistogramIcon,
			tooltip: t("tabHistoryTooltip"),
			keywords: keywords.history,
			groupEnd: true,
		},
		{
			key: "integrations",
			label: t("tabIntegrations"),
			icon: PlugSocketIcon,
			tooltip: t("tabIntegrationsTooltip"),
			keywords: keywords.integrations,
		},
		{
			key: "about",
			label: t("tabAbout"),
			icon: InformationCircleIcon,
			tooltip: t("tabAboutTooltip"),
			keywords: keywords.about,
		},
	];

	return (
		<SurfaceProvider value={1}>
			<div className="noise-overlay settings-window-shell flex h-dvh min-h-dvh bg-surface-1">
				{/* Keep the settings shell visible while backend settings hydrate. */}
				<Tabs.Root
					className="flex flex-1 overflow-hidden"
					onValueChange={(v) => setActiveTab(String(v))}
					orientation="vertical"
					value={activeTab}
				>
					<SettingsSidebar links={links} />
					{/* Content card — rounded, bordered, and elevated above the shared
						    settings background. */}
					<div className="settings-content-frame relative min-w-0 flex-1 py-2 pe-2">
						{/* Drag strip — the thin surface-1 margin above the content card. The
							    window is frameless, so this gives the right (content) side a grab
							    handle that lines up with the sidebar's own top drag strip, making
							    the whole top edge draggable. */}
						<div
							aria-hidden="true"
							className="titlebar-drag absolute inset-x-0 top-0 z-titlebar h-1.5"
						/>
						<Elevated
							className="settings-content-card relative flex h-full flex-col overflow-hidden rounded-[1.35rem] ring-1 ring-divider-strong"
							offset={2}
							shadowLevel={5}
						>
							{/* Close button — floats in the top-right corner so it's the only
								    chrome painted over the tab content. There's no full-width header
								    BAND reserving an empty strip above the content anymore: the
								    scroll area fills the card to the top and gets a normal symmetric
								    inset (matching the px/pb below). The button rides its own plain
								    client pixels — never inside a `drag` region — so it stays
								    clickable incl. touch (Tauri #4746). Window-move is handled by the
								    sidebar wordmark grab handle and the thin surface-1 drag strip
								    above the card; no title text — the active tab's name lives in the
								    sidebar rail. Every tab's first section leads with a left-aligned
								    title, so the corner button never sits over a section's controls. */}
							<BaseButton
								aria-label={t("close")}
								className="titlebar-no-drag group absolute end-1.5 top-1.5 z-titlebar flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-4 text-foreground-muted outline-none transition-colors duration-150 hover:bg-error/85 hover:text-white focus-visible:ring-2 focus-visible:ring-accent"
								type="button"
								{...closeActivation}
							>
								<HugeiconsIcon
									className="transition-transform duration-150 ease-out group-hover:scale-110"
									icon={Cancel01Icon}
									size={15}
								/>
							</BaseButton>
							<ScrollArea
								className="min-h-0 flex-1"
								rubberBandOnTouch
								verticalOnly
								verticalScrollbarClassName="mb-3 me-1"
								viewportClassName="px-6 pt-6 pb-6"
							>
								<Tabs.Panel value={activeTab}>
									{canRenderSettings ? (
										<SettingsPanelContent tab={activeTab} />
									) : (
										<SettingsHydrationPanel
											error={hydrationError}
											status={hydrationStatus}
										/>
									)}
								</Tabs.Panel>
							</ScrollArea>
						</Elevated>
					</div>
				</Tabs.Root>
				{shouldSignalReady ? <SettingsReadySignal /> : null}
				{canRenderSettings ? <LlmModelPickerHost /> : null}
				{canRenderSettings ? <TtsModelPickerHost /> : null}
			</div>
		</SurfaceProvider>
	);
}
