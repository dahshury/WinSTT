import type {
	MouseEvent as ReactMouseEvent,
	PointerEvent as ReactPointerEvent,
} from "react";
import { useEffect, useRef, useState } from "react";
import {
	type ActivePointer,
	capturePointer,
	clearTimeoutRef,
	pointerAllowed,
	pointerMovedPastTolerance,
	TOUCH_POINTER_TYPES,
} from "./pointer-gesture";

const DEFAULT_DELAY_MS = 520;
const DEFAULT_MOVE_TOLERANCE_PX = 10;
const CONTEXT_MENU_SUPPRESS_MS = 750;

interface UseLongPressOptions {
	delay?: number;
	disabled?: boolean;
	moveTolerance?: number;
	pointerTypes?: readonly string[];
}

interface UseLongPressResult {
	handlers: {
		onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
		onPointerCancel: () => void;
		onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
		onPointerLeave: () => void;
		onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
		onPointerUp: () => void;
	};
	pressing: boolean;
}

export function useLongPress(
	onLongPress: () => void,
	{
		delay = DEFAULT_DELAY_MS,
		disabled = false,
		moveTolerance = DEFAULT_MOVE_TOLERANCE_PX,
		pointerTypes = TOUCH_POINTER_TYPES,
	}: UseLongPressOptions = {},
): UseLongPressResult {
	const [pressing, setPressing] = useState(false);
	const activePointerRef = useRef<ActivePointer | null>(null);
	const onLongPressRef = useRef(onLongPress);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const contextMenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	const suppressContextMenuRef = useRef(false);

	useEffect(() => {
		onLongPressRef.current = onLongPress;
	}, [onLongPress]);

	const clearTimer = () => {
		clearTimeoutRef(timerRef);
	};

	const cancel = () => {
		clearTimer();
		activePointerRef.current = null;
		setPressing(false);
	};

	const suppressNextContextMenu = () => {
		suppressContextMenuRef.current = true;
		clearTimeoutRef(contextMenuTimerRef);
		contextMenuTimerRef.current = setTimeout(() => {
			suppressContextMenuRef.current = false;
			contextMenuTimerRef.current = null;
		}, CONTEXT_MENU_SUPPRESS_MS);
	};

	useEffect(
		// Unmount-only cleanup. Touches refs only, so it carries no deps — referencing
		// the per-render `clearTimer` here would re-run (and tear down the pending
		// long-press timer) on every render once the manual memoization is gone.
		() => () => {
			clearTimeoutRef(timerRef);
			clearTimeoutRef(contextMenuTimerRef);
		},
		[],
	);

	const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
		if (!pointerAllowed(event, disabled, pointerTypes) || event.button !== 0) {
			return;
		}
		clearTimer();
		activePointerRef.current = capturePointer(event);
		setPressing(true);
		timerRef.current = setTimeout(() => {
			timerRef.current = null;
			activePointerRef.current = null;
			setPressing(false);
			suppressNextContextMenu();
			onLongPressRef.current();
		}, delay);
	};

	const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
		const activePointer = activePointerRef.current;
		if (!activePointer || activePointer.id !== event.pointerId) {
			return;
		}
		if (pointerMovedPastTolerance(activePointer, event, moveTolerance)) {
			cancel();
		}
	};

	const onContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
		if (!suppressContextMenuRef.current) {
			return;
		}
		event.preventDefault();
		suppressContextMenuRef.current = false;
		clearTimeoutRef(contextMenuTimerRef);
	};

	const handlers = {
		onContextMenu,
		onPointerCancel: cancel,
		onPointerDown,
		onPointerLeave: cancel,
		onPointerMove,
		onPointerUp: cancel,
	};

	return { handlers, pressing };
}
