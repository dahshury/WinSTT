import {
	CloudIcon,
	Plug01Icon,
	WifiDisconnected01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useEffect } from "react";
import { useTranslations } from "use-intl";
import { useConnectionStore } from "@/entities/connection";
import { useSystemResourcesStore } from "@/entities/system-resources";
import type { LiveResourcesEntry } from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { formatBytes } from "@/shared/lib/format-bytes";
import { Tooltip } from "@/shared/ui/tooltip";
import {
	FOOTER_TOOLTIP_DELAY,
	resolveConnectionChip,
	resolveGpuChipConfig,
} from "../lib/connection-indicator-helpers";

type Translator = ReturnType<typeof useTranslations<"statusBar">>;

const RESOURCE_POLL_MS = 3000;

interface RuntimeResourceFill {
	label: "RAM" | "VRAM";
	percent: number;
	totalBytes: number;
	usedBytes: number;
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.max(0, Math.min(100, value));
}

function percentUsed(usedBytes: number, totalBytes: number): number {
	return totalBytes > 0 ? clampPercent((usedBytes / totalBytes) * 100) : 0;
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

function buildGpuFill(
	snapshot: LiveResourcesEntry | null,
): RuntimeResourceFill {
	const gpu = pickDisplayGpu(snapshot);
	const totalBytes = gpu?.total_vram_bytes ?? 0;
	const freeBytes = gpu?.free_vram_bytes ?? 0;
	const usedBytes =
		gpu === null
			? 0
			: gpu.used_vram_bytes > 0
				? gpu.used_vram_bytes
				: Math.max(0, totalBytes - freeBytes);
	return {
		label: "VRAM",
		percent: percentUsed(usedBytes, totalBytes),
		totalBytes,
		usedBytes,
	};
}

function buildRamFill(
	snapshot: LiveResourcesEntry | null,
): RuntimeResourceFill {
	const totalBytes = snapshot?.ram_total_bytes ?? 0;
	const availableBytes = snapshot?.ram_available_bytes ?? 0;
	const usedBytes = Math.max(0, totalBytes - availableBytes);
	return {
		label: "RAM",
		percent: percentUsed(usedBytes, totalBytes),
		totalBytes,
		usedBytes,
	};
}

function buildRuntimeFill(
	snapshot: LiveResourcesEntry | null,
	isGpu: boolean,
): RuntimeResourceFill {
	return isGpu ? buildGpuFill(snapshot) : buildRamFill(snapshot);
}

function usageLabel(resource: RuntimeResourceFill): string {
	if (resource.totalBytes <= 0) {
		return `${resource.label} usage unavailable`;
	}
	return `${resource.label} ${Math.round(resource.percent)}% - ${formatResourceBytes(resource.usedBytes)} of ${formatResourceBytes(resource.totalBytes)}`;
}

function fillClass(isGpu: boolean, totalBytes: number): string {
	if (totalBytes <= 0) {
		return "bg-foreground/[0.05]";
	}
	return isGpu
		? "bg-gradient-to-r from-success/[0.10] via-success/[0.13] to-success/[0.18]"
		: "bg-gradient-to-r from-foreground/[0.07] via-foreground/[0.10] to-foreground/[0.14]";
}

function ConnectingChip({ t }: { t: Translator }): ReactNode {
	return (
		<Tooltip
			content={t("connectingTooltip")}
			delay={FOOTER_TOOLTIP_DELAY}
			side="top"
		>
			<output className="flex cursor-help items-center gap-1">
				<HugeiconsIcon className="text-warning" icon={CloudIcon} size={12} />
				<span className="font-medium text-2xs text-warning">
					{t("connecting")}
				</span>
			</output>
		</Tooltip>
	);
}

function ErrorChip({ t }: { t: Translator }): ReactNode {
	return (
		<Tooltip
			content={t("errorTooltip")}
			delay={FOOTER_TOOLTIP_DELAY}
			side="top"
		>
			<output className="flex cursor-help items-center gap-1">
				<HugeiconsIcon className="text-error" icon={Plug01Icon} size={12} />
				<span className="font-medium text-2xs text-error">{t("error")}</span>
			</output>
		</Tooltip>
	);
}

function OfflineChip({ t }: { t: Translator }): ReactNode {
	return (
		<Tooltip
			content={t("offlineTooltip")}
			delay={FOOTER_TOOLTIP_DELAY}
			side="top"
		>
			<output className="flex cursor-help items-center gap-1">
				<HugeiconsIcon
					className="text-error"
					icon={WifiDisconnected01Icon}
					size={12}
				/>
				<span className="font-medium text-2xs text-error">{t("offline")}</span>
			</output>
		</Tooltip>
	);
}

interface GpuChipProps {
	gpuName: string;
	isGpu: boolean;
	resource: RuntimeResourceFill;
	t: Translator;
}

function GpuChip({ isGpu, gpuName, resource, t }: GpuChipProps): ReactNode {
	const { icon, label, colorClass } = resolveGpuChipConfig(isGpu);
	const tooltipContent = isGpu
		? t("gpuTooltip", { name: gpuName })
		: t("cpuTooltip", { name: gpuName });
	const resourceLabel = usageLabel(resource);

	return (
		<Tooltip content={tooltipContent} delay={FOOTER_TOOLTIP_DELAY} side="top">
			<output
				aria-label={`${label}, ${resourceLabel}`}
				className="relative isolate flex cursor-help items-center gap-1 overflow-hidden rounded-xs px-1.5 py-[1px] shadow-[inset_0_0_0_1px_oklch(100%_0_0_/_0.035)]"
			>
				<span
					aria-hidden="true"
					className="absolute inset-0 bg-foreground/[0.025]"
				/>
				<span
					aria-hidden="true"
					className={cn(
						"absolute inset-y-0 start-0 transition-[width] duration-500 ease-out",
						fillClass(isGpu, resource.totalBytes),
					)}
					data-slot="runtime-resource-fill"
					style={{ width: `${resource.percent}%` }}
				/>
				<span
					aria-hidden="true"
					className="absolute inset-0 bg-[linear-gradient(180deg,oklch(100%_0_0_/_0.055),transparent_62%)]"
				/>
				<HugeiconsIcon
					className={cn("relative z-raised", colorClass)}
					icon={icon}
					size={12}
				/>
				<span className={cn("relative z-raised font-medium text-2xs", colorClass)}>
					{label}
				</span>
			</output>
		</Tooltip>
	);
}

export function ConnectionIndicator() {
	const connectionStatus = useConnectionStore((s) => s.connectionStatus);
	const serverStatus = useConnectionStore((s) => s.serverStatus);
	const gpuInfo = useConnectionStore((s) => s.gpuInfo);
	const runtimeInfo = useConnectionStore((s) => s.runtimeInfo);
	const liveResources = useSystemResourcesStore((s) => s.liveResources);
	const refreshResources = useSystemResourcesStore((s) => s.refresh);
	const t = useTranslations("statusBar");
	const runtimeIsGpu = runtimeInfo ? runtimeInfo.is_gpu : null;
	const chip = resolveConnectionChip(
		connectionStatus,
		serverStatus,
		runtimeIsGpu,
	);

	useEffect(() => {
		if (chip !== "gpu") {
			return;
		}
		refreshResources(true);
		const pollId = window.setInterval(() => {
			refreshResources();
		}, RESOURCE_POLL_MS);
		return () => window.clearInterval(pollId);
	}, [chip, refreshResources]);

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
	const displayName = isGpu ? (gpuInfo[0]?.name ?? "GPU") : "CPU";
	return (
		<GpuChip
			gpuName={displayName}
			isGpu={isGpu}
			resource={buildRuntimeFill(liveResources, isGpu)}
			t={t}
		/>
	);
}
