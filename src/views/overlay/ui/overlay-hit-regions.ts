import { useEffect, useLayoutEffect, useRef } from "react";
import { useTranscriptionStore } from "@/entities/transcription";
import { useVisualizerStore } from "@/features/audio-visualizer";
import { useLlmProcessingStore } from "@/features/llm-processing";
import {
	setOverlayHitRegions,
	type OverlayHitRect,
} from "@/shared/api/ipc/overlay";

/**
 * Clear the stale CONTENT the pill reads from the moment the overlay
 * BrowserWindow becomes visible — before the renderer's first post-show paint.
 *
 * Why this is needed in addition to the IPC-driven clear in
 * `useTranscriptionFeed` (which runs on STT_RECORDING_START): the IPC is
 * asynchronous, so on a "press → release → wait → press again" cycle the
 * renderer can paint at least one frame with the previous session's
 * `currentRealtime` / `ephemeral` text before the start event lands. The
 * `visibilitychange` event, by contrast, fires synchronously on the renderer's
 * main thread when Chromium sees the BrowserWindow transition to visible, and
 * a synchronous Zustand `setState` here is guaranteed to be applied before any
 * paint can run, so the very first frame after the window appears is empty.
 *
 * `isRecordingActive` is deliberately NOT reset here. The main process sends
 * STT_RECORDING_START *before* it calls `showOverlay()` (see
 * `runAdmittedRecordingStart`), so the renderer
 * almost always processes that arming IPC — setting `isRecordingActive = true`
 * — BEFORE the OS delivers `visibilitychange` (which is gated on a compositor
 * pass). Resetting the flag to `false` here therefore clobbered the
 * freshly-armed value, and because realtime-text events only update the text
 * (they never re-arm), the pill's mount gate
 * `(isRecordingActive && (isSpeaking || hasText))` stayed `false` for the whole
 * session — the pill "didn't appear on first use". The transcription feed owns
 * the flag (armed on recording_start, disarmed on terminal events, already
 * `false` between sessions), so leaving it alone removes the race; a stale
 * `true` can't flash content because `isSpeaking` (above) + `hasText` are both
 * cleared right here.
 */
export function useResetOnOverlayShow(): void {
	useEffect(() => {
		const handler = () => {
			if (document.visibilityState !== "visible") {
				return;
			}
			useTranscriptionStore.setState({
				currentRealtime: "",
				ephemeral: null,
				isTranscribing: false,
				processingPhase: null,
				transcribingStartedAt: null,
			});
			useLlmProcessingStore.setState({
				isThinking: false,
				isTransforming: false,
				transformStartedAt: null,
			});
			// Belt-and-suspenders: `recordingStopped` in the visualizer
			// store already clears `isSpeaking`, but if a session ended
			// abnormally (connection drop, app crash recovery) a stale
			// `true` here would flash the pill the moment the overlay
			// re-appears.
			useVisualizerStore.setState({ isSpeaking: false });
		};
		document.addEventListener("visibilitychange", handler);
		return () => document.removeEventListener("visibilitychange", handler);
	}, []);
}

/**
 * The overlay BrowserWindow is created with `transparent: true` so the
 * pill floats over other apps without a rectangular backdrop. globals.css
 * applies `body { background: var(--color-surface) }` for every renderer
 * route, which on the overlay route fills the whole window with a solid
 * dark rectangle. Scope the override here so the body becomes transparent
 * only while OverlayPage is mounted (cleanup restores the global default,
 * in case the renderer ever client-navigates away from /overlay).
 */
export function useTransparentBody(): void {
	useLayoutEffect(() => {
		const prevBody = document.body.style.background;
		const prevHtml = document.documentElement.style.background;
		Object.assign(document.body.style, { background: "transparent" });
		Object.assign(document.documentElement.style, {
			background: "transparent",
		});
		return () => {
			Object.assign(document.body.style, { background: prevBody });
			Object.assign(document.documentElement.style, { background: prevHtml });
		};
	}, []);
}

const OVERLAY_HIT_REGION_SELECTOR = "[data-overlay-hit-region='true']";
const OVERLAY_HIT_REGION_MARGIN_PX = 6;

function roundedRegionValue(value: number): number {
	return Math.round(value * 10) / 10;
}

function elementCanReceiveHitRegion(element: Element): boolean {
	const style = window.getComputedStyle(element);
	return (
		style.display !== "none" &&
		style.visibility !== "hidden" &&
		style.pointerEvents !== "none" &&
		Number(style.opacity) > 0.02
	);
}

function rectToHitRegion(rect: DOMRect): OverlayHitRect | null {
	if (rect.width < 1 || rect.height < 1) {
		return null;
	}
	const margin = OVERLAY_HIT_REGION_MARGIN_PX;
	return {
		x: roundedRegionValue(Math.max(0, rect.left - margin)),
		y: roundedRegionValue(Math.max(0, rect.top - margin)),
		width: roundedRegionValue(rect.width + margin * 2),
		height: roundedRegionValue(rect.height + margin * 2),
	};
}

function collectOverlayHitRegions(): OverlayHitRect[] {
	const regions: OverlayHitRect[] = [];
	for (const element of document.querySelectorAll(
		OVERLAY_HIT_REGION_SELECTOR,
	)) {
		if (!elementCanReceiveHitRegion(element)) {
			continue;
		}
		const region = rectToHitRegion(element.getBoundingClientRect());
		if (region) {
			regions.push(region);
		}
	}
	return regions;
}

export function useOverlayNativeHitRegions(): void {
	const lastPayloadRef = useRef("");

	useEffect(() => {
		let raf = 0;
		let disposed = false;
		const sendRegions = (rects: OverlayHitRect[]) => {
			const payload = JSON.stringify(rects);
			if (payload === lastPayloadRef.current) {
				return;
			}
			lastPayloadRef.current = payload;
			void setOverlayHitRegions(rects).catch(() => {
				// Outside Tauri/test contexts this command is unavailable. The native
				// lifecycle still restores click-through on hide; ignore transient misses.
			});
		};
		const measureAndSend = () => {
			raf = 0;
			if (!disposed) {
				sendRegions(collectOverlayHitRegions());
			}
		};
		const schedule = () => {
			if (raf === 0) {
				raf = requestAnimationFrame(measureAndSend);
			}
		};

		const resizeObserver =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(schedule);
		const observeSurfaces = () => {
			resizeObserver?.disconnect();
			for (const element of document.querySelectorAll(
				OVERLAY_HIT_REGION_SELECTOR,
			)) {
				resizeObserver?.observe(element);
			}
			schedule();
		};
		const mutationObserver = new MutationObserver(observeSurfaces);
		mutationObserver.observe(document.body, {
			attributes: true,
			attributeFilter: ["class", "style", "data-overlay-hit-region"],
			childList: true,
			subtree: true,
		});
		window.addEventListener("resize", schedule);
		observeSurfaces();

		return () => {
			disposed = true;
			if (raf !== 0) {
				cancelAnimationFrame(raf);
			}
			resizeObserver?.disconnect();
			mutationObserver.disconnect();
			window.removeEventListener("resize", schedule);
			sendRegions([]);
		};
	}, []);
}
