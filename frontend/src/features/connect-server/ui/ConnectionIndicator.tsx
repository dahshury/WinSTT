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
			</output>
		</Tooltip>
	);
}
