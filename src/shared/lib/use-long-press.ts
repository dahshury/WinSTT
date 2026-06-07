import type {
	MouseEvent as ReactMouseEvent,
	PointerEvent as ReactPointerEvent,
} from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const DEFAULT_POINTER_TYPES = ["touch", "pen"] as const;
const DEFAULT_DELAY_MS = 520;
const DEFAULT_MOVE_TOLERANCE_PX = 10;
const CONTEXT_MENU_SUPPRESS_MS = 750;

interface ActivePointer {
	id: number;
	x: number;
	y: number;
}

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
		pointerTypes = DEFAULT_POINTER_TYPES,
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

	const clearTimer = useCallback(() => {
		if (timerRef.current) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
	}, []);

	const cancel = useCallback(() => {
		clearTimer();
		activePointerRef.current = null;
		setPressing(false);
	}, [clearTimer]);

	const suppressNextContextMenu = useCallback(() => {
		suppressContextMenuRef.current = true;
		if (contextMenuTimerRef.current) {
			clearTimeout(contextMenuTimerRef.current);
		}
		contextMenuTimerRef.current = setTimeout(() => {
			suppressContextMenuRef.current = false;
			contextMenuTimerRef.current = null;
		}, CONTEXT_MENU_SUPPRESS_MS);
	}, []);

	useEffect(
		() => () => {
			clearTimer();
			if (contextMenuTimerRef.current) {
				clearTimeout(contextMenuTimerRef.current);
			}
		},
		[clearTimer],
	);

	const pointerAllowed = useCallback(
		(event: ReactPointerEvent<HTMLElement>) => {
			if (disabled || event.pointerType === "mouse") {
				return false;
			}
			return pointerTypes.includes(event.pointerType);
		},
		[disabled, pointerTypes],
	);

	const onPointerDown = useCallback(
		(event: ReactPointerEvent<HTMLElement>) => {
			if (!pointerAllowed(event) || event.button !== 0) {
				return;
			}
			clearTimer();
			activePointerRef.current = {
				id: event.pointerId,
				x: event.clientX,
				y: event.clientY,
			};
			setPressing(true);
			timerRef.current = setTimeout(() => {
				timerRef.current = null;
				activePointerRef.current = null;
				setPressing(false);
				suppressNextContextMenu();
				onLongPressRef.current();
			}, delay);
		},
		[clearTimer, delay, pointerAllowed, suppressNextContextMenu],
	);

	const onPointerMove = useCallback(
		(event: ReactPointerEvent<HTMLElement>) => {
			const activePointer = activePointerRef.current;
			if (!activePointer || activePointer.id !== event.pointerId) {
				return;
			}
			const dx = Math.abs(event.clientX - activePointer.x);
			const dy = Math.abs(event.clientY - activePointer.y);
			if (dx > moveTolerance || dy > moveTolerance) {
				cancel();
			}
		},
		[cancel, moveTolerance],
	);

	const onContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
		if (!suppressContextMenuRef.current) {
			return;
		}
		event.preventDefault();
		suppressContextMenuRef.current = false;
		if (contextMenuTimerRef.current) {
			clearTimeout(contextMenuTimerRef.current);
			contextMenuTimerRef.current = null;
		}
	}, []);

	const handlers = useMemo(
		() => ({
			onContextMenu,
			onPointerCancel: cancel,
			onPointerDown,
			onPointerLeave: cancel,
			onPointerMove,
			onPointerUp: cancel,
		}),
		[cancel, onContextMenu, onPointerDown, onPointerMove],
	);

	return { handlers, pressing };
}
