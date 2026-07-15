import { useEffect, useRef } from "react";
import { useTranslations } from "use-intl";
import { useConnectionStore, useGpuInfo } from "@/entities/connection";
import {
	snapshotPatch,
	useSystemResourcesStore,
} from "@/entities/system-resources";
import {
	buildBreakdownUsage,
	GpuModelBreakdown,
	useConnectionListener,
	useRuntimeModelBreakdown,
} from "@/features/connect-server";
import { useDownloadListener } from "@/features/model-download";
import { useSyncSettings } from "@/features/update-settings";
import type { LiveResourcesEntry } from "@/shared/api/ipc-client";
import { ipcOn, windowResizeNamed } from "@/shared/api/ipc-client";
import { NATIVE_EVENTS } from "@/shared/api/native-events";
import { cn } from "@/shared/lib/cn";
import { surfaceClasses } from "@/shared/lib/surface";
import { resolveFootprintContentSize } from "../lib/footprint-size";

const PANEL_LEVEL = 5;
const PANEL_SHADOW_LEVEL = 3;

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

	// Prehydrate the hidden, prewarmed renderer once. This gives its intrinsic
	// measurement the same header/bar structure as the visible panel; the fresh
	// opening event below only replaces values, so it cannot grow and re-anchor
	// the native window after the user is already looking at it.
	useEffect(() => {
		void refreshLive(true);
	}, [refreshLive]);

	// The backend samples resources and emits them to this prewarmed renderer
	// immediately BEFORE showing the native hover window. Hydrating the store
	// here makes the first visible frame authoritative instead of painting the
	// hidden window's older sample and correcting it after hover.
	useEffect(
		() =>
			ipcOn(NATIVE_EVENTS.MODEL_FOOTPRINT_RESOURCES, (payload) => {
				useSystemResourcesStore.setState(
					snapshotPatch(payload as LiveResourcesEntry),
				);
			}),
		[],
	);

	// Report the live content size so the main process hugs the window to the
	// card and re-anchors it above the chip (the breakdown's height varies with
	// how many engines are loaded).
	useEffect(() => {
		const el = containerRef.current;
		if (!el) {
			return;
		}
		let lastWidth = 0;
		let lastHeight = 0;
		const report = () => {
			const r = el.getBoundingClientRect();
			// `max-h-screen` caps the visible box to the CURRENT native window.
			// scrollHeight is the uncropped content height the native window needs.
			const { width, height } = resolveFootprintContentSize({
				boxHeight: r.height,
				scrollHeight: el.scrollHeight,
			});
			if (width === lastWidth && height === lastHeight) {
				return;
			}
			lastWidth = width;
			lastHeight = height;
			windowResizeNamed("model-footprint", width, height);
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
		<div className="flex h-screen w-screen items-end overflow-hidden p-1.5">
			<div
				className={cn(
					"max-h-full w-[280px] max-w-full overflow-y-auto rounded-md px-2.5 py-2 font-sans",
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
