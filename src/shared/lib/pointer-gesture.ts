import type { PointerEvent as ReactPointerEvent } from "react";

export const TOUCH_POINTER_TYPES = ["touch", "pen"] as const;

export interface ActivePointer {
	id: number;
	x: number;
	y: number;
}

export function clearTimeoutRef(timerRef: {
	current: ReturnType<typeof setTimeout> | null;
}): void {
	const pendingTimer = timerRef.current;
	timerRef.current = null;
	if (pendingTimer) {
		clearTimeout(pendingTimer);
	}
}

export function capturePointer(
	event: ReactPointerEvent<HTMLElement>,
): ActivePointer {
	return {
		id: event.pointerId,
		x: event.clientX,
		y: event.clientY,
	};
}

export function pointerAllowed(
	event: ReactPointerEvent<HTMLElement>,
	disabled: boolean,
	pointerTypes: readonly string[],
): boolean {
	return (
		!disabled &&
		event.pointerType !== "mouse" &&
		pointerTypes.includes(event.pointerType)
	);
}

export function pointerMovedPastTolerance(
	activePointer: ActivePointer,
	event: ReactPointerEvent<HTMLElement>,
	moveTolerance: number,
): boolean {
	return (
		Math.abs(event.clientX - activePointer.x) > moveTolerance ||
		Math.abs(event.clientY - activePointer.y) > moveTolerance
	);
}
