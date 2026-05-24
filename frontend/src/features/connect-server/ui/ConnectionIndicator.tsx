import {
	CloudIcon,
	CpuIcon,
	GpuIcon,
	Plug01Icon,
	WifiDisconnected01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useConnectionStore } from "@/entities/connection";
import { Tooltip } from "@/shared/ui/tooltip";

const FOOTER_TOOLTIP_DELAY = 1500;

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

interface GpuChipConfig {
	colorClass: string;
	icon: typeof GpuIcon;
	label: string;
}

export function resolveGpuChipConfig(isGpu: boolean): GpuChipConfig {
	return isGpu
		? { icon: GpuIcon, label: "GPU", colorClass: "text-success" }
		: { icon: CpuIcon, label: "CPU", colorClass: "text-foreground-dim" };
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

type ConnectionChip = "connecting" | "error" | "offline" | "gpu";

const CONNECTION_CHIP_MAP: Record<string, ConnectionChip> = {
	connecting: "connecting",
	error: "error",
};

/**
 * Decide which connection chip to render.
 *
 * "connected" on the WebSocket alone is NOT enough to show the green
 * GPU/CPU chip — the server's recorder may still be loading models or
 * running its CUDA warmup pass, during which any PTT press is a no-op.
 * The server emits a ``server_ready`` WS message once the recorder is
 * fully initialized; that maps to ``serverStatus === "running"``.  Keep
 * the chip at "connecting" until that arrives so users don't see a
 * green light while the recorder is still cold.
 *
 * Once running we read ``runtimeInfo.is_gpu`` as the authoritative truth
 * for GPU/CPU. The ``gpuInfo`` (nvidia-smi probe) is hardware-only and
 * lies when the user installs the CPU-only ``onnxruntime`` wheel on a
 * machine with an NVIDIA card — we keep it around only for the tooltip's
 * GPU model name.
 */
export function resolveConnectionChip(
	connectionStatus: string,
	serverStatus: string,
	runtimeIsGpu: boolean | null
): ConnectionChip {
	const mapped = CONNECTION_CHIP_MAP[connectionStatus];
	if (mapped) {
		return mapped;
	}
	if (connectionStatus !== "connected") {
		return "offline";
	}
	if (serverStatus !== "running" || runtimeIsGpu === null) {
		return "connecting";
	}
	return "gpu";
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
