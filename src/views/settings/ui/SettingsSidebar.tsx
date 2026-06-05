import { Button as BaseButton } from "@base-ui/react/button";
import { Tabs } from "@base-ui/react/tabs";
import {
	GpuIcon,
	PanelLeftCloseIcon,
	PanelLeftOpenIcon,
	RamMemoryIcon,
	Search01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	AnimatePresence,
	domAnimation,
	LazyMotion,
	m,
	useIsPresent,
	useReducedMotion,
} from "motion/react";
import { resolveEffectiveQuant } from "@picker";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { providerOf } from "@/entities/cloud-stt-provider";
import { useModelStateStore } from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";
import { useSystemResourcesStore } from "@/entities/system-resources";
import type {
	LiveResourcesEntry,
	ModelStateEntry,
} from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { formatBytes } from "@/shared/lib/format-bytes";
import { isRealtimeEnabled } from "@/shared/lib/realtime-enabled";
import { ClearableTextField } from "@/shared/ui/text-field";
import { Tooltip } from "@/shared/ui/tooltip";
import { matchesSearchQuery } from "../lib/settings-search";

/**
 * Hairline divider closing a logical tab group. Mirrors the rail's own edge
 * treatment: a `divider-strong` line lifted by a faint top-light highlight so
 * it reads as etched rather than a flat gray stroke.
 */
function RailSeparator() {
	return (
		<div
			aria-hidden="true"
			className="my-1.5 h-px w-full bg-[var(--color-divider-strong)] shadow-[0_1px_0_0_oklch(100%_0_0_/_0.05)]"
		/>
	);
}

export interface SidebarLink {
	/** Render a separator after this row to close a logical tab group */
	groupEnd?: boolean;
	icon: IconSvgElement;
	key: string;
	/**
	 * Section headings + key setting names this tab contains, fed into search so
	 * a query surfaces the tab by its contents (e.g. "display" → General). See
	 * `useSettingsSearchKeywords`.
	 */
	keywords?: string | undefined;
	label: string;
	/** Tooltip explaining what the tab configures — also fed into search */
	tooltip?: string;
}

interface SettingsSidebarProps {
	links: SidebarLink[];
}

const SIDEBAR_WIDTH = 170;
const COLLAPSED_WIDTH = 56;
const TAB_HEIGHT = 38;
const COLLAPSE_STORAGE_KEY = "winstt:settings-sidebar-collapsed";
const RESOURCE_POLL_MS = 3000;
const WARNING_PERCENT = 80;
const CRITICAL_PERCENT = 92;

type ResourceTone = "ok" | "warning" | "critical" | "muted";
type ResourceMeterKey = "ram" | "vram";
type DeviceValue = "auto" | "cpu";
type StatesById = Record<string, ModelStateEntry>;

interface MeterData {
	icon: IconSvgElement;
	key: ResourceMeterKey;
	label: string;
	totalBytes: number;
	unavailableLabel?: string;
	usedBytes: number;
}

interface RelevantResourceArgs {
	currentQuantization: string;
	deviceValue: DeviceValue;
	elevenlabs: ReturnType<
		typeof useSettingsStore.getState
	>["settings"]["integrations"]["elevenlabs"];
	mainModelId: string | undefined;
	realtimeEnabled: boolean;
	realtimeModelId: string | undefined;
	snapshot: LiveResourcesEntry | null;
	statesById: StatesById;
	tts: ReturnType<typeof useSettingsStore.getState>["settings"]["tts"];
}

const RESOURCE_TONE_CLASS: Record<
	ResourceTone,
	{ bar: string; icon: string; track: string }
> = {
	ok: {
		bar: "bg-gradient-to-r from-foreground/[0.32] to-foreground/[0.52]",
		icon: "text-foreground-dim",
		track: "bg-foreground/[0.08]",
	},
	warning: {
		bar: "bg-gradient-to-r from-foreground/[0.48] to-foreground/[0.72]",
		icon: "text-foreground-muted",
		track: "bg-foreground/[0.10]",
	},
	critical: {
		bar: "bg-gradient-to-r from-foreground/[0.68] to-foreground",
		icon: "text-foreground-secondary",
		track: "bg-foreground/[0.12]",
	},
	muted: {
		bar: "bg-foreground/[0.20]",
		icon: "text-foreground-dim",
		track: "bg-foreground/[0.06]",
	},
};

const GPU_COMPATIBLE_RESOURCE_QUANTIZATIONS: ReadonlySet<string> = new Set([
	"",
	"auto",
	"fp32",
	"fp16",
]);

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.max(0, Math.min(100, value));
}

function resourcePercent(usedBytes: number, totalBytes: number): number {
	return totalBytes > 0 ? clampPercent((usedBytes / totalBytes) * 100) : 0;
}

function toneFor(percent: number, totalBytes: number): ResourceTone {
	if (totalBytes <= 0) {
		return "muted";
	}
	if (percent >= CRITICAL_PERCENT) {
		return "critical";
	}
	if (percent >= WARNING_PERCENT) {
		return "warning";
	}
	return "ok";
}

function formatResourceBytes(bytes: number): string {
	return formatBytes(bytes, { gbDecimals: 1, mbDecimals: 0 }) ?? "0 MB";
}

function pickDisplayGpu(
	snapshot: LiveResourcesEntry | null,
): LiveResourcesEntry["gpus"][number] | null {
	const first = snapshot?.gpus[0];
	if (!first) {
		return null;
	}
	return snapshot.gpus.reduce(
		(best, gpu) => (gpu.total_vram_bytes > best.total_vram_bytes ? gpu : best),
		first,
	);
}

function hasAnyGpu(snapshot: LiveResourcesEntry | null): boolean {
	return (snapshot?.gpus.length ?? 0) > 0;
}

function localModelIdOrNull(
	modelId: string | undefined,
	enabled = true,
): string | null {
	if (!enabled || !modelId || providerOf(modelId) !== null) {
		return null;
	}
	return modelId;
}

function localTtsIsActive(
	tts: RelevantResourceArgs["tts"],
	elevenlabs: RelevantResourceArgs["elevenlabs"],
): boolean {
	const cloudEffective =
		(tts.source ?? "local") === "cloud" &&
		elevenlabs.apiKey.trim().length > 0 &&
		elevenlabs.verified === true;
	return tts.enabled && !cloudEffective;
}

function resourceKeyForLocalModel(
	modelId: string,
	statesById: StatesById,
	currentQuantization: string,
	deviceValue: DeviceValue,
	snapshot: LiveResourcesEntry | null,
): ResourceMeterKey {
	if (deviceValue === "cpu") {
		return "ram";
	}
	const quantization = resolveEffectiveQuant(
		statesById[modelId],
		currentQuantization,
	);
	return hasAnyGpu(snapshot) &&
		GPU_COMPATIBLE_RESOURCE_QUANTIZATIONS.has(quantization)
		? "vram"
		: "ram";
}

function resourceKeyForSharedDevice(
	deviceValue: DeviceValue,
	snapshot: LiveResourcesEntry | null,
): ResourceMeterKey {
	return deviceValue === "cpu" || !hasAnyGpu(snapshot) ? "ram" : "vram";
}

function getRelevantResourceKeys({
	currentQuantization,
	deviceValue,
	elevenlabs,
	mainModelId,
	realtimeEnabled,
	realtimeModelId,
	snapshot,
	statesById,
	tts,
}: RelevantResourceArgs): ResourceMeterKey[] {
	const keys = new Set<ResourceMeterKey>();
	const addLocalStt = (modelId: string | undefined, enabled = true) => {
		const localModelId = localModelIdOrNull(modelId, enabled);
		if (localModelId === null) {
			return;
		}
		keys.add(
			resourceKeyForLocalModel(
				localModelId,
				statesById,
				currentQuantization,
				deviceValue,
				snapshot,
			),
		);
	};

	addLocalStt(mainModelId);
	addLocalStt(realtimeModelId, realtimeEnabled);
	if (localTtsIsActive(tts, elevenlabs)) {
		keys.add(resourceKeyForSharedDevice(deviceValue, snapshot));
	}
	return Array.from(keys);
}

function buildResourceMeters(
	snapshot: LiveResourcesEntry | null,
	visibleKeys: readonly ResourceMeterKey[],
): MeterData[] {
	const ramTotal = snapshot?.ram_total_bytes ?? 0;
	const ramAvailable = snapshot?.ram_available_bytes ?? 0;
	const gpu = pickDisplayGpu(snapshot);
	const gpuTotal = gpu?.total_vram_bytes ?? 0;
	const gpuFree = gpu?.free_vram_bytes ?? 0;
	const gpuUsed =
		gpu !== null
			? gpu.used_vram_bytes > 0
				? gpu.used_vram_bytes
				: Math.max(0, gpuTotal - gpuFree)
			: 0;
	const meters: MeterData[] = [
		{
			icon: RamMemoryIcon,
			key: "ram",
			label: "RAM",
			usedBytes: Math.max(0, ramTotal - ramAvailable),
			totalBytes: ramTotal,
		},
		{
			icon: GpuIcon,
			key: "vram",
			label: "VRAM",
			usedBytes: gpuUsed,
			totalBytes: gpuTotal,
			unavailableLabel: gpu === null ? "No GPU" : "VRAM unknown",
		},
	];
	return meters.filter((meter) => visibleKeys.includes(meter.key));
}

function resourceTooltip(data: MeterData, percent: number): string {
	if (data.totalBytes <= 0) {
		return data.unavailableLabel ?? `${data.label} unavailable`;
	}
	return `${data.label} ${Math.round(percent)}% - ${formatResourceBytes(data.usedBytes)} of ${formatResourceBytes(data.totalBytes)}`;
}

function ResourceMeter({
	collapsed,
	data,
}: {
	collapsed: boolean;
	data: MeterData;
}) {
	const percent = resourcePercent(data.usedBytes, data.totalBytes);
	const tone = toneFor(percent, data.totalBytes);
	const toneClass = RESOURCE_TONE_CLASS[tone];
	const width = `${percent}%`;
	const unavailable = data.totalBytes <= 0;
	const tooltip = resourceTooltip(data, percent);
	const meter = collapsed ? (
		<div
			aria-label={tooltip}
			className={cn(
				"relative flex h-[15px] min-w-0 items-center justify-center overflow-hidden outline-none transition-colors duration-150",
				unavailable ? "text-foreground-dim" : "text-foreground-secondary",
			)}
		>
			<span
				aria-hidden="true"
				className={cn("absolute inset-0", toneClass.track)}
			/>
			<span
				aria-hidden="true"
				className={cn(
					"absolute inset-y-0 start-0 opacity-30 transition-[width] duration-300",
					unavailable ? "bg-foreground/[0.08]" : toneClass.bar,
				)}
				style={{ width }}
			/>
			<HugeiconsIcon className="relative z-[1]" icon={data.icon} size={9} />
		</div>
	) : (
		<div
			aria-label={tooltip}
			className="relative flex h-[15px] min-w-0 items-center gap-1 overflow-hidden px-2"
		>
			<span
				aria-hidden="true"
				className={cn("absolute inset-0", toneClass.track)}
			/>
			<span
				aria-hidden="true"
				className={cn(
					"absolute inset-y-0 start-0 opacity-30 transition-[width] duration-300",
					unavailable ? "bg-foreground/[0.08]" : toneClass.bar,
				)}
				style={{ width }}
			/>
			<HugeiconsIcon
				className="relative z-[1] shrink-0 text-foreground-secondary"
				icon={data.icon}
				size={9}
			/>
			<span className="relative z-[1] min-w-0 truncate font-medium text-[8px] text-foreground-secondary uppercase leading-none">
				{unavailable ? (data.unavailableLabel ?? data.label) : data.label}
			</span>
			{unavailable ? null : (
				<span
					className={cn(
						"relative z-[1] ms-auto shrink-0 font-medium text-[8px] tabular-nums leading-none",
						tone === "muted" ? "text-foreground-dim" : "text-foreground",
					)}
				>
					{Math.round(percent)}%
				</span>
			)}
		</div>
	);
	return collapsed ? (
		<Tooltip content={tooltip} side="right">
			{meter}
		</Tooltip>
	) : (
		meter
	);
}

function ResourcesFooter({
	collapsed,
	snapshot,
	visibleKeys,
}: {
	collapsed: boolean;
	snapshot: LiveResourcesEntry | null;
	visibleKeys: readonly ResourceMeterKey[];
}) {
	const meters = buildResourceMeters(snapshot, visibleKeys);
	if (meters.length === 0) {
		return null;
	}
	return (
		<div className="shrink-0 border-divider-strong border-t bg-foreground/[0.015]">
			<div
				className={cn(
					"grid overflow-hidden",
					meters.length > 1
						? "grid-cols-2 divide-x divide-divider/60"
						: "grid-cols-1",
					collapsed ? "w-full" : "min-w-0",
				)}
			>
				{meters.map((meter) => (
					<ResourceMeter collapsed={collapsed} data={meter} key={meter.key} />
				))}
			</div>
		</div>
	);
}

function SearchResultRow({
	children,
	collapsed,
	reduceMotion,
}: {
	children: ReactNode;
	collapsed: boolean;
	reduceMotion: boolean;
}) {
	const isPresent = useIsPresent();
	return (
		<m.div
			animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
			aria-hidden={isPresent ? undefined : true}
			className={cn("flex flex-col", collapsed ? "w-9" : "w-full")}
			data-settings-search-result="true"
			exit={
				reduceMotion
					? { opacity: 1, transition: { duration: 0 } }
					: {
							opacity: 0,
							y: -4,
							filter: "blur(2px)",
							transition: { duration: 0.12 },
						}
			}
			initial={reduceMotion ? false : { opacity: 0, y: 4, filter: "blur(2px)" }}
			transition={
				reduceMotion
					? { duration: 0 }
					: { duration: 0.18, ease: [0.22, 1, 0.36, 1] }
			}
		>
			{children}
		</m.div>
	);
}

// Persist the collapsed preference so it survives window reloads/reopens.
function readCollapsed(): boolean {
	try {
		return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1";
	} catch {
		return false;
	}
}
function writeCollapsed(next: boolean): void {
	try {
		window.localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? "1" : "0");
	} catch {
		// no-op: a denied localStorage just means the preference won't persist
	}
}

/**
 * Settings sidebar — a column that shares the page substrate (surface-1) so it
 * reads as built into the window, with each tab's content floating a layer
 * above. Holds a search affordance (an icon that grows into a live filter
 * field), the wordmark, a collapse toggle, and the vertical tab list (hairline
 * separators close logical groups). The window close button lives in the
 * content card (top-right), not here.
 *
 * The search starts as an icon sitting where the close button used to (leading
 * edge of the header). Clicking it tweens a field open over the "Settings"
 * wordmark (width transition via `.t-resize`); the wordmark hides while it's
 * open. The field folds back when it loses focus — either a blur, or a pointer
 * press anywhere outside it (a plain click on a non-focusable region never
 * blurs an input, so the outside-press listener is what actually catches it).
 *
 * Collapsible: the toggle beside the wordmark shrinks the column to an
 * icon-only rail (labels become hover tooltips) and back.
 */
export function SettingsSidebar({ links }: SettingsSidebarProps) {
	const t = useTranslations("settings");
	const liveResources = useSystemResourcesStore((s) => s.liveResources);
	const refreshResources = useSystemResourcesStore((s) => s.refresh);
	const modelSettings = useSettingsStore((s) => s.settings.model);
	const ttsSettings = useSettingsStore((s) => s.settings.tts);
	const elevenlabs = useSettingsStore(
		(s) => s.settings.integrations.elevenlabs,
	);
	const showRecordingOverlay = useSettingsStore(
		(s) => s.settings.general?.showRecordingOverlay ?? true,
	);
	const liveTranscriptionDisplay = useSettingsStore(
		(s) => s.settings.general?.liveTranscriptionDisplay ?? "both",
	);
	const wordByWordPasting = useSettingsStore(
		(s) => s.settings.general?.wordByWordPasting ?? false,
	);
	const llmDictationEnabled = useSettingsStore(
		(s) => s.settings.llm.dictation.enabled,
	);
	const statesById = useModelStateStore((s) => s.statesById);
	const [query, setQuery] = useState("");
	const [collapsed, setCollapsed] = useState(readCollapsed);
	const [searchOpen, setSearchOpen] = useState(false);
	const reduceMotion = useReducedMotion();
	const inputRef = useRef<HTMLInputElement>(null);
	// Wraps the search affordance + field so an outside-press can tell whether
	// the press landed on the search or somewhere it should fold away.
	const searchRegionRef = useRef<HTMLDivElement>(null);
	const realtimeEnabled = isRealtimeEnabled({
		showRecordingOverlay,
		liveTranscriptionDisplay,
		llmDictationEnabled,
		wordByWordPasting,
	});
	const visibleResourceKeys = useMemo(
		() =>
			getRelevantResourceKeys({
				currentQuantization: modelSettings.onnxQuantization ?? "auto",
				deviceValue: modelSettings.device === "cpu" ? "cpu" : "auto",
				elevenlabs,
				mainModelId: modelSettings.model,
				realtimeEnabled,
				realtimeModelId: modelSettings.realtimeModel,
				snapshot: liveResources,
				statesById,
				tts: ttsSettings,
			}),
		[
			elevenlabs,
			liveResources,
			modelSettings.device,
			modelSettings.model,
			modelSettings.onnxQuantization,
			modelSettings.realtimeModel,
			realtimeEnabled,
			statesById,
			ttsSettings,
		],
	);

	useEffect(() => {
		refreshResources(true);
		const pollId = window.setInterval(() => {
			refreshResources();
		}, RESOURCE_POLL_MS);
		return () => window.clearInterval(pollId);
	}, [refreshResources]);

	// Focus the field the moment it opens so the user can type immediately.
	useEffect(() => {
		if (searchOpen) {
			inputRef.current?.focus();
		}
	}, [searchOpen]);

	// Fold the field away on any pointer press outside it. A click on a
	// non-focusable region (drag strip, a tab row, the content card) never
	// blurs the input, so `onBlur` alone misses it — this is the catch-all.
	// Deferred one tick so a press landing on a filtered tab selects it before
	// the list reverts to the full set.
	useEffect(() => {
		if (!searchOpen) {
			return;
		}
		const onOutsidePress = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (target && searchRegionRef.current?.contains(target)) {
				return;
			}
			window.setTimeout(() => {
				setSearchOpen(false);
				setQuery("");
			}, 120);
		};
		// Capture phase + pointerdown so the press is caught even when a child
		// (a Base UI tab, the scroll area, a field in the tab content) stops
		// propagation in the bubble phase — that was why some outside presses
		// didn't fold the field away.
		document.addEventListener("pointerdown", onOutsidePress, true);
		return () =>
			document.removeEventListener("pointerdown", onOutsidePress, true);
	}, [searchOpen]);

	const closeSearch = () => {
		setSearchOpen(false);
		setQuery("");
		inputRef.current?.blur();
	};

	// Keyboard tab-away: focus leaves to a real focusable (toggle, a tab). A
	// click on a non-focusable region is handled by the outside-press listener
	// above instead. Deferred + guarded so refocus (e.g. the clear button) wins.
	const handleSearchBlur = () => {
		window.setTimeout(() => {
			if (document.activeElement !== inputRef.current) {
				setSearchOpen(false);
				setQuery("");
			}
		}, 120);
	};

	const openSearch = () => {
		// No room for the field in the collapsed rail — expand first.
		if (collapsed) {
			setCollapsed(false);
			writeCollapsed(false);
		}
		setSearchOpen(true);
	};

	const toggleCollapsed = () => {
		const next = !collapsed;
		setCollapsed(next);
		writeCollapsed(next);
		// Collapsing has no room for the search field — fold it away cleanly.
		if (next) {
			closeSearch();
		}
	};

	const trimmed = query.trim().toLowerCase();
	const searching = trimmed.length > 0 && !collapsed;
	// Match against the tab's label, tooltip, AND its section/setting keywords
	// (so "display" surfaces General), with the dictionary's fuzzy matcher for
	// typo tolerance ("dispaly" → Display). See `matchesSearchQuery`.
	const visibleLinks = searching
		? links.filter((l) =>
				matchesSearchQuery(
					`${l.label} ${l.tooltip ?? ""} ${l.keywords ?? ""}`,
					trimmed,
				),
			)
		: links;

	const searchButton = (
		<BaseButton
			aria-label={t("searchPlaceholder")}
			className="titlebar-no-drag flex size-7 shrink-0 items-center justify-center rounded-md bg-transparent text-foreground-muted outline-none transition-colors duration-150 hover:bg-foreground/10 hover:text-foreground-secondary focus-visible:ring-2 focus-visible:ring-accent"
			onClick={openSearch}
			type="button"
		>
			<HugeiconsIcon icon={Search01Icon} size={16} />
		</BaseButton>
	);

	const toggleButton = (
		<Tooltip
			content={collapsed ? t("expandSidebar") : t("collapseSidebar")}
			side="right"
		>
			<BaseButton
				aria-label={collapsed ? t("expandSidebar") : t("collapseSidebar")}
				className="titlebar-no-drag flex size-7 shrink-0 items-center justify-center rounded-md bg-transparent text-foreground-muted outline-none transition-colors duration-150 hover:bg-foreground/10 hover:text-foreground-secondary focus-visible:ring-2 focus-visible:ring-accent"
				onClick={toggleCollapsed}
				type="button"
			>
				<HugeiconsIcon
					icon={collapsed ? PanelLeftOpenIcon : PanelLeftCloseIcon}
					size={16}
				/>
			</BaseButton>
		</Tooltip>
	);

	return (
		<aside
			className="relative flex h-full shrink-0 flex-col bg-[radial-gradient(120%_100%_at_50%_-30%,oklch(100%_0_0_/_0.10),transparent_60%),linear-gradient(180deg,oklch(6.5%_0.01_265)_0%,oklch(8.5%_0.012_265)_52%,oklch(6.8%_0.01_265)_100%)] shadow-[inset_1px_0_0_oklch(0%_0_0_/_0.22),inset_0_1px_0_0_oklch(100%_0_0_/_0.08)] transition-[width] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]"
			style={{ width: collapsed ? COLLAPSED_WIDTH : SIDEBAR_WIDTH }}
		>
			{/* Header strip — search affordance + wordmark + collapse toggle. The
			    h-14 band gives the column a title region. Draggable for window move;
			    opening search tweens a field over the wordmark. */}
			{collapsed ? (
				<div className="flex flex-col items-center gap-1 px-2 pb-1">
					{/* Dedicated window-move handle. It must be its OWN element, never a
					    wrapper around the buttons: an interactive control can't live inside
					    an `-webkit-app-region: drag` region because on touch devices the OS
					    caption path swallows the tap before the `no-drag` carve-out is
					    consulted, leaving the button unclickable by touch (Tauri #4746). A
					    short full-width strip keeps the rail draggable while the buttons
					    below sit on plain client pixels. */}
					<div
						aria-hidden="true"
						className="titlebar-drag h-3.5 w-full shrink-0"
						data-slot="settings-sidebar-top-drag"
					/>
					{toggleButton}
				</div>
			) : (
				// The header itself is NOT a drag region — only the wordmark below is
				// (see its note). Keeping the buttons off any `drag` region is what makes
				// them tappable on touch (Tauri #4746), and a neutral header also means a
				// press in the gutter while the field is open reaches the outside-press
				// listener that folds the field away.
				<div className="relative flex h-14 shrink-0 items-center gap-2 px-3">
					<div
						aria-hidden="true"
						className="titlebar-drag absolute inset-x-0 top-0 h-3.5"
						data-slot="settings-sidebar-top-drag"
					/>
					<div
						className="relative flex h-full min-w-0 flex-1 items-center gap-2"
						ref={searchRegionRef}
					>
						{searchOpen ? null : (
							<>
								{searchButton}
								{/* The wordmark doubles as the window-move handle (`drag`). It
								    sits between the buttons, so they keep their own plain client
								    pixels and stay tappable on touch — see the collapsed-header
								    note and Tauri #4746. `self-stretch` makes the drag box fill the
								    FULL header height (not just the text line), so the strip ABOVE
								    and below the word is draggable too; the inner span keeps the
								    truncating text vertically centred. */}
								<span className="titlebar-drag flex min-w-0 flex-1 items-center self-stretch">
									<span className="min-w-0 flex-1 truncate font-semibold text-foreground text-title tracking-[-0.01em]">
										{t("title")}
									</span>
								</span>
							</>
						)}
						{/* Search field — an overlay that tweens its width 0 → full over the
						    region (the `.t-resize` recipe) so it grows in / out instead of
						    snapping. Always mounted so the close also animates; gated out of
						    the a11y/tab order while folded. */}
						<div
							className="t-resize titlebar-no-drag absolute inset-y-0 start-0 flex items-center overflow-hidden"
							style={{ width: searchOpen ? "100%" : "0px" }}
						>
							<ClearableTextField
								aria-hidden={!searchOpen}
								aria-label={t("searchPlaceholder")}
								clearLabel={t("searchClear")}
								className="h-8 rounded-md border border-border bg-surface-2 shadow-none transition-colors focus-visible:border-border-hover focus-visible:ring-0 focus-visible:ring-offset-0"
								leadingIcon={
									<HugeiconsIcon
										aria-hidden="true"
										icon={Search01Icon}
										size={14}
									/>
								}
								onBlur={handleSearchBlur}
								onKeyDown={(e) => {
									if (e.key === "Escape") {
										// Close the field, not the window.
										e.stopPropagation();
										closeSearch();
									}
								}}
								onValueChange={setQuery}
								placeholder={t("searchPlaceholderShort")}
								ref={inputRef}
								tabIndex={searchOpen ? 0 : -1}
								type="text"
								value={query}
								wrapperClassName="w-full"
							/>
						</div>
					</div>
					{toggleButton}
				</div>
			)}

			{/* Tab list */}
			<Tabs.List
				className={cn(
					"relative flex min-h-0 flex-1 flex-col gap-1 overflow-clip pb-3",
					collapsed ? "items-center px-2" : "px-2",
				)}
			>
				<LazyMotion features={domAnimation} strict>
					<AnimatePresence initial={false} mode="sync">
						{visibleLinks.length === 0 ? (
							<m.p
								animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
								className="px-2.5 py-4 text-body-sm text-foreground-muted"
								exit={
									reduceMotion
										? { opacity: 1, transition: { duration: 0 } }
										: {
												opacity: 0,
												y: -4,
												filter: "blur(2px)",
												transition: { duration: 0.12 },
											}
								}
								initial={
									reduceMotion
										? false
										: { opacity: 0, y: 4, filter: "blur(2px)" }
								}
								key="settings-search-empty"
								transition={
									reduceMotion
										? { duration: 0 }
										: { duration: 0.18, ease: [0.22, 1, 0.36, 1] }
								}
							>
								{t("searchNoResults")}
							</m.p>
						) : (
							visibleLinks.map((link) => {
								const tab = (
									<Tabs.Tab
										className={cn(
											"group/seg relative flex cursor-pointer items-center rounded-full border border-transparent bg-transparent py-0 outline-none transition-[background-color,border-color,box-shadow,transform,color] duration-[180ms] ease-out hover:border-[oklch(100%_0_0_/_0.04)] hover:bg-[oklch(100%_0_0_/_0.03)] active:translate-y-px focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1 data-[active]:border-[oklch(100%_0_0_/_0.07)] data-[active]:border-t-[oklch(100%_0_0_/_0.16)] data-[active]:bg-[linear-gradient(180deg,oklch(100%_0_0_/_0.11)_0%,oklch(100%_0_0_/_0.05)_55%,oklch(100%_0_0_/_0.035)_100%)] data-[active]:shadow-[inset_0_1px_0_0_oklch(100%_0_0_/_0.14),inset_0_-10px_16px_-10px_oklch(0%_0_0_/_0.5),0_10px_22px_-6px_oklch(0%_0_0_/_0.5),0_2px_4px_0_oklch(0%_0_0_/_0.3)] data-[active]:hover:bg-[linear-gradient(180deg,oklch(100%_0_0_/_0.13)_0%,oklch(100%_0_0_/_0.06)_55%,oklch(100%_0_0_/_0.045)_100%)]",
											collapsed
												? "w-10 justify-center"
												: "w-full gap-2.5 ps-3.5 pe-3.5",
										)}
										style={{ height: TAB_HEIGHT }}
										value={link.key}
									>
										<HugeiconsIcon
											className="shrink-0 text-foreground-muted transition-colors duration-200 group-hover/seg:text-foreground-secondary group-data-[active]/seg:text-foreground"
											icon={link.icon}
											size={18}
										/>
										{collapsed ? null : (
											<span className="min-w-0 flex-1 truncate text-start font-sans text-[14px] text-foreground-muted leading-none transition-colors duration-200 group-hover/seg:text-foreground-secondary group-data-[active]/seg:font-semibold group-data-[active]/seg:text-foreground">
												{link.label}
											</span>
										)}
									</Tabs.Tab>
								);
								return (
									<SearchResultRow
										collapsed={collapsed}
										key={link.key}
										reduceMotion={reduceMotion ?? false}
									>
										{collapsed ? (
											<Tooltip content={link.label} side="right">
												{tab}
											</Tooltip>
										) : (
											tab
										)}
										{/* Group separators only when the list isn't filtered */}
										{!searching && link.groupEnd ? <RailSeparator /> : null}
									</SearchResultRow>
								);
							})
						)}
					</AnimatePresence>
				</LazyMotion>
			</Tabs.List>
			<ResourcesFooter
				collapsed={collapsed}
				snapshot={liveResources}
				visibleKeys={visibleResourceKeys}
			/>
		</aside>
	);
}
