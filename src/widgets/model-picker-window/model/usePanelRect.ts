import { useEffect, useRef, useState } from "react";
import { commands } from "@/bindings";
import { NATIVE_EVENTS as IPC } from "@/shared/api/native-events";
import { ipcOnReady } from "@/shared/api/ipc-client";
import {
	DEFAULT_MODEL_PICKER_MODE,
	DESIRED_HEIGHT,
	DESIRED_WIDTH,
	desiredSizeForMode,
	type DetachedModelPickerMode,
	normalizeDetachedModelPickerMode,
	type PanelPhase,
	type PanelRect,
} from "../lib/picker-helpers";

interface PanelRectState {
	panel: PanelRect | null;
	mode: DetachedModelPickerMode;
	panelPhase: PanelPhase;
	panelRevealed: boolean;
	panelInteractive: boolean;
	warmPanel: PanelRect;
	shouldMountBody: boolean;
	dropdownStateClass: string;
	completeCloseTransition: () => void;
	/** Bumps every time the panel fully closes. The host folds this into the
	 *  picker-body `key` so the warm-mounted (never-unmounting) body is remounted
	 *  while hidden — clearing transient in-picker UI like the search query so the
	 *  next open (any mode) never inherits a stale filter. See the host. */
	openGeneration: number;
}

/**
 * Owns the detached-window panel positioning state machine: panel/panelPhase
 * state + refs, the MODEL_PICKER_ANCHOR / MODEL_PICKER_CLOSING IPC effects, the
 * renderer-ready anchor handshake, close-animation acknowledgement, the one-shot
 * MODEL_PICKER_RESIZE send, and the derived panel values the host renders.
 */
export function usePanelRect(catalogLoaded: boolean): PanelRectState {
	// Main reports where to draw the panel inside the full-screen window
	// (recomputed on every open and on resize, so it always reflects the
	// current chip position / clamped height).
	const [panel, setPanelState] = useState<PanelRect | null>(null);
	const [panelPhase, setPanelPhaseState] = useState<PanelPhase>("hidden");
	// Bumped on every full close so the host can remount the warm picker body
	// (while hidden) and reset its transient search query.
	const [bodyGeneration, setBodyGenerationState] = useState(0);
	const panelRef = useRef<PanelRect | null>(null);
	const panelPhaseRef = useRef<PanelPhase>("hidden");
	const closeSequenceRef = useRef<number | null>(null);
	const revealRafRef = useRef<number | null>(null);
	const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [bumpBodyGeneration] = useState(
		() => () => setBodyGenerationState((generation) => generation + 1),
	);
	const [setPanel] = useState(() => (next: PanelRect | null) => {
		panelRef.current = next;
		setPanelState(next);
	});
	const [setPanelPhase] = useState(() => (next: PanelPhase) => {
		panelPhaseRef.current = next;
		setPanelPhaseState(next);
	});
	const [clearRevealWait] = useState(() => () => {
		if (revealRafRef.current !== null) {
			cancelAnimationFrame(revealRafRef.current);
			revealRafRef.current = null;
		}
		if (revealTimerRef.current !== null) {
			clearTimeout(revealTimerRef.current);
			revealTimerRef.current = null;
		}
	});
	// Reveal gate: hold the panel in `pre-open` (positioned, still at its
	// pre-animation state) until the compositor has painted a frame at the new
	// anchor — two rAF ticks after the commit. rAF only fires once WebView2 has
	// actually resumed rendering the just-shown window, so this (a) guarantees
	// the 250ms open animation is rendered from its first frame instead of
	// elapsing invisibly during the show-resume lag, and (b) ensures a
	// transparent-backdrop frame replaces any stale frame WebView2 re-presents
	// from the previous open (which sat at a DIFFERENT trigger's position).
	// The timeout is a safety net: if rAF never fires, reveal anyway.
	const [scheduleReveal] = useState(() => (reveal: () => void) => {
		revealRafRef.current = requestAnimationFrame(() => {
			revealRafRef.current = requestAnimationFrame(() => {
				revealRafRef.current = null;
				reveal();
			});
		});
		revealTimerRef.current = setTimeout(reveal, 400);
	});
	useEffect(() => () => clearRevealWait(), [clearRevealWait]);
	const [completeCloseTransition] = useState(() => () => {
		const sequence = closeSequenceRef.current;
		if (sequence === null) {
			return;
		}
		closeSequenceRef.current = null;
		clearRevealWait();
		if (panelRef.current !== null || panelPhaseRef.current !== "hidden") {
			setPanel(null);
			setPanelPhase("hidden");
			bumpBodyGeneration();
		}
		void commands.windowModelPickerCloseComplete(sequence);
	});

	useEffect(() => {
		let disposed = false;
		let unsubscribeAnchor: () => void = () => undefined;
		let unsubscribeClosing: () => void = () => undefined;

		const installLifecycleSubscriptions = async () => {
			const anchorSubscription = ipcOnReady(IPC.MODEL_PICKER_ANCHOR, (rect) => {
				if (rect) {
					const payload = rect as PanelRect & { mode?: unknown };
					closeSequenceRef.current = null;
					setPanel({
						...payload,
						mode: normalizeDetachedModelPickerMode(payload.mode),
					});
					// Already revealed (repair/re-anchor): just track the latest rect.
					if (
						panelPhaseRef.current === "open" ||
						panelPhaseRef.current === "pre-open"
					) {
						return;
					}
					setPanelPhase("pre-open");
					clearRevealWait();
					scheduleReveal(() => {
						clearRevealWait();
						if (panelPhaseRef.current === "pre-open") {
							setPanelPhase("open");
						}
					});
					return;
				}
				if (
					panelPhaseRef.current === "open" ||
					panelPhaseRef.current === "pre-open"
				) {
					return;
				}
				clearRevealWait();
				setPanel(null);
				setPanelPhase("hidden");
				bumpBodyGeneration();
			});
			const closingSubscription = ipcOnReady(
				IPC.MODEL_PICKER_CLOSING,
				(rawSequence) => {
					if (typeof rawSequence !== "number") {
						return;
					}
					closeSequenceRef.current = rawSequence;
					// If the panel never revealed, there is no exit animation to await.
					if (
						panelRef.current === null ||
						panelPhaseRef.current === "pre-open"
					) {
						completeCloseTransition();
						return;
					}
					setPanelPhase("closing");
				},
			);
			let cleanups: [() => void, () => void];
			try {
				cleanups = await Promise.all([anchorSubscription, closingSubscription]);
			} catch (error) {
				// If only one native registration failed, tear down the other one
				// when it resolves rather than leaking a half-installed lifecycle.
				void anchorSubscription
					.then((cleanup) => cleanup())
					.catch(() => undefined);
				void closingSubscription
					.then((cleanup) => cleanup())
					.catch(() => undefined);
				throw error;
			}
			const [anchorCleanup, closingCleanup] = cleanups;
			if (disposed) {
				anchorCleanup();
				closingCleanup();
				return;
			}
			unsubscribeAnchor = anchorCleanup;
			unsubscribeClosing = closingCleanup;
			// Listener installation is the only prerequisite for the snapshot.
			// Do not gate this acknowledgement on requestAnimationFrame: a freshly
			// created or native-hidden WebView can throttle rAF, which would make the
			// anchor wait for a frame while the frame waits for an anchor to render.
			// The anchor callback's separate reveal gate still waits for paint.
			if (!disposed) {
				void commands.windowModelPickerReady();
			}
		};

		void installLifecycleSubscriptions().catch((error) => {
			unsubscribeAnchor();
			console.warn("[model-picker] lifecycle subscription failed:", error);
		});

		return () => {
			disposed = true;
			unsubscribeAnchor();
			unsubscribeClosing();
		};
	}, [
		bumpBodyGeneration,
		clearRevealWait,
		completeCloseTransition,
		scheduleReveal,
		setPanel,
		setPanelPhase,
	]);

	const mode = panel?.mode ?? DEFAULT_MODEL_PICKER_MODE;
	const { height: desiredHeight, width: desiredWidth } =
		desiredSizeForMode(mode);

	// Report the desired footprint for the active picker body. Main clamps it to
	// the room around the chip and sends back the final panel rect via
	// MODEL_PICKER_ANCHOR. Only sent while a panel is actually up: `open_window`
	// seeds the per-kind size itself, and the close-reset reverts `mode` to the
	// default — firing this from the hidden/closing states made Rust re-place
	// (and re-SHOW) the still-visible window during the close grace, so every
	// close of a non-default-size picker (LLM) immediately reopened it.
	useEffect(() => {
		if (
			panelPhaseRef.current !== "open" &&
			panelPhaseRef.current !== "pre-open"
		) {
			return;
		}
		void commands.resizeWindow("model-picker", desiredWidth, desiredHeight);
	}, [desiredHeight, desiredWidth]);

	// Pre-warm the (heavy) picker body during the window's idle pre-create
	// rather than on first open. The detached picker window is created hidden +
	// parked off-screen at app startup, but `PickerBody` — a force-open inline
	// combobox that mounts EVERY model card — used to be gated entirely behind
	// `panel`, which the main process only sends on the first open. So the
	// expensive first mount (Base UI's collection build + the full grouped-list
	// layout) landed during the 150ms open fade and the user saw it lag.
	//
	// Mount it as soon as the catalog has hydrated (which happens in the
	// background a beat after launch), laid out at the default footprint and held
	// invisible (`opacity: 0`, `pointer-events: none`) until the real anchor
	// lands. The window stays parked off-screen the whole time, so this warm
	// render is never visible; the first real open then just repositions an
	// already-warm tree (a cheap re-render) instead of mounting the whole picker.
	const panelRevealed = panel !== null;
	const panelInteractive = panelRevealed && panelPhase === "open";
	const warmPanel = panel ?? {
		x: 0,
		y: 0,
		width: DESIRED_WIDTH,
		height: DESIRED_HEIGHT,
		origin: "bottom-right",
		mode,
	};
	const shouldMountBody = panelRevealed || catalogLoaded;
	// `pre-open` keeps the base (pre-animation) class: positioned but invisible
	// until the reveal gate confirms a composited frame at the new anchor.
	const dropdownStateClass =
		panelPhase === "closing"
			? "is-closing"
			: panelPhase === "open"
				? "is-open"
				: "";

	return {
		panel,
		mode,
		panelPhase,
		panelRevealed,
		panelInteractive,
		warmPanel,
		shouldMountBody,
		dropdownStateClass,
		completeCloseTransition,
		openGeneration: bodyGeneration,
	};
}
