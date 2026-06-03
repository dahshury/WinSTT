import { Tabs } from "@base-ui/react/tabs";
import {
	AiChat02Icon,
	AiEditingIcon,
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
import { AnimatePresence, domAnimation, LazyMotion, m, useReducedMotion, type Variants } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { useSettingsStore, useSettingsTabStore } from "@/entities/setting";
import { useLlmModelPickerStore } from "@/features/llm-model-picker";
import { useDownloadListener } from "@/features/model-download";
import { useCloudKeyAutoRevert } from "@/features/revert-cloud-on-key-removal";
import { useSyncActiveModel } from "@/features/sync-active-model";
import { useSyncSettings } from "@/features/update-settings";
import { windowCloseSelf } from "@/shared/api/ipc-client";
import { Elevated, SurfaceProvider } from "@/shared/lib/surface";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { AboutSettingsPanel } from "@/widgets/about-settings";
import { AppearanceSettingsPanel } from "@/widgets/appearance-settings";
import { DictionarySettingsPanel } from "@/widgets/dictionary-settings";
import { IntegrationsSettingsPanel } from "@/widgets/integrations-settings";
import { LlmSettingsPanel } from "@/widgets/llm-settings";
import { ModelSettingsPanel } from "@/widgets/model-settings";
import { OllamaModelManagerDialog } from "@/widgets/ollama-model-manager";
import { OutputSettingsPanel } from "@/widgets/output-settings";
import { ProcessingExtrasPanel } from "@/widgets/processing-extras";
import { RecordingSettingsPanel } from "@/widgets/recording-settings";
import { ShortcutsSettingsPanel } from "@/widgets/shortcuts-settings";
import { SnippetsSettingsPanel } from "@/widgets/snippets-settings";
import { TranscriptionHistoryPanel } from "@/widgets/transcription-history-settings";
import { TtsModelPickerHost, TtsModelSection } from "@/widgets/tts-settings";
import { useSettingsSearchKeywords } from "../lib/settings-search";
import { SettingsSidebar, type SidebarLink } from "./SettingsSidebar";

const SETTINGS_TAB_ORDER = [
	"recording",
	"model",
	"processing",
	"vocabulary",
	"output",
	"shortcuts",
	"appearance",
	"history",
	"integrations",
	"about",
] as const;

interface SettingsPanelMotion {
	direction?: number;
	reduceMotion?: boolean;
}

const SETTINGS_PANEL_VARIANTS = {
	initial: ({ direction = 1, reduceMotion = false }: SettingsPanelMotion = {}) => ({
		opacity: reduceMotion ? 1 : 0,
		x: reduceMotion ? 0 : direction > 0 ? 8 : -8,
		filter: reduceMotion ? "blur(0px)" : "blur(3px)",
	}),
	animate: {
		opacity: 1,
		x: 0,
		filter: "blur(0px)",
	},
	exit: ({ direction = 1, reduceMotion = false }: SettingsPanelMotion = {}) => ({
		opacity: reduceMotion ? 1 : 0,
		x: reduceMotion ? 0 : direction > 0 ? -8 : 8,
		filter: reduceMotion ? "blur(0px)" : "blur(3px)",
		transition: { duration: reduceMotion ? 0 : 0.16 },
	}),
} satisfies Variants;

function settingsTabIndex(tab: string): number {
	const index = SETTINGS_TAB_ORDER.findIndex((key) => key === tab);
	return index === -1 ? 0 : index;
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
			return (
				<>
					<DictionarySettingsPanel />
					<SnippetsSettingsPanel />
				</>
			);
		case "output":
			return (
				<>
					<OutputSettingsPanel />
					<TtsModelSection />
				</>
			);
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

function useSettingsTabDirection(activeTab: string): number {
	const [motionState, setMotionState] = useState({ direction: 1, tab: activeTab });
	useEffect(() => {
		setMotionState((prev) => {
			if (prev.tab === activeTab) {
				return prev;
			}
			const direction = settingsTabIndex(activeTab) >= settingsTabIndex(prev.tab) ? 1 : -1;
			return { direction, tab: activeTab };
		});
	}, [activeTab]);
	return motionState.tab === activeTab ? motionState.direction : 1;
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
		feature === "transforms" ? s.settings.llm.transforms.model : s.settings.llm.dictation.model
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

export function SettingsPage() {
	const isLoaded = useSettingsStore((s) => s.isLoaded);
	useSyncSettings();
	// Mount the model-download IPC listener here so the dictation model
	// download modal can subscribe to live progress / completion events in
	// the settings window (main window mounts this via IpcProvider).
	useDownloadListener();
	// Mirror the server's actually-loaded model into the settings store,
	// so the picker reflects reality when the server has fallen back from
	// an unloadable user choice. Idempotent when the two already agree.
	useSyncActiveModel();
	// Auto-revert any cloud surface (STT model / LLM provider / cloud TTS) to a
	// local engine when its API key is removed. Mounted HERE (not the main
	// window) because keys are edited in this window and the OpenRouter key
	// shares the `llm` section with the LLM provider/enabled flags — a revert
	// from another window loses the cross-window user-dirty merge.
	useCloudKeyAutoRevert();
	const t = useTranslations("settings");
	// Per-tab search keywords (section headings + setting names) so the sidebar
	// search surfaces a tab by its contents, not just its label/tooltip.
	const keywords = useSettingsSearchKeywords();
	// Controlled tab state so siblings (e.g. the Cloud-disabled badge in
	// ModelSettingsPanel) can navigate the sidebar by calling setActiveTab.
	const activeTab = useSettingsTabStore((s) => s.activeTab);
	const setActiveTab = useSettingsTabStore((s) => s.setActiveTab);
	const tabDirection = useSettingsTabDirection(activeTab);
	const reduceMotion = useReducedMotion();
	const settingsPanelMotion = { direction: tabDirection, reduceMotion };

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
			label: t("tabModel"),
			icon: AiChat02Icon,
			tooltip: t("tabModelTooltip"),
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
			label: t("tabOutput"),
			icon: PackageSentIcon,
			tooltip: t("tabOutputTooltip"),
			keywords: keywords.output,
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
			<div className="noise-overlay flex h-dvh min-h-dvh bg-surface-1">
				{/* Content — hidden until persisted store settings are loaded to prevent default→saved flash */}
				{isLoaded ? (
					<Tabs.Root
						className="flex flex-1 overflow-hidden"
						onValueChange={(v) => setActiveTab(String(v))}
						orientation="vertical"
						value={activeTab}
					>
						<SettingsSidebar links={links} />
						{/* Content card — a rounded, shadowed panel inset with a small margin
						    so the surface-1 substrate shows around it. The sidebar reads as
						    built into the window while each tab's content floats a layer above.
						    Lifts to surface-3 (a clear ~8% step above the surface-1 sidebar) so
						    the colour difference is obvious; nested SettingSection controls lift
						    from there as usual. */}
						<div className="relative min-w-0 flex-1 py-2.5 ps-2 pe-2.5">
							{/* Drag strip — the thin surface-1 margin above the content card. The
							    window is frameless, so this gives the right (content) side a grab
							    handle that lines up with the sidebar's own top drag strip, making
							    the whole top edge draggable. */}
							<div
								aria-hidden="true"
								className="titlebar-drag absolute inset-x-0 top-0 z-titlebar h-2.5"
							/>
							<Elevated
								className="relative flex h-full flex-col overflow-hidden rounded-xl ring-1 ring-divider-strong"
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
								<button
									aria-label={t("close")}
									className="titlebar-no-drag group absolute end-1.5 top-1.5 z-titlebar flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-4 text-foreground-muted outline-none transition-colors duration-150 hover:bg-error/85 hover:text-white focus-visible:ring-2 focus-visible:ring-accent"
									onClick={windowCloseSelf}
									type="button"
								>
									<HugeiconsIcon
										className="transition-transform duration-150 ease-out group-hover:scale-110"
										icon={Cancel01Icon}
										size={15}
									/>
								</button>
								<ScrollArea
									className="min-h-0 flex-1"
									rubberBandOnTouch
									verticalOnly
									verticalScrollbarClassName="mb-3 me-1"
									viewportClassName="px-6 pt-6 pb-6"
								>
									<LazyMotion features={domAnimation} strict>
										<AnimatePresence custom={settingsPanelMotion} initial={false} mode="wait">
											<m.div
												animate="animate"
												custom={settingsPanelMotion}
												data-settings-panel-motion="true"
												exit="exit"
												initial="initial"
												key={activeTab}
												transition={
													reduceMotion
														? { duration: 0 }
														: { duration: 0.2, ease: [0.22, 1, 0.36, 1] }
												}
												variants={SETTINGS_PANEL_VARIANTS}
											>
												<Tabs.Panel value={activeTab}>
													<SettingsPanelContent tab={activeTab} />
												</Tabs.Panel>
											</m.div>
										</AnimatePresence>
									</LazyMotion>
								</ScrollArea>
							</Elevated>
						</div>
					</Tabs.Root>
				) : (
					<div className="flex-1 bg-surface-1" />
				)}
				<LlmModelPickerHost />
				<TtsModelPickerHost />
			</div>
		</SurfaceProvider>
	);
}
