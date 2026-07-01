import {
	CloudIcon,
	Plug01Icon,
	WifiDisconnected01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
	useEffect,
	useRef,
} from "react";
import { useTranslations } from "use-intl";
import { useConnectionStore } from "@/entities/connection";
import { useSystemResourcesStore } from "@/entities/system-resources";
import { footprintWindowOpen, windowCloseNamed } from "@/shared/api/ipc-client";
import type { StatusBarTranslateFn } from "@/shared/i18n/translation-types";
import { cn } from "@/shared/lib/cn";
import { formatBytes } from "@/shared/lib/format-bytes";
import { Tooltip } from "@/shared/ui/tooltip";
import {
	FOOTER_TOOLTIP_DELAY,
	resolveConnectionChip,
	resolveGpuChipConfig,
} from "../lib/connection-indicator-helpers";
import {
	type RuntimeResourceFill,
	buildRuntimeFill,
} from "../lib/runtime-resource-fill";

const RESOURCE_POLL_MS = 3000;
// Hover-card timings: a short open delay so a passing cursor doesn't flash the
// panel, and a brief close grace so tiny gaps (sub-pixel jitter) don't dismiss it.
const FOOTPRINT_OPEN_DELAY_MS = 300;
const FOOTPRINT_CLOSE_GRACE_MS = 120;
const FOOTPRINT_WINDOW = "model-footprint";

function formatResourceBytes(bytes: number): string {
	return formatBytes(bytes, { gbDecimals: 1, mbDecimals: 0 }) ?? "0 MB";
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

function ConnectingChip({ t }: { t: StatusBarTranslateFn }): ReactNode {
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

function ErrorChip({ t }: { t: StatusBarTranslateFn }): ReactNode {
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

function OfflineChip({ t }: { t: StatusBarTranslateFn }): ReactNode {
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
	isGpu: boolean;
	resource: RuntimeResourceFill;
}

/**
 * The footer GPU/CPU chip. Hovering it opens the detached, non-focusable
 * model-footprint panel anchored above it (the breakdown is taller than the
 * 420×150 main window can show); leaving the chip closes it. The chip itself
 * keeps its live VRAM/RAM fill bar.
 */
function GpuChip({ isGpu, resource }: GpuChipProps): ReactNode {
	const { icon, label, colorClass } = resolveGpuChipConfig(isGpu);
	const resourceLabel = usageLabel(resource);
	const openTimer = useRef<number | null>(null);
	const closeTimer = useRef<number | null>(null);

	const cancelOpen = () => {
		if (openTimer.current !== null) {
			window.clearTimeout(openTimer.current);
			openTimer.current = null;
		}
	};
	const cancelClose = () => {
		if (closeTimer.current !== null) {
			window.clearTimeout(closeTimer.current);
			closeTimer.current = null;
		}
	};

	const handleEnter = (e: ReactPointerEvent<HTMLOutputElement>) => {
		const r = e.currentTarget.getBoundingClientRect();
		cancelClose();
		if (openTimer.current !== null) {
			return;
		}
		openTimer.current = window.setTimeout(() => {
			openTimer.current = null;
			footprintWindowOpen({
				x: r.x,
				y: r.y,
				width: r.width,
				height: r.height,
			});
		}, FOOTPRINT_OPEN_DELAY_MS);
	};

	const handleLeave = () => {
		cancelOpen();
		if (closeTimer.current !== null) {
			return;
		}
		closeTimer.current = window.setTimeout(() => {
			closeTimer.current = null;
			windowCloseNamed(FOOTPRINT_WINDOW);
		}, FOOTPRINT_CLOSE_GRACE_MS);
	};

	// On unmount (chip leaves the GPU state), drop any pending timer and make
	// sure the panel doesn't linger.
	useEffect(
		() => () => {
			cancelOpen();
			cancelClose();
			windowCloseNamed(FOOTPRINT_WINDOW);
		},
		[],
	);

	return (
		<output
			aria-label={`${label}, ${resourceLabel}`}
			className="relative isolate flex cursor-help items-center gap-1 overflow-hidden rounded-xs px-1.5 py-[1px] shadow-[inset_0_0_0_1px_var(--color-divider)]"
			data-slot="gpu-footprint-trigger"
			onPointerEnter={handleEnter}
			onPointerLeave={handleLeave}
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
				className="absolute inset-0 bg-gradient-to-b from-overlay-foreground/[0.055] to-transparent"
			/>
			<HugeiconsIcon
				className={cn("relative z-raised", colorClass)}
				icon={icon}
				size={12}
			/>
			<span
				className={cn("relative z-raised font-medium text-2xs", colorClass)}
			>
				{label}
			</span>
		</output>
	);
}

export function ConnectionIndicator() {
	const connectionStatus = useConnectionStore((s) => s.connectionStatus);
	const serverStatus = useConnectionStore((s) => s.serverStatus);
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
	const isGpu = runtimeIsGpu === true;
	return (
		<GpuChip isGpu={isGpu} resource={buildRuntimeFill(liveResources, isGpu)} />
	);
}
