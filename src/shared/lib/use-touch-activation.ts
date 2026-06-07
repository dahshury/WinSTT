import type {
	MouseEvent as ReactMouseEvent,
	PointerEvent as ReactPointerEvent,
} from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";

const DEFAULT_POINTER_TYPES = ["touch", "pen"] as const;
const DEFAULT_MOVE_TOLERANCE_PX = 12;
const CLICK_SUPPRESS_MS = 450;

interface ActivePointer {
	id: number;
	x: number;
	y: number;
}

interface UseTouchActivationOptions {
	disabled?: boolean;
	moveTolerance?: number;
	pointerTypes?: readonly string[];
}

interface UseTouchActivationResult {
	onClick: (event: ReactMouseEvent<HTMLElement>) => void;
	onPointerCancel: () => void;
	onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
	onPointerLeave: () => void;
	onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
	onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
}

export function useTouchActivation(
	onActivate: () => void,
	{
		disabled = false,
		moveTolerance = DEFAULT_MOVE_TOLERANCE_PX,
		pointerTypes = DEFAULT_POINTER_TYPES,
	}: UseTouchActivationOptions = {},
): UseTouchActivationResult {
	const activePointerRef = useRef<ActivePointer | null>(null);
	const onActivateRef = useRef(onActivate);
	const suppressClickRef = useRef(false);
	const suppressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		onActivateRef.current = onActivate;
	}, [onActivate]);

	const clearSuppressionTimer = useCallback(() => {
		if (suppressTimerRef.current) {
			clearTimeout(suppressTimerRef.current);
			suppressTimerRef.current = null;
		}
	}, []);

	const suppressNextClick = useCallback(() => {
		suppressClickRef.current = true;
		clearSuppressionTimer();
		suppressTimerRef.current = setTimeout(() => {
			suppressClickRef.current = false;
			suppressTimerRef.current = null;
		}, CLICK_SUPPRESS_MS);
	}, [clearSuppressionTimer]);

	const cancelTouchPointer = useCallback(() => {
		if (activePointerRef.current) {
			suppressNextClick();
		}
		activePointerRef.current = null;
	}, [suppressNextClick]);

	useEffect(
		() => () => {
			clearSuppressionTimer();
		},
		[clearSuppressionTimer],
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
			activePointerRef.current = {
				id: event.pointerId,
				x: event.clientX,
				y: event.clientY,
			};
		},
		[pointerAllowed],
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
				cancelTouchPointer();
			}
		},
		[cancelTouchPointer, moveTolerance],
	);

	const onPointerUp = useCallback(
		(event: ReactPointerEvent<HTMLElement>) => {
			const activePointer = activePointerRef.current;
			if (!activePointer || activePointer.id !== event.pointerId) {
				return;
			}
			activePointerRef.current = null;
			suppressNextClick();
			event.preventDefault();
			event.stopPropagation();
			onActivateRef.current();
		},
		[suppressNextClick],
	);

	const onClick = useCallback(
		(event: ReactMouseEvent<HTMLElement>) => {
			if (suppressClickRef.current) {
				event.preventDefault();
				event.stopPropagation();
				suppressClickRef.current = false;
				clearSuppressionTimer();
				return;
			}
			if (disabled) {
				event.preventDefault();
				return;
			}
			onActivateRef.current();
		},
		[clearSuppressionTimer, disabled],
	);

	return useMemo(
		() => ({
			onClick,
			onPointerCancel: cancelTouchPointer,
			onPointerDown,
			onPointerLeave: cancelTouchPointer,
			onPointerMove,
			onPointerUp,
		}),
		[cancelTouchPointer, onClick, onPointerDown, onPointerMove, onPointerUp],
	);
}
