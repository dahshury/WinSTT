import { useEffect, useLayoutEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands, type SttRecordingSnapshot } from "@/bindings";
import { useTranscriptionStore } from "@/entities/transcription";
import { useVisualizerStore } from "@/features/audio-visualizer";
import { useLlmProcessingStore } from "@/features/llm-processing";
import {
	acknowledgeOverlayHideTransition,
	setOverlayHitRegions,
	type OverlayHitRect,
} from "@/shared/api/ipc/overlay";
import { ipcOnReady } from "@/shared/api/native-boundary";
import { NATIVE_EVENTS } from "@/shared/api/native-events";
import { hasTauriRuntime } from "@/shared/lib/tauri-runtime";

/**
 * Apply Rust's retained lifecycle truth after the overlay has installed its
 * event listeners. Positive state is reconciled; an idle snapshot is ignored
 * because a newer start event may already be queued behind the invoke reply.
 */
export function reconcileOverlayRecordingSnapshot(
	snapshot: SttRecordingSnapshot,
	options?: { requireActiveRecording?: boolean },
): void {
	if (!snapshot.pipelineActive) {
		return;
	}
	// Post-terminal-event reconciles only act when a NEWER recording is already
	// live (quick re-press): re-arming on a merely-active pipeline would flash
	// the transcribing pill back after a session completed normally (the paste
	// epilogue keeps the pipeline active for a moment after full_sentence).
	if (options?.requireActiveRecording && !snapshot.isRecording) {
		return;
	}

	let transcription = useTranscriptionStore.getState();
	if (!transcription.isRecordingActive) {
		transcription.beginRecordingSession();
		transcription = useTranscriptionStore.getState();
	}
	if (snapshot.speechSeen) {
		transcription.setSpeechDetected(true);
	}

	const visualizer = useVisualizerStore.getState();
	if (snapshot.isRecording) {
		if (!visualizer.isRecording) {
			visualizer.recordingStarted();
		}
		useVisualizerStore.getState().setSpeaking(snapshot.isSpeaking);
		return;
	}

	visualizer.recordingStopped();
	if (snapshot.speechSeen) {
		transcription.setTranscribing(true, "transcribing");
	}
}

let overlayLifecycleEpoch = 0;

const OVERLAY_LIFECYCLE_EVENTS = [
	NATIVE_EVENTS.STT_RECORDING_START,
	NATIVE_EVENTS.STT_RECORDING_STOP,
	NATIVE_EVENTS.STT_VAD_START,
	NATIVE_EVENTS.STT_VAD_STOP,
	NATIVE_EVENTS.STT_TRANSCRIPTION_START,
	NATIVE_EVENTS.STT_FULL_SENTENCE,
	NATIVE_EVENTS.STT_NO_AUDIO_DETECTED,
	NATIVE_EVENTS.STT_TRANSCRIPTION_FAILED,
	NATIVE_EVENTS.STT_SESSION_ABORTED,
	NATIVE_EVENTS.STT_PIPELINE_UNAVAILABLE,
] as const;

// Terminal events can belong to the PREVIOUS session while a newer recording is
// already live (quick re-press before the old final decode/LLM cleanup landed).
// Their feed handlers disarm `isRecordingActive`, which would kill the pill in
// the middle of the new take — so after they settle, read Rust's retained truth
// back and re-arm if a recording is genuinely in progress.
const OVERLAY_TERMINAL_EVENTS: ReadonlySet<string> = new Set<string>([
	NATIVE_EVENTS.STT_FULL_SENTENCE,
	NATIVE_EVENTS.STT_NO_AUDIO_DETECTED,
	NATIVE_EVENTS.STT_TRANSCRIPTION_FAILED,
	NATIVE_EVENTS.STT_SESSION_ABORTED,
]);

async function reconcileOverlayRecordingState(
	observedEpoch = overlayLifecycleEpoch,
	options?: { requireActiveRecording?: boolean },
): Promise<void> {
	if (!hasTauriRuntime()) {
		return;
	}
	try {
		const snapshot = await commands.sttRecordingSnapshot();
		// Some browser/test bridge shims acknowledge unknown commands with
		// `undefined`; a real generated Tauri invocation always returns the DTO.
		if (snapshot && observedEpoch === overlayLifecycleEpoch) {
			reconcileOverlayRecordingSnapshot(snapshot, options);
		}
	} catch (error) {
		console.warn("[overlay] Failed to reconcile recording state:", error);
	}
}

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
 * `true` can't flash content because the session's retained speech flag,
 * `isSpeaking`, and `hasText` are cleared right here. Rust's retained snapshot
 * is then read back so a real onset that raced ahead of this reset is restored.
 */
export function useResetOnOverlayShow(): void {
	useEffect(() => {
		let disposed = false;
		let lifecycleCleanups: Array<() => void> = [];
		const handler = () => {
			if (document.visibilityState !== "visible") {
				return;
			}
			useTranscriptionStore.setState({
				currentRealtime: "",
				ephemeral: null,
				hasDetectedSpeech: false,
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
			void reconcileOverlayRecordingState(overlayLifecycleEpoch);
		};
		document.addEventListener("visibilitychange", handler);
		void Promise.allSettled(
			OVERLAY_LIFECYCLE_EVENTS.map((eventName) =>
				ipcOnReady(eventName, () => {
					overlayLifecycleEpoch += 1;
					if (!OVERLAY_TERMINAL_EVENTS.has(eventName)) {
						return;
					}
					// Run after every synchronous handler of this event (the feed's
					// disarm included) so the snapshot reconciles the settled state.
					// Captured post-bump: a later lifecycle event supersedes this
					// reconcile via the epoch check inside.
					const epoch = overlayLifecycleEpoch;
					setTimeout(() => {
						void reconcileOverlayRecordingState(epoch, {
							requireActiveRecording: true,
						});
					}, 0);
				}),
			),
		).then((results) => {
			const cleanups = results.flatMap((result) =>
				result.status === "fulfilled" ? [result.value] : [],
			);
			for (const result of results) {
				if (result.status === "rejected") {
					console.warn(
						"[overlay] Failed to install a lifecycle reconciliation listener:",
						result.reason,
					);
				}
			}
			if (disposed) {
				for (const cleanup of cleanups) {
					cleanup();
				}
				return;
			}
			lifecycleCleanups = cleanups;
			// A lazily-created overlay can finish mounting after the window is already
			// visible. Subscribe first, then reconcile so terminal events cannot be
			// overwritten by an older in-flight snapshot.
			void reconcileOverlayRecordingState(overlayLifecycleEpoch);
		});
		return () => {
			disposed = true;
			document.removeEventListener("visibilitychange", handler);
			for (const cleanup of lifecycleCleanups) {
				cleanup();
			}
		};
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
		let pendingHideGeneration: string | null = null;
		let unlistenHide: (() => void) | null = null;
		const acknowledgeHideIfExited = (rects: OverlayHitRect[]) => {
			if (rects.length !== 0 || pendingHideGeneration === null) {
				return;
			}
			const generation = pendingHideGeneration;
			pendingHideGeneration = null;
			void acknowledgeOverlayHideTransition(generation).catch(() => {
				// Rust retains one bounded fallback timeout for a renderer that dies
				// or loses IPC while its exit transition is in flight.
			});
		};
		const sendRegions = (rects: OverlayHitRect[]) => {
			acknowledgeHideIfExited(rects);
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

		if (hasTauriRuntime()) {
			void listen<string>(NATIVE_EVENTS.OVERLAY_HIDE, (event) => {
				pendingHideGeneration = event.payload;
				// Measure on the next renderer frame, after React/Motion has applied
				// the terminal state. Mutation/resize callbacks continue measuring
				// until the last painted hit region actually disappears.
				schedule();
			})
				.then((unlisten) => {
					if (disposed) {
						unlisten();
					} else {
						unlistenHide = unlisten;
					}
				})
				.catch(() => {
					// A failed subscription follows the same bounded Rust fallback path.
				});
		}

		return () => {
			disposed = true;
			unlistenHide?.();
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
