import { useEffect, useRef, useState } from "react";
import { commands } from "@/bindings";
import { NATIVE_EVENTS as IPC } from "@/shared/api/native-events";
import { ipcOn } from "@/shared/api/ipc-client";
import {
	DEFAULT_MODEL_PICKER_MODE,
	DESIRED_HEIGHT,
	DESIRED_WIDTH,
	desiredSizeForMode,
	type DetachedModelPickerMode,
	MODEL_PICKER_CLOSE_MS,
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
	/** Bumps every time the panel fully closes. The host folds this into the
	 *  picker-body `key` so the warm-mounted (never-unmounting) body is remounted
	 *  while hidden — clearing transient in-picker UI like the search query so the
	 *  next open (any mode) never inherits a stale filter. See the host. */
	openGeneration: number;
}

/**
 * Owns the detached-window panel positioning state machine: panel/panelPhase
 * state + refs, the MODEL_PICKER_ANCHOR / MODEL_PICKER_CLOSING IPC effects, the
 * generation-guarded close timer, the one-shot MODEL_PICKER_RESIZE send, and the
 * derived reveal / warmPanel / dropdownStateClass values the host renders.
 */
export function usePanelRect(catalogLoaded: boolean): PanelRectState {
	// Main reports where to draw the panel inside the full-screen window
	// (recomputed on every open and on resize, so it always reflects the
	// current chip position / clamped height).
	const [panel, setPanelState] = useState<PanelRect | null>(null);
	const [panelPhase, setPanelPhaseState] = useState<PanelPhase>("hidden");
	// Bumped on every full close so the host can remount the warm picker body
	// (while hidden) and reset its transient search query. Distinct from
	// `openGenerationRef` below, which bumps on OPEN to guard the close timer.
	const [bodyGeneration, setBodyGenerationState] = useState(0);
	const panelRef = useRef<PanelRect | null>(null);
	const panelPhaseRef = useRef<PanelPhase>("hidden");
	const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const revealRafRef = useRef<number | null>(null);
	const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const openGenerationRef = useRef(0);
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
	const [clearCloseTimer] = useState(() => () => {
		if (closeTimerRef.current !== null) {
			clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
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
	useEffect(
		() => () => {
			clearCloseTimer();
			clearRevealWait();
		},
		[clearCloseTimer, clearRevealWait],
	);
	// A real rect positions + reveals. Legacy/null anchors can still arrive from
	// an older hidden-window close path; ignore them once a fresh open is active
	// so a stale close cannot blank the panel while the backdrop is visible.
	useEffect(
		() =>
			ipcOn(IPC.MODEL_PICKER_ANCHOR, (rect) => {
				if (rect) {
					const payload = rect as PanelRect & { mode?: unknown };
					openGenerationRef.current += 1;
					clearCloseTimer();
					setPanel({
						...payload,
						mode: normalizeDetachedModelPickerMode(payload.mode),
					});
					// Already revealed (repair/re-anchor or a duplicate re-emit):
					// just track the rect — re-gating would restart the animation.
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
				clearCloseTimer();
				clearRevealWait();
				setPanel(null);
				setPanelPhase("hidden");
				bumpBodyGeneration();
			}),
		[
			clearCloseTimer,
			clearRevealWait,
			scheduleReveal,
			setPanel,
			setPanelPhase,
			bumpBodyGeneration,
		],
	);
	useEffect(() => {
		const unsubscribe = ipcOn(IPC.MODEL_PICKER_CLOSING, () => {
			if (panelRef.current === null) {
				return;
			}
			// Closed before the reveal gate fired: the panel was never visible,
			// so playing the out-animation would flash it in. Drop straight to
			// hidden instead.
			if (panelPhaseRef.current === "pre-open") {
				clearRevealWait();
				setPanel(null);
				setPanelPhase("hidden");
				bumpBodyGeneration();
				return;
			}
			const closeGeneration = openGenerationRef.current;
			clearCloseTimer();
			setPanelPhase("closing");
			closeTimerRef.current = setTimeout(() => {
				closeTimerRef.current = null;
				if (
					openGenerationRef.current !== closeGeneration ||
					panelPhaseRef.current !== "closing"
				) {
					return;
				}
				setPanel(null);
				setPanelPhase("hidden");
				bumpBodyGeneration();
			}, MODEL_PICKER_CLOSE_MS);
		});
		return () => {
			clearCloseTimer();
			unsubscribe();
		};
	}, [
		clearCloseTimer,
		clearRevealWait,
		setPanel,
		setPanelPhase,
		bumpBodyGeneration,
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
		openGeneration: bodyGeneration,
	};
}
