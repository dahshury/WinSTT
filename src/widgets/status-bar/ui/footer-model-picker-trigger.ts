import { type MouseEvent, useEffect, useRef } from "react";
import {
	closeModelPicker,
	type ModelPickerKind,
	openModelPickerAtRect,
} from "@/shared/api/model-picker-window";

export const MODEL_PICKER_TRIGGER_SLOT = "stt-model-selector-trigger";

/**
 * Footer chip → detached picker opener. Returns a click handler that opens the
 * detached model-picker backdrop window anchored to the clicked chip, and
 * installs a capture-phase `pointerdown` listener that closes the picker on a
 * click anywhere outside a trigger chip.
 *
 * `pickerKind` selects which picker the shared backdrop window renders — omit it
 * for the STT model picker (the default), or pass `"output-device"` for the
 * listen-mode output-device picker. Every trigger shares the same
 * `MODEL_PICKER_TRIGGER_SLOT` data-slot, so clicking one chip while another's
 * picker is open re-anchors instead of closing (the click lands on a slot).
 */
export function useModelPickerTrigger(
	pickerKind?: ModelPickerKind,
): (event: MouseEvent<HTMLButtonElement>) => void {
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
		openModelPickerAtRect(
			event.currentTarget.getBoundingClientRect(),
			pickerKind ? { pickerKind } : {},
		);
		openRef.current = true;
	};
}
