import { type MouseEvent, useEffect, useRef } from "react";
import {
	closeModelPicker,
	openModelPickerAtRect,
} from "@/shared/api/model-picker-window";

export const MODEL_PICKER_TRIGGER_SLOT = "stt-model-selector-trigger";

export function useModelPickerTrigger(): (
	event: MouseEvent<HTMLButtonElement>,
) => void {
	const openRef = useRef(false);

	useEffect(() => {
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as HTMLElement | null;
			if (target?.closest(`[data-slot="${MODEL_PICKER_TRIGGER_SLOT}"]`)) {
				return;
			}
			if (openRef.current) {
				openRef.current = false;
				closeModelPicker();
			}
		};
		window.addEventListener("pointerdown", onPointerDown, true);
		return () => window.removeEventListener("pointerdown", onPointerDown, true);
	}, []);

	return (event) => {
		openModelPickerAtRect(event.currentTarget.getBoundingClientRect());
		openRef.current = true;
	};
}
