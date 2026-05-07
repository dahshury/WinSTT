"use client";

import {
	CloudIcon,
	CpuIcon,
	GpuIcon,
	Plug01Icon,
	WifiDisconnected01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "next-intl";
import { useConnectionStore } from "@/entities/connection";
import { Tooltip } from "@/shared/ui/tooltip";

const FOOTER_TOOLTIP_DELAY = 1500;

const RE_VENDOR = /^(NVIDIA|AMD|Intel)\s+/i;
const RE_FAMILY = /^(GeForce|Radeon|Instinct)\s+/i;
const RE_BUS = /[-\s](?:SXM\d?|PCIe|PCI-E|NVLink)[-\s]?\d*\w*/gi;
const RE_MEM = /[-\s]\d+\s?GB$/i;
const RE_SUPER = /\bSUPER\b/i;
const RE_LAPTOP = /\bLAPTOP\s*GPU\b/i;

/** Shorten a GPU/CPU name to its essential model identifier. */
function shortenGpuName(raw: string): string {
	let name = raw.trim();
	name = name.replace(RE_VENDOR, "");
	name = name.replace(RE_FAMILY, "");
	name = name.replace(RE_BUS, "");
	name = name.replace(RE_MEM, "");
	name = name.replace(RE_SUPER, "S");
	name = name.replace(RE_LAPTOP, "");
	return name.trim() || raw.trim();
}

export function ConnectionIndicator() {
	const status = useConnectionStore((s) => s.connectionStatus);
	const gpuInfo = useConnectionStore((s) => s.gpuInfo);
	const t = useTranslations("statusBar");

	if (status === "connecting") {
		return (
			<Tooltip content={t("connectingTooltip")} delay={FOOTER_TOOLTIP_DELAY} side="top">
				<output className="flex cursor-help items-center gap-1">
					<HugeiconsIcon className="text-warning" icon={CloudIcon} size={12} />
					<span className="font-medium text-2xs text-warning">{t("connecting")}</span>
				</output>
			</Tooltip>
		);
	}

	if (status === "error") {
		return (
			<Tooltip content={t("errorTooltip")} delay={FOOTER_TOOLTIP_DELAY} side="top">
				<output className="flex cursor-help items-center gap-1">
					<HugeiconsIcon className="text-error" icon={Plug01Icon} size={12} />
					<span className="font-medium text-2xs text-error">{t("error")}</span>
				</output>
			</Tooltip>
		);
	}

	if (status !== "connected" || !gpuInfo) {
		return (
			<Tooltip content={t("offlineTooltip")} delay={FOOTER_TOOLTIP_DELAY} side="top">
				<output className="flex cursor-help items-center gap-1">
					<HugeiconsIcon className="text-error" icon={WifiDisconnected01Icon} size={12} />
					<span className="font-medium text-2xs text-error">{t("offline")}</span>
				</output>
			</Tooltip>
		);
	}

	const isGpu = gpuInfo.available;
	const icon = isGpu ? GpuIcon : CpuIcon;
	const label = isGpu ? "GPU" : "CPU";
	const shortName = shortenGpuName(gpuInfo.name);
	const tooltipContent = isGpu
		? t("gpuTooltip", { name: gpuInfo.name })
		: t("cpuTooltip", { name: gpuInfo.name });

	return (
		<Tooltip content={tooltipContent} delay={FOOTER_TOOLTIP_DELAY} side="top">
			<output className="flex cursor-help items-center gap-1">
				<HugeiconsIcon
					className={isGpu ? "text-success" : "text-foreground-dim"}
					icon={icon}
					size={12}
				/>
				<span className={`font-medium text-2xs ${isGpu ? "text-success" : "text-foreground-dim"}`}>
					{label}
				</span>
				<span className="text-[9px] text-foreground-dim/60">{shortName}</span>
			</output>
		</Tooltip>
	);
}
