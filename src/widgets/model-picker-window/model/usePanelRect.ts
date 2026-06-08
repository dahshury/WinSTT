import { useCallback, useEffect, useRef, useState } from "react";
import { IPC } from "@/shared/api/ipc-channels";
import { ipcOn, ipcSend } from "@/shared/api/ipc-client";
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
	const panelRef = useRef<PanelRect | null>(null);
	const panelPhaseRef = useRef<PanelPhase>("hidden");
	const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const openGenerationRef = useRef(0);
	const setPanel = useCallback((next: PanelRect | null) => {
		panelRef.current = next;
		setPanelState(next);
	}, []);
	const setPanelPhase = useCallback((next: PanelPhase) => {
		panelPhaseRef.current = next;
		setPanelPhaseState(next);
	}, []);
	const clearCloseTimer = useCallback(() => {
		if (closeTimerRef.current !== null) {
			clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	}, []);
	useEffect(() => clearCloseTimer, [clearCloseTimer]);
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
					setPanelPhase("open");
					return;
				}
				if (panelPhaseRef.current === "open") {
					return;
				}
				clearCloseTimer();
				setPanel(null);
				setPanelPhase("hidden");
			}),
		[clearCloseTimer, setPanel, setPanelPhase],
	);
	useEffect(
		() =>
			ipcOn(IPC.MODEL_PICKER_CLOSING, () => {
				if (panelRef.current !== null) {
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
					}, MODEL_PICKER_CLOSE_MS);
				}
			}),
		[clearCloseTimer, setPanel, setPanelPhase],
	);

	const mode = panel?.mode ?? DEFAULT_MODEL_PICKER_MODE;

	// Report the desired footprint for the active picker body. Main clamps it to
	// the room around the chip and sends back the final panel rect via
	// MODEL_PICKER_ANCHOR.
	useEffect(() => {
		ipcSend(IPC.MODEL_PICKER_RESIZE, desiredSizeForMode(mode));
	}, [mode]);

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
	const dropdownStateClass =
		panelPhase === "closing" ? "is-closing" : panelRevealed ? "is-open" : "";

	return {
		panel,
		mode,
		panelPhase,
		panelRevealed,
		panelInteractive,
		warmPanel,
		shouldMountBody,
		dropdownStateClass,
	};
}
