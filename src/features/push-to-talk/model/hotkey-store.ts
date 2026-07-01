import { create } from "zustand";
import { DEFAULT_SETTINGS } from "@/entities/setting";

/**
 * Recording lifecycle as the hotkey badge sees it:
 * - `idle`    — nothing recording.
 * - `opening` — a hotkey press initiated a recording but the mic hasn't confirmed
 *   audio yet (Windows is still opening the device). Driven by `hotkey:pressed`,
 *   the only signal available during the blocking `stream.play()`.
 * - `live`    — the mic is confirmed open and delivering frames. Driven by the
 *   backend `stt:capture-active` event (first captured frame of the recording).
 */
export type MicPhase = "idle" | "opening" | "live";

interface HotkeyState {
	accelerator: string;
	isActive: boolean;
	micPhase: MicPhase;
	setAccelerator: (accelerator: string) => void;
	setActive: (active: boolean) => void;
	setMicPhase: (phase: MicPhase) => void;
}

export const useHotkeyStore = create<HotkeyState>()((set) => ({
	micPhase: "idle",
	isActive: false,
	// Source of truth for the default PTT combo is the Zod schema — this avoids
	// default drift in this store.
	accelerator: DEFAULT_SETTINGS.hotkey.pushToTalkKey,
	setMicPhase: (phase) => set({ micPhase: phase }),
	setActive: (active) => set({ isActive: active }),
	setAccelerator: (accelerator) => set({ accelerator }),
}));
