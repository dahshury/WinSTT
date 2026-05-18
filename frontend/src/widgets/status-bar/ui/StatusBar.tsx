"use client";

import { Menu } from "@base-ui/react/menu";
import { Separator } from "@base-ui/react/separator";
import { AiAudioIcon, ArrowDown01Icon, Mic01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useTranslations } from "next-intl";
import { type MouseEvent, type ReactNode, useCallback, useMemo } from "react";
import { useInputDevices } from "@/entities/audio-device";
import { useConnectionStore } from "@/entities/connection";
import { useModelSwapStore } from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";
import { ConnectionIndicator } from "@/features/connect-server";
import { useListenStore } from "@/features/listen-mode";
import { useDownloadStore } from "@/features/model-download";
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
						className="shrink-0 text-foreground-dim/60"
						icon={ArrowDown01Icon}
						size={9}
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
	label: string;
	tooltip: string;
}

/** Same outer shape as the old footer select chip (icon · name · chevron),
 *  but clicking it opens the detached model-picker window — the only way
 *  the full picker can be shown without being clipped by the 420×150 main
 *  window. Sends its own viewport rect so the window anchors above it. */
function FooterModelChip({ ariaLabel, label, tooltip }: FooterModelChipProps): ReactNode {
	const substrate = useSurface();
	const hoverLevel = Math.min(substrate + 2, 8);
	const handleClick = useCallback((e: MouseEvent<HTMLButtonElement>) => {
		const r = e.currentTarget.getBoundingClientRect();
		ipcSend(IPC.MODEL_PICKER_OPEN, {
			x: r.x,
			y: r.y,
			width: r.width,
			height: r.height,
		});
	}, []);
	return (
		<Tooltip content={tooltip} delay={FOOTER_TOOLTIP_DELAY} side="top">
			<button
				aria-label={ariaLabel}
				className={`flex max-w-[140px] cursor-pointer select-none items-center gap-1 rounded-xs bg-transparent px-1 py-[1px] text-2xs text-foreground-dim outline-none transition-colors ${surfaceHoverBg(hoverLevel)} focus-visible:ring-1 focus-visible:ring-accent`}
				data-slot="stt-model-selector-trigger"
				onClick={handleClick}
				type="button"
			>
				<HugeiconsIcon
					aria-hidden="true"
					color="var(--color-foreground-dim)"
					icon={AiAudioIcon}
					size={11}
				/>
				<span className="min-w-0 truncate">{label}</span>
				<HugeiconsIcon
					aria-hidden="true"
					className="shrink-0 text-foreground-dim/60"
					icon={ArrowDown01Icon}
					size={9}
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

export function StatusBar() {
	const currentModel = useSettingsStore((s) => s.settings.model?.model);
	const recordingMode = useSettingsStore((s) => s.settings.general?.recordingMode ?? "ptt");
	const inputDeviceIndex = useSettingsStore((s) => s.settings.audio?.inputDeviceIndex);
	const updateAudio = useSettingsStore((s) => s.updateAudioSettings);
	const isListening = useListenStore((s) => s.isListening);
	const listenDeviceName = useListenStore((s) => s.deviceName);
	const isDownloading = useDownloadStore((s) => s.isDownloading);
	const connectionStatus = useConnectionStore((s) => s.connectionStatus);
	const swappingMain = useModelSwapStore((s) => s.activeMain);
	const mainSwapping = swappingMain !== null;
	const t = useTranslations("statusBar");
	const tAudio = useTranslations("audio");
	const tModel = useTranslations("model");

	const { devices, defaultDevice } = useInputDevices();
	const { deviceOptions, deviceNameMap } = useMemo(() => {
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
	}, [devices, defaultDevice, tAudio]);

	const currentDeviceId = inputDeviceIndex == null ? "default" : String(inputDeviceIndex);
	const currentDeviceName = deviceNameMap.get(currentDeviceId) ?? tAudio("systemDefault");

	const handleDeviceChange = useCallback(
		(v: string) =>
			updateAudio({
				inputDeviceIndex: v === "default" ? null : Number.parseInt(v, 10),
			}),
		[updateAudio]
	);

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
						{mainSwapping ? (
							<ModelSwapChip
								label={t("switchingModel", { model: swappingMain })}
								tooltip={t("switchingModelTooltip", { model: swappingMain })}
							/>
						) : (
							<FooterModelChip
								ariaLabel={tModel("model")}
								label={currentModel}
								tooltip={t("modelTooltip", { model: currentModel })}
							/>
						)}
					</>
				)}
			</div>
		</div>
	);
}
