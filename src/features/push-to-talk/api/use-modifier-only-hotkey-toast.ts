import { useEffect } from "react";
import { useTranscriptionStore } from "@/entities/transcription";
import { onPttModifierOnlyUnsupported } from "@/shared/api/ipc-client";

/**
 * Surfaces the backend's `ptt:modifier-only-unsupported` rejection as an
 * ephemeral notice. The hotkey layer emits it when the user binds a
 * modifier-only accelerator (e.g. `Ctrl+Alt`) to push-to-talk on a platform
 * that can't arm one — without feedback the dictation hotkey would just
 * silently fail to register. The notice tells the user to pick a full hotkey
 * with a non-modifier key.
 *
 * Uses the transcription store's ephemeral channel (the same surface the
 * device-switch-failure feedback uses) rather than a window-bound toast,
 * because the rejection can fire while the main window sits hidden in the
 * tray — the always-available overlay is where the user will actually see it.
 * The message is an inline literal to match the panel-tooltip strings around
 * it (this slice doesn't localize its runtime notices).
 */
export function useModifierOnlyHotkeyToast(): void {
	const showEphemeral = useTranscriptionStore((s) => s.showEphemeral);

	useEffect(() => {
		const unsub = onPttModifierOnlyUnsupported((combo) => {
			const base =
				"Modifier-only push-to-talk keys aren't supported on this OS. Pick a full hotkey that includes a non-modifier key.";
			const message = combo ? `${combo} — ${base}` : base;
			showEphemeral(message, undefined, "error");
		});
		return unsub;
	}, [showEphemeral]);
}
