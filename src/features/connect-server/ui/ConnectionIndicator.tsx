import { CloudIcon, Plug01Icon, WifiDisconnected01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import { useConnectionStore } from "@/entities/connection";
import { Tooltip } from "@/shared/ui/tooltip";
import {
	FOOTER_TOOLTIP_DELAY,
	resolveConnectionChip,
	resolveGpuChipConfig,
} from "../lib/connection-indicator-helpers";

type Translator = ReturnType<typeof useTranslations<"statusBar">>;

function ConnectingChip({ t }: { t: Translator }): ReactNode {
	return (
		<Tooltip content={t("connectingTooltip")} delay={FOOTER_TOOLTIP_DELAY} side="top">
			<output className="flex cursor-help items-center gap-1">
				<HugeiconsIcon className="text-warning" icon={CloudIcon} size={12} />
				<span className="font-medium text-2xs text-warning">{t("connecting")}</span>
			</output>
		</Tooltip>
	);
}

function ErrorChip({ t }: { t: Translator }): ReactNode {
	return (
		<Tooltip content={t("errorTooltip")} delay={FOOTER_TOOLTIP_DELAY} side="top">
			<output className="flex cursor-help items-center gap-1">
				<HugeiconsIcon className="text-error" icon={Plug01Icon} size={12} />
				<span className="font-medium text-2xs text-error">{t("error")}</span>
			</output>
		</Tooltip>
	);
}

function OfflineChip({ t }: { t: Translator }): ReactNode {
	return (
		<Tooltip content={t("offlineTooltip")} delay={FOOTER_TOOLTIP_DELAY} side="top">
			<output className="flex cursor-help items-center gap-1">
				<HugeiconsIcon className="text-error" icon={WifiDisconnected01Icon} size={12} />
				<span className="font-medium text-2xs text-error">{t("offline")}</span>
			</output>
		</Tooltip>
	);
}

interface GpuChipProps {
	gpuName: string;
	isGpu: boolean;
	t: Translator;
}

function GpuChip({ isGpu, gpuName, t }: GpuChipProps): ReactNode {
	const { icon, label, colorClass } = resolveGpuChipConfig(isGpu);
	const tooltipContent = isGpu
		? t("gpuTooltip", { name: gpuName })
		: t("cpuTooltip", { name: gpuName });

	return (
		<Tooltip content={tooltipContent} delay={FOOTER_TOOLTIP_DELAY} side="top">
			<output className="flex cursor-help items-center gap-1">
				<HugeiconsIcon className={colorClass} icon={icon} size={12} />
				<span className={`font-medium text-2xs ${colorClass}`}>{label}</span>
			</output>
		</Tooltip>
	);
}

export function ConnectionIndicator() {
	const connectionStatus = useConnectionStore((s) => s.connectionStatus);
	const serverStatus = useConnectionStore((s) => s.serverStatus);
	const gpuInfo = useConnectionStore((s) => s.gpuInfo);
	const runtimeInfo = useConnectionStore((s) => s.runtimeInfo);
	const t = useTranslations("statusBar");
	const runtimeIsGpu = runtimeInfo ? runtimeInfo.is_gpu : null;
	const chip = resolveConnectionChip(connectionStatus, serverStatus, runtimeIsGpu);

	if (chip === "connecting") {
		return <ConnectingChip t={t} />;
	}
	if (chip === "error") {
		return <ErrorChip t={t} />;
	}
	if (chip === "offline") {
		return <OfflineChip t={t} />;
	}
	// runtimeIsGpu is non-null here per resolveConnectionChip's contract;
	// fall back to gpuInfo.name only for display.
	const isGpu = runtimeIsGpu === true;
	const displayName = isGpu ? (gpuInfo?.name ?? "GPU") : "CPU";
	return <GpuChip gpuName={displayName} isGpu={isGpu} t={t} />;
}
