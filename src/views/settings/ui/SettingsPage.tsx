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
import {
	lazy,
	Suspense,
	useDeferredValue,
	useEffect,
	type ReactNode,
} from "react";
import { useTranslations } from "use-intl";
import {
	subscribePendingSettingsSection,
	takePendingSettingsSection,
	useSettingsStore,
	useSettingsTabStore,
} from "@/entities/setting";
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
import { useEncoderModel } from "@/widgets/dictionary-settings";
import { useSettingsSearchKeywords } from "../lib/settings-search";
import { SettingsSidebar, type SidebarLink } from "./SettingsSidebar";

// Import thunks for every lazily-loaded panel module. Declared once so the
// prefetcher can warm the EXACT same dynamic-import chunks that the lazy()
// factories below await. A dynamic import is memoized by module specifier, so
// prefetching a module (on idle, or on tab hover) means the chunk is already in
// the module cache when the tab is clicked — the panel renders immediately
// instead of waiting on a fetch + parse round-trip. The window still opens fast
// because nothing here is imported at module-eval time; prefetch only runs after
// the window is ready (idle) or when the user signals intent (hover/focus).
const loadRecording = () => import("@/widgets/recording-settings");
const loadModel = () => import("@/widgets/model-settings");
const loadShortcuts = () => import("@/widgets/shortcuts-settings");
const loadAppearance = () => import("@/widgets/appearance-settings");
const loadHistory = () => import("@/widgets/transcription-history-settings");
const loadIntegrations = () => import("@/widgets/integrations-settings");
const loadAbout = () => import("@/widgets/about-settings");
const loadTts = () => import("@/widgets/tts-settings");
const loadOllamaManager = () => import("@/widgets/ollama-model-manager");
const loadDictionary = () => import("@/widgets/dictionary-settings");
const loadSnippets = () => import("@/widgets/snippets-settings");
const loadLlm = () => import("@/widgets/llm-settings");
const loadProcessingExtras = () => import("@/widgets/processing-extras");
const loadOutput = () => import("@/widgets/output-settings");

// Per-tab module loaders. Hovering/focusing a sidebar tab warms its chunk(s),
// and the idle prefetch walks every entry so any tab is instant once warm.
const TAB_LOADERS: Record<string, Array<() => Promise<unknown>>> = {
	recording: [loadRecording],
	model: [loadModel],
	processing: [loadLlm, loadProcessingExtras],
	vocabulary: [loadDictionary, loadSnippets],
	output: [loadOutput],
	readAloud: [loadTts],
	shortcuts: [loadShortcuts],
	appearance: [loadAppearance],
	history: [loadHistory],
	integrations: [loadIntegrations],
	about: [loadAbout],
};

function prefetchSettingsTab(tab: string): void {
	for (const load of TAB_LOADERS[tab] ?? []) {
		void load();
	}
}

// Warm every panel chunk (plus the modal hosts that aren't tied to a tab) once
// the window is idle, so the first click on ANY tab is instant.
function prefetchAllSettingsPanels(): void {
	for (const tab of Object.keys(TAB_LOADERS)) {
		prefetchSettingsTab(tab);
	}
	void loadOllamaManager();
}

const RecordingSettingsPanel = lazy(async () => ({
	default: (await loadRecording()).RecordingSettingsPanel,
}));
const ModelSettingsPanel = lazy(async () => ({
	default: (await loadModel()).ModelSettingsPanel,
}));
const ShortcutsSettingsPanel = lazy(async () => ({
	default: (await loadShortcuts()).ShortcutsSettingsPanel,
}));
const AppearanceSettingsPanel = lazy(async () => ({
	default: (await loadAppearance()).AppearanceSettingsPanel,
}));
const TranscriptionHistoryPanel = lazy(async () => ({
	default: (await loadHistory()).TranscriptionHistoryPanel,
}));
const IntegrationsSettingsPanel = lazy(async () => ({
	default: (await loadIntegrations()).IntegrationsSettingsPanel,
}));
const AboutSettingsPanel = lazy(async () => ({
	default: (await loadAbout()).AboutSettingsPanel,
}));
const TtsModelSection = lazy(async () => ({
	default: (await loadTts()).TtsModelSection,
}));
const TtsModelPickerHost = lazy(async () => ({
	default: (await loadTts()).TtsModelPickerHost,
}));
const OllamaModelManagerDialog = lazy(async () => ({
	default: (await loadOllamaManager()).OllamaModelManagerDialog,
}));
const DictionarySettingsPanel = lazy(async () => ({
	default: (await loadDictionary()).DictionarySettingsPanel,
}));
const EncoderModelCard = lazy(async () => ({
	default: (await loadDictionary()).EncoderModelCard,
}));
const SnippetsSettingsPanel = lazy(async () => ({
	default: (await loadSnippets()).SnippetsSettingsPanel,
}));

const ProcessingTab = lazy(async () => {
	const [{ LlmSettingsPanel }, { ProcessingExtrasPanel }] = await Promise.all([
		loadLlm(),
		loadProcessingExtras(),
	]);
	return {
		default: function ProcessingTab() {
			return (
				<>
					<LlmSettingsPanel />
					<ProcessingExtrasPanel />
				</>
			);
		},
	};
});

const OutputTab = lazy(async () => {
	const { OutputSettingsPanel, PlaybackSettingsPanel } = await loadOutput();
	return {
		default: function OutputTab() {
			return (
				<>
					<OutputSettingsPanel />
					<PlaybackSettingsPanel />
				</>
			);
		},
	};
});

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
	const handleEncoderToggle = (next: boolean) => {
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
	};
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
			return <ProcessingTab />;
		case "vocabulary":
			return <VocabularyTab />;
		case "output":
			return <OutputTab />;
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
	if (!open) {
		return null;
	}
	return (
		<Suspense fallback={null}>
			<OllamaModelManagerDialog
				currentModel={currentModel}
				isOpen={open}
				onClose={close}
				onModelInstalled={commitInstalled}
			/>
		</Suspense>
	);
}

function SettingsReadySignal() {
	useEffect(() => {
		settingsWindowReady();
	}, []);
	return null;
}

function SettingsPanelFallback() {
	return (
		<div
			aria-hidden="true"
			className="min-h-[320px]"
			data-slot="settings-panel-fallback"
		/>
	);
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
	const openDictationCleanupPicker = () => {
		openLlmModelPicker("dictation", true);
	};
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
	// Drive the panel content from a deferred copy of the active tab. When a tab
	// is clicked, the deferred value lags by a render, so React keeps the current
	// panel on screen while the next one's (prefetched, microtask-fast) chunk
	// resolves — no blank fallback flash on the swap.
	const contentTab = useDeferredValue(activeTab);
	const closeActivation = useTouchActivation(windowCloseSelf);
	useEscapeToClose(windowCloseSelf);

	// Once the window can render, warm every panel chunk in the background so the
	// first click on any tab is instant. Deferred to idle so it never competes
	// with the initial paint of the default tab.
	useEffect(() => {
		if (!canRenderSettings) {
			return;
		}
		const ric = window.requestIdleCallback;
		if (typeof ric === "function") {
			const handle = ric(() => prefetchAllSettingsPanels(), { timeout: 2000 });
			return () => window.cancelIdleCallback?.(handle);
		}
		const handle = window.setTimeout(prefetchAllSettingsPanels, 200);
		return () => window.clearTimeout(handle);
	}, [canRenderSettings]);

	// Honor a cross-window deep-link request (e.g. an onboarding "configure this"
	// link). A freshly-opened window picks up the pending section on mount; an
	// already-open window navigates live via the `storage` event.
	useEffect(() => {
		const pending = takePendingSettingsSection();
		if (pending) {
			setActiveTab(pending);
		}
		return subscribePendingSettingsSection(setActiveTab);
	}, [setActiveTab]);

	const links: SidebarLink[] = [
		{
			key: "recording",
			label: t("tabRecording"),
			icon: Mic01Icon,
			tooltip: t("tabRecordingTooltip"),
			keywords: keywords["recording"],
		},
		{
			key: "model",
			label: t("tabTranscription"),
			icon: AiChat02Icon,
			tooltip: t("tabTranscriptionTooltip"),
			keywords: keywords["model"],
		},
		{
			key: "processing",
			label: t("tabProcessing"),
			icon: AiEditingIcon,
			tooltip: t("tabProcessingTooltip"),
			keywords: keywords["processing"],
		},
		{
			key: "vocabulary",
			label: t("tabVocabulary"),
			icon: Books02Icon,
			tooltip: t("tabVocabularyTooltip"),
			keywords: keywords["vocabulary"],
		},
		{
			key: "output",
			label: t("tabDelivery"),
			icon: PackageSentIcon,
			tooltip: t("tabDeliveryTooltip"),
			keywords: keywords["output"],
		},
		{
			key: "readAloud",
			label: t("tabReadAloud"),
			icon: AiVoiceGeneratorIcon,
			tooltip: t("tabReadAloudTooltip"),
			keywords: keywords["readAloud"],
			groupEnd: true,
		},
		{
			key: "shortcuts",
			label: t("tabShortcuts"),
			icon: KeyboardIcon,
			tooltip: t("tabShortcutsTooltip"),
			keywords: keywords["shortcuts"],
		},
		{
			key: "appearance",
			label: t("tabAppearance"),
			icon: PaintBrush03Icon,
			tooltip: t("tabAppearanceTooltip"),
			keywords: keywords["appearance"],
			groupEnd: true,
		},
		{
			key: "history",
			label: t("tabHistory"),
			icon: ChartHistogramIcon,
			tooltip: t("tabHistoryTooltip"),
			keywords: keywords["history"],
			groupEnd: true,
		},
		{
			key: "integrations",
			label: t("tabIntegrations"),
			icon: PlugSocketIcon,
			tooltip: t("tabIntegrationsTooltip"),
			keywords: keywords["integrations"],
		},
		{
			key: "about",
			label: t("tabAbout"),
			icon: InformationCircleIcon,
			tooltip: t("tabAboutTooltip"),
			keywords: keywords["about"],
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
					<SettingsSidebar links={links} onPrefetch={prefetchSettingsTab} />
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
								className="titlebar-no-drag group absolute end-1.5 top-1.5 z-titlebar flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-4 text-foreground-muted outline-none transition-colors duration-150 hover:bg-error/85 hover:text-on-error focus-visible:ring-2 focus-visible:ring-accent"
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
								{/* The panel is focusable (tabIndex 0) for a11y; its content is
									    individually focusable, so suppress the UA focus ring that would
									    otherwise draw a bright rectangle around the whole tab. */}
								<Tabs.Panel className="outline-none" value={activeTab}>
									{canRenderSettings ? (
										<Suspense fallback={<SettingsPanelFallback />}>
											<SettingsPanelContent tab={contentTab} />
										</Suspense>
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
				{canRenderSettings ? (
					<Suspense fallback={null}>
						<TtsModelPickerHost />
					</Suspense>
				) : null}
			</div>
		</SurfaceProvider>
	);
}
