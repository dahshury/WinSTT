import { CpuIcon, GpuIcon } from "@hugeicons/core-free-icons";

export const FOOTER_TOOLTIP_DELAY = 1500;

export interface GpuChipConfig {
	colorClass: string;
	icon: typeof GpuIcon;
	label: string;
}

export function resolveGpuChipConfig(isGpu: boolean): GpuChipConfig {
	return isGpu
		? { icon: GpuIcon, label: "GPU", colorClass: "text-success" }
		: { icon: CpuIcon, label: "CPU", colorClass: "text-foreground-dim" };
}

export type ConnectionChip = "connecting" | "error" | "offline" | "gpu";

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
	runtimeIsGpu: boolean | null,
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
