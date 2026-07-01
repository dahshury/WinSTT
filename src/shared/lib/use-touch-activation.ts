import type {
	MouseEvent as ReactMouseEvent,
	PointerEvent as ReactPointerEvent,
} from "react";
import { useEffect, useRef } from "react";
import {
	type ActivePointer,
	capturePointer,
	clearTimeoutRef,
	pointerAllowed,
	pointerMovedPastTolerance,
	TOUCH_POINTER_TYPES,
} from "./pointer-gesture";

const DEFAULT_MOVE_TOLERANCE_PX = 12;
const CLICK_SUPPRESS_MS = 450;

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
		pointerTypes = TOUCH_POINTER_TYPES,
	}: UseTouchActivationOptions = {},
): UseTouchActivationResult {
	const activePointerRef = useRef<ActivePointer | null>(null);
	const onActivateRef = useRef(onActivate);
	const suppressClickRef = useRef(false);
	const suppressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		onActivateRef.current = onActivate;
	}, [onActivate]);

	const suppressNextClick = () => {
		suppressClickRef.current = true;
		clearTimeoutRef(suppressTimerRef);
		suppressTimerRef.current = setTimeout(() => {
			suppressClickRef.current = false;
			suppressTimerRef.current = null;
		}, CLICK_SUPPRESS_MS);
	};

	const cancelTouchPointer = () => {
		if (activePointerRef.current) {
			suppressNextClick();
		}
		activePointerRef.current = null;
	};

	useEffect(() => () => clearTimeoutRef(suppressTimerRef), []);

	const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
		if (!pointerAllowed(event, disabled, pointerTypes) || event.button !== 0) {
			return;
		}
		activePointerRef.current = capturePointer(event);
	};

	const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
		const activePointer = activePointerRef.current;
		if (!activePointer || activePointer.id !== event.pointerId) {
			return;
		}
		if (pointerMovedPastTolerance(activePointer, event, moveTolerance)) {
			cancelTouchPointer();
		}
	};

	const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
		const activePointer = activePointerRef.current;
		if (!activePointer || activePointer.id !== event.pointerId) {
			return;
		}
		activePointerRef.current = null;
		suppressNextClick();
		event.preventDefault();
		event.stopPropagation();
		onActivateRef.current();
	};

	const onClick = (event: ReactMouseEvent<HTMLElement>) => {
		if (suppressClickRef.current) {
			event.preventDefault();
			event.stopPropagation();
			suppressClickRef.current = false;
			clearTimeoutRef(suppressTimerRef);
			return;
		}
		if (disabled) {
			event.preventDefault();
			return;
		}
		onActivateRef.current();
	};

	return {
		onClick,
		onPointerCancel: cancelTouchPointer,
		onPointerDown,
		onPointerLeave: cancelTouchPointer,
		onPointerMove,
		onPointerUp,
	};
}
