import { Menu } from "@base-ui/react/menu";
import { Separator } from "@base-ui/react/separator";
import {
	AiAudioIcon,
	AiCloud01Icon,
	ArrowDown01Icon,
	CloudDownloadIcon,
	Mic01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { type MouseEvent, type ReactNode, useEffect, useRef } from "react";
import { useTranslations } from "use-intl";
import { useInputDevices } from "@/entities/audio-device";
import { providerDisplayName, providerOf } from "@/entities/cloud-stt-provider";
import { useConnectionStore } from "@/entities/connection";
import { useCatalogStore, useModelSwapStore } from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";
import { ConnectionIndicator } from "@/features/connect-server";
import { useListenStore } from "@/features/listen-mode";
import {
	type DownloadAggregate,
	useDownloadAggregate,
	useDownloadStore,
} from "@/features/model-download";
import { HotkeyDisplay } from "@/features/push-to-talk";
import { IPC } from "@/shared/api/ipc-channels";
import { ipcSend } from "@/shared/api/ipc-client";
import {
	SurfaceProvider,
	surfaceClasses,
	surfaceHighlightedBg,
	surfaceHoverBg,
	useSurface,
} from "@/shared/lib/surface";
import type { SelectOption } from "@/shared/ui/select";
import { Spinner } from "@/shared/ui/spinner";
import { Tooltip } from "@/shared/ui/tooltip";

const FOOTER_TOOLTIP_DELAY = 1500;
const MAX_DEVICE_CHARS = 8;

/** Strip driver/loopback suffixes: "LG TV (NVIDIA …) [Loopback]" → "LG TV" */
const DEVICE_SUFFIX_RE = /\s*[([].*/;
function shortDeviceName(name: string): string {
	return name.replace(DEVICE_SUFFIX_RE, "").trim() || name;
}

/** Truncate to a few letters for the compact footer chip. */
function abbreviateDevice(name: string): string {
	const short = shortDeviceName(name);
	if (short.length <= MAX_DEVICE_CHARS) {
		return short;
	}
	return `${short.slice(0, MAX_DEVICE_CHARS).trimEnd()}…`;
}

interface FooterMenuChipProps {
	ariaLabel: string;
	icon: IconSvgElement;
	label: string;
	onChange: (id: string) => void;
	options: readonly SelectOption[];
	tooltip: string;
	value: string;
}

function FooterMenuChip({
	ariaLabel,
	icon,
	label,
	onChange,
	options,
	tooltip,
	value,
}: FooterMenuChipProps): ReactNode {
	const substrate = useSurface();
	const hoverLevel = Math.min(substrate + 2, 8);
	const popupLevel = Math.min(substrate + 2, 8);
	const popupShadow = Math.max(popupLevel, 6);
	const highlightLevel = Math.min(popupLevel + 1, 8);
	return (
		<Menu.Root>
			<Tooltip content={tooltip} delay={FOOTER_TOOLTIP_DELAY} side="top">
				<Menu.Trigger
					aria-label={ariaLabel}
					className={`flex max-w-[140px] cursor-pointer select-none items-center gap-1 rounded-xs bg-transparent px-1 py-[1px] text-2xs text-foreground-dim outline-none transition-colors ${surfaceHoverBg(hoverLevel)} focus-visible:ring-1 focus-visible:ring-accent`}
				>
					<HugeiconsIcon
						aria-hidden="true"
						color="var(--color-foreground-dim)"
						icon={icon}
						size={11}
					/>
					<span className="min-w-0 truncate">{label}</span>
					<HugeiconsIcon
						aria-hidden="true"
						className="shrink-0 text-foreground-dim"
						icon={ArrowDown01Icon}
						size={11}
					/>
				</Menu.Trigger>
			</Tooltip>
			<Menu.Portal>
				<SurfaceProvider value={popupLevel}>
					<Menu.Positioner
						align="end"
						className="z-popover outline-none"
						collisionPadding={8}
						side="top"
						sideOffset={6}
					>
						<Menu.Popup
							className={`select-popup min-w-[var(--anchor-width)] origin-[var(--transform-origin)] overflow-y-auto rounded-sm ${surfaceClasses(popupLevel, popupShadow)} py-1 transition-[transform,opacity] duration-150 ease-out [max-height:min(15rem,var(--available-height))] [max-width:var(--available-width)]`}
						>
							<Menu.RadioGroup onValueChange={onChange} value={value}>
								{options.map((opt) => (
									<Menu.RadioItem
										className={`mx-1 flex cursor-default select-none items-center gap-1.5 rounded-xs px-2.5 py-[6px] text-body text-foreground leading-normal outline-none ${surfaceHighlightedBg(highlightLevel)} data-[checked]:text-accent`}
										closeOnClick
										key={opt.id}
										value={opt.id}
									>
										<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
											{opt.label}
										</span>
									</Menu.RadioItem>
								))}
							</Menu.RadioGroup>
						</Menu.Popup>
					</Menu.Positioner>
				</SurfaceProvider>
			</Menu.Portal>
		</Menu.Root>
	);
}

interface FooterModelChipProps {
	ariaLabel: string;
	icon?: IconSvgElement;
	label: string;
	tooltip: string;
}

/** Same outer shape as the old footer select chip (icon · name · chevron),
 *  but clicking it opens the detached model-picker window — the only way
 *  the full picker can be shown without being clipped by the 420×150 main
 *  window. Sends its own viewport rect so the window anchors above it. */
const CHIP_SLOT = '[data-slot="stt-model-selector-trigger"]';

function FooterModelChip({
	ariaLabel,
	label,
	tooltip,
	icon = AiAudioIcon,
}: FooterModelChipProps): ReactNode {
	const substrate = useSurface();
	const hoverLevel = Math.min(substrate + 2, 8);
	// The picker is a separate always-on-top window; clicking back into THIS
	// (main) window doesn't reliably blur it, so OS-focus alone can't dismiss
	// it. Any pointer-down anywhere in the app that isn't the chip itself is
	// "clicked outside the popup" → tell main to close. Main no-ops the
	// message when the picker isn't shown, so the open flag is just a cheap
	// guard to avoid sending on every idle click.
	const openRef = useRef(false);
	const openModelPicker = (e: MouseEvent<HTMLButtonElement>) => {
		const r = e.currentTarget.getBoundingClientRect();
		ipcSend(IPC.MODEL_PICKER_OPEN, {
			x: r.x,
			y: r.y,
			width: r.width,
			height: r.height,
		});
		openRef.current = true;
	};
	useEffect(() => {
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as HTMLElement | null;
			if (target?.closest(CHIP_SLOT)) {
				return; // the chip toggles itself via main
			}
			if (openRef.current) {
				openRef.current = false;
				ipcSend(IPC.MODEL_PICKER_CLOSE);
			}
		};
		window.addEventListener("pointerdown", onPointerDown, true);
		return () => window.removeEventListener("pointerdown", onPointerDown, true);
	}, []);
	return (
		<Tooltip content={tooltip} delay={FOOTER_TOOLTIP_DELAY} side="top">
			<button
				aria-label={ariaLabel}
				className={`flex max-w-[140px] cursor-pointer select-none items-center gap-1 rounded-xs bg-transparent px-1 py-[1px] text-2xs text-foreground-dim outline-none transition-colors ${surfaceHoverBg(hoverLevel)} focus-visible:ring-1 focus-visible:ring-accent`}
				data-slot="stt-model-selector-trigger"
				onClick={openModelPicker}
				type="button"
			>
				<HugeiconsIcon
					aria-hidden="true"
					color="var(--color-foreground-dim)"
					icon={icon}
					size={11}
				/>
				<span className="min-w-0 truncate">{label}</span>
				<HugeiconsIcon
					aria-hidden="true"
					className="shrink-0 text-foreground-dim"
					icon={ArrowDown01Icon}
					size={11}
				/>
			</button>
		</Tooltip>
	);
}

interface ModelSwapChipProps {
	label: string;
	tooltip: string;
}

/** Read-only chip shown in place of the model chip while a swap is in
 *  flight. Same compact footprint so the bar doesn't shift. */
function ModelSwapChip({ label, tooltip }: ModelSwapChipProps): ReactNode {
	return (
		<Tooltip content={tooltip} delay={FOOTER_TOOLTIP_DELAY} side="top">
			<span
				aria-live="polite"
				className="flex max-w-[180px] cursor-default select-none items-center gap-1 rounded-xs bg-transparent px-1 py-[1px] text-2xs text-foreground-dim"
			>
				<Spinner className="size-2.5 border" />
				<span className="min-w-0 truncate">{label}</span>
			</span>
		</Tooltip>
	);
}

interface FooterDownloadChipProps {
	aggregate: DownloadAggregate;
	ariaLabel: string;
	primaryModelName: string;
	tooltip: string;
}

/** Footer chip variant rendered while at least one per-quant or whole-model
 *  download is streaming. Same clickable shape as ``FooterModelChip`` (so
 *  the user can pop the picker open to inspect per-quant detail) but with
 *  a pulsing download dot, the active model's name (or "N downloads" when
 *  parallel), and a tabular percent on the right.
 *
 *  Parallel-download UX: each badge inside the picker keeps its own
 *  progress fill; this chip is the at-a-glance summary for users who've
 *  dismissed the picker and want to see "how close are we" without
 *  re-opening it. ``aggregate.averagePercent`` is the mean across every
 *  known-percent download so a long-tail download doesn't drag the chip's
 *  reported progress backwards every time a new (small) download starts.
 *
 *  Clicking still routes through ``FooterModelChip`` semantics — sends the
 *  bounding rect to main, which positions the detached picker window
 *  above the chip. */
function FooterDownloadChip({
	aggregate,
	ariaLabel,
	primaryModelName,
	tooltip,
}: FooterDownloadChipProps): ReactNode {
	const substrate = useSurface();
	const hoverLevel = Math.min(substrate + 2, 8);
	const openRef = useRef(false);
	const open = (e: MouseEvent<HTMLButtonElement>) => {
		const r = e.currentTarget.getBoundingClientRect();
		ipcSend(IPC.MODEL_PICKER_OPEN, {
			x: r.x,
			y: r.y,
			width: r.width,
			height: r.height,
		});
		openRef.current = true;
	};
	useEffect(() => {
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as HTMLElement | null;
			if (target?.closest('[data-slot="stt-model-selector-trigger"]')) {
				return;
			}
			if (openRef.current) {
				openRef.current = false;
				ipcSend(IPC.MODEL_PICKER_CLOSE);
			}
		};
		window.addEventListener("pointerdown", onPointerDown, true);
		return () => window.removeEventListener("pointerdown", onPointerDown, true);
	}, []);
	const multi = aggregate.count >= 2;
	const label = multi ? `${aggregate.count} downloads` : primaryModelName;
	const reportedPercent = multi ? aggregate.averagePercent : aggregate.primary.percent;
	return (
		<Tooltip content={tooltip} delay={FOOTER_TOOLTIP_DELAY} side="top">
			<button
				aria-label={ariaLabel}
				aria-live="polite"
				className={`flex max-w-[180px] cursor-pointer select-none items-center gap-1 rounded-xs bg-transparent px-1 py-[1px] text-2xs text-foreground-dim outline-none transition-colors ${surfaceHoverBg(hoverLevel)} focus-visible:ring-1 focus-visible:ring-accent`}
				data-slot="stt-model-selector-trigger"
				onClick={open}
				type="button"
			>
				<span className="relative inline-flex size-2.5 items-center justify-center">
					<HugeiconsIcon
						aria-hidden="true"
						className="text-accent"
						icon={CloudDownloadIcon}
						size={11}
					/>
					<span
						aria-hidden="true"
						className="absolute inset-0 animate-ping rounded-full bg-accent/40 motion-reduce:animate-none"
					/>
				</span>
				<span className="min-w-0 truncate">{label}</span>
				<span className="shrink-0 font-mono tabular-nums">
					{reportedPercent === null ? "…" : `${reportedPercent}%`}
				</span>
			</button>
		</Tooltip>
	);
}

interface ActiveModelChipProps {
	currentModel: string;
	tIntegrations: ReturnType<typeof useTranslations>;
	tModel: ReturnType<typeof useTranslations>;
	tStatus: ReturnType<typeof useTranslations>;
}

/**
 * Renders the footer model chip with cloud or local affordances. Pulled
 * out of `StatusBar` to keep the parent under Biome's cognitive-complexity
 * cap — the cloud branch reads several store fields and computes a
 * localized tooltip string, all of which counted against the parent.
 */
function ActiveModelChip({
	currentModel,
	tModel,
	tStatus,
	tIntegrations,
}: ActiveModelChipProps): ReactNode {
	const cloudProvider = providerOf(currentModel);
	const cloudVerified = useSettingsStore((s) =>
		cloudProvider ? s.settings.integrations[cloudProvider].verified : null
	);
	if (cloudProvider) {
		const status =
			cloudVerified === true
				? tIntegrations("providerStatusValid")
				: tIntegrations("providerStatusNotVerified");
		return (
			<FooterModelChip
				ariaLabel={tModel("model")}
				icon={AiCloud01Icon}
				label={currentModel}
				tooltip={tIntegrations("providerStatus", {
					provider: providerDisplayName(cloudProvider),
					status,
				})}
			/>
		);
	}
	return (
		<FooterModelChip
			ariaLabel={tModel("model")}
			icon={AiAudioIcon}
			label={currentModel}
			tooltip={tStatus("modelTooltip", { model: currentModel })}
		/>
	);
}

export function StatusBar() {
	const currentModel = useSettingsStore((s) => s.settings.model?.model);
	const recordingMode = useSettingsStore((s) => s.settings.general?.recordingMode ?? "ptt");
	const inputDeviceIndex = useSettingsStore((s) => s.settings.audio?.inputDeviceIndex);
	const updateAudio = useSettingsStore((s) => s.updateAudioSettings);
	const isListening = useListenStore((s) => s.isListening);
	const listenDeviceName = useListenStore((s) => s.deviceName);
	const isDownloading = useDownloadStore((s) => s.isDownloading);
	// Per-quant + whole-model aggregate so the footer chip can preempt the
	// idle model chip with a "↓ Model X%" / "↓ N downloads · X%" view
	// whenever bytes are streaming — visible even with the detached picker
	// dismissed, so the user can monitor progress from the main window.
	const downloadAggregate = useDownloadAggregate();
	const getCatalogModel = useCatalogStore((s) => s.getModel);
	const connectionStatus = useConnectionStore((s) => s.connectionStatus);
	const swappingMain = useModelSwapStore((s) => s.activeMain);
	const mainSwapping = swappingMain !== null;
	const t = useTranslations("statusBar");
	const tAudio = useTranslations("audio");
	const tModel = useTranslations("model");

	const { devices, defaultDevice } = useInputDevices();
	const { deviceOptions, deviceNameMap } = (() => {
		const defaultLabel = defaultDevice
			? `${tAudio("systemDefault")} (${defaultDevice.name})`
			: tAudio("systemDefault");
		const opts: SelectOption[] = [{ id: "default", label: defaultLabel }];
		const map = new Map<string, string>();
		map.set("default", defaultDevice ? defaultDevice.name : tAudio("systemDefault"));
		for (const d of devices) {
			opts.push({ id: String(d.index), label: d.name });
			map.set(String(d.index), d.name);
		}
		return { deviceOptions: opts, deviceNameMap: map };
	})();

	const currentDeviceId = inputDeviceIndex == null ? "default" : String(inputDeviceIndex);
	const currentDeviceName = deviceNameMap.get(currentDeviceId) ?? tAudio("systemDefault");

	const handleDeviceChange = (v: string) =>
		updateAudio({
			inputDeviceIndex: v === "default" ? null : Number.parseInt(v, 10),
		});

	const tIntegrations = useTranslations("integrations");

	const substrate = useSurface();
	const barLevel = Math.min(substrate + 1, 8);
	return (
		<div
			className={[
				`flex shrink-0 items-center justify-between overflow-hidden whitespace-nowrap border-border border-t ${surfaceClasses(barLevel, 1)} px-2 py-1 font-mono`,
				isDownloading && "pointer-events-none opacity-50",
			]
				.filter(Boolean)
				.join(" ")}
		>
			<ConnectionIndicator />
			<div className="flex items-center gap-1.5">
				{recordingMode === "listen" ? (
					<Tooltip
						content={isListening ? t("loopbackActiveTooltip") : t("loopbackIdleTooltip")}
						delay={FOOTER_TOOLTIP_DELAY}
						side="top"
					>
						<span className="inline-flex max-w-[120px] cursor-help items-center gap-1.5 text-2xs">
							{isListening && (
								<span className="inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-success" />
							)}
							<span className={`truncate ${isListening ? "text-success" : "text-foreground-dim"}`}>
								{listenDeviceName ? shortDeviceName(listenDeviceName) : t("loopbackIdle")}
							</span>
						</span>
					</Tooltip>
				) : (
					<>
						<HotkeyDisplay isConnected={connectionStatus === "connected"} />
						<Separator className="h-3 w-px bg-border" orientation="vertical" />
						<FooterMenuChip
							ariaLabel={tAudio("inputDevice")}
							icon={Mic01Icon}
							label={abbreviateDevice(currentDeviceName)}
							onChange={handleDeviceChange}
							options={deviceOptions}
							tooltip={currentDeviceName}
							value={currentDeviceId}
						/>
					</>
				)}
				{currentModel && (
					<>
						<Separator className="h-3 w-px bg-border" orientation="vertical" />
						{(() => {
							if (mainSwapping) {
								return (
									<ModelSwapChip
										label={t("switchingModel", { model: swappingMain })}
										tooltip={t("switchingModelTooltip", { model: swappingMain })}
									/>
								);
							}
							if (downloadAggregate) {
								const primaryName =
									getCatalogModel(downloadAggregate.primary.modelId)?.displayName ??
									downloadAggregate.primary.modelId;
								const tooltipKey =
									downloadAggregate.count >= 2 ? "downloadingMultiTooltip" : "downloadingTooltip";
								const tooltip = t(tooltipKey, {
									count: downloadAggregate.count,
									model: primaryName,
								});
								return (
									<FooterDownloadChip
										aggregate={downloadAggregate}
										ariaLabel={tModel("model")}
										primaryModelName={primaryName}
										tooltip={tooltip}
									/>
								);
							}
							return (
								<ActiveModelChip
									currentModel={currentModel}
									tIntegrations={tIntegrations}
									tModel={tModel}
									tStatus={t}
								/>
							);
						})()}
					</>
				)}
			</div>
		</div>
	);
}
