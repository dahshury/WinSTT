import { useEffect, useRef } from "react";
import { useTranslations } from "use-intl";
import { useConnectionStore, useGpuInfo } from "@/entities/connection";
import { useSystemResourcesStore } from "@/entities/system-resources";
import {
	buildBreakdownUsage,
	GpuModelBreakdown,
	useConnectionListener,
	useRuntimeModelBreakdown,
} from "@/features/connect-server";
import { useDownloadListener } from "@/features/model-download";
import { useSyncSettings } from "@/features/update-settings";
import { windowResizeNamed } from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { surfaceClasses } from "@/shared/lib/surface";

const RESOURCE_POLL_MS = 3000;
const PANEL_LEVEL = 5;
const PANEL_SHADOW_LEVEL = 7;

/**
 * Renderer half of the detached model-footprint hover panel. The footer GPU/CPU
 * chip's breakdown is taller than the 420×150 main window can show, so it's
 * hosted in its own non-focusable, content-sized window anchored above the chip.
 *
 * Mirrors the device picker: hydrates the same stores the breakdown needs,
 * renders the full breakdown plus the "change it in Settings" sentence in one
 * card, and reports its content size back so the OS window hugs the card.
 */
export function ModelFootprintWindow() {
	// Hydrate the stores the breakdown reads (same set the model-picker window
	// mounts): settings, connection, downloads, GPU probe. The breakdown hook
	// itself nudges model-state / TTS / Ollama.
	useSyncSettings();
	useConnectionListener();
	useDownloadListener();
	useGpuInfo();

	const t = useTranslations("statusBar");
	const runtimeInfo = useConnectionStore((s) => s.runtimeInfo);
	const gpuInfo = useConnectionStore((s) => s.gpuInfo);
	const liveResources = useSystemResourcesStore((s) => s.liveResources);
	const refreshLive = useSystemResourcesStore((s) => s.refresh);
	const isGpu = runtimeInfo?.is_gpu ?? false;
	const sections = useRuntimeModelBreakdown(isGpu);
	const containerRef = useRef<HTMLDivElement | null>(null);

	// Keep VRAM/RAM pressure live while the panel is mounted.
	useEffect(() => {
		refreshLive(true);
		const pollId = window.setInterval(() => refreshLive(), RESOURCE_POLL_MS);
		return () => window.clearInterval(pollId);
	}, [refreshLive]);

	// Report the live content size so the main process hugs the window to the
	// card and re-anchors it above the chip (the breakdown's height varies with
	// how many engines are loaded).
	useEffect(() => {
		const el = containerRef.current;
		if (!el) {
			return;
		}
		const report = () => {
			const r = el.getBoundingClientRect();
			windowResizeNamed("model-footprint", r.width, r.height);
		};
		const observer = new ResizeObserver(report);
		observer.observe(el);
		report();
		return () => observer.disconnect();
	}, []);

	const displayName = isGpu ? (gpuInfo[0]?.name ?? "GPU") : "CPU";
	const sentence = isGpu
		? t("gpuTooltip", { name: displayName })
		: t("cpuTooltip", { name: displayName });

	return (
		<div className="flex h-screen w-screen items-end overflow-hidden">
			<div
				className={cn(
					"max-h-screen w-full overflow-y-auto rounded-md px-2.5 py-2 font-sans",
					surfaceClasses(PANEL_LEVEL, PANEL_SHADOW_LEVEL),
				)}
				ref={containerRef}
			>
				<GpuModelBreakdown
					sections={sections}
					t={t}
					usage={buildBreakdownUsage(liveResources, isGpu)}
				/>
				<span className="mt-1.5 block border-divider-strong border-t pt-1.5 text-[10.5px] text-foreground-muted leading-[14px]">
					{sentence}
				</span>
			</div>
		</div>
	);
}
