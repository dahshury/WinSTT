import type { LiveResourcesEntry } from "@/shared/api/ipc-client";

/**
 * Live device-memory pressure derived from a {@link LiveResourcesEntry}
 * snapshot. `percent` is the used fraction clamped to 0–100; `usedBytes` /
 * `totalBytes` drive the chip's fill bar and the breakdown tooltip's header.
 *
 * Shared between the footer GPU/CPU chip and the detached footprint window so
 * both read identical numbers from the same snapshot.
 */
export interface RuntimeResourceFill {
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

/** The GPU we report on: the card with the most VRAM (the discrete one on a
 *  hybrid laptop), falling back to the first if totals tie / are absent. */
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

export function buildRuntimeFill(
	snapshot: LiveResourcesEntry | null,
	isGpu: boolean,
): RuntimeResourceFill {
	return isGpu ? buildGpuFill(snapshot) : buildRamFill(snapshot);
}

/** Usage payload for {@link GpuModelBreakdown}: the active device's used/total
 *  for the header, plus used bytes for BOTH pools so each section's share is
 *  measured against the memory its weights actually live in (VRAM for GPU rows,
 *  RAM for the always-CPU dictionary even on a GPU host). */
export function buildBreakdownUsage(
	snapshot: LiveResourcesEntry | null,
	isGpu: boolean,
): {
	device: "gpu" | "cpu";
	totalBytes: number;
	usedBytes: number;
	usedByDevice: { gpu: number; cpu: number };
} {
	const gpu = buildGpuFill(snapshot);
	const ram = buildRamFill(snapshot);
	const active = isGpu ? gpu : ram;
	return {
		device: isGpu ? "gpu" : "cpu",
		totalBytes: active.totalBytes,
		usedBytes: active.usedBytes,
		usedByDevice: { gpu: gpu.usedBytes, cpu: ram.usedBytes },
	};
}
