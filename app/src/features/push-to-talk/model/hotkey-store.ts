import { create } from "zustand";
import { DEFAULT_SETTINGS } from "@/entities/setting";

interface HotkeyState {
	accelerator: string;
	isActive: boolean;
	isPressed: boolean;
	setAccelerator: (accelerator: string) => void;
	setActive: (active: boolean) => void;
	setPressed: (pressed: boolean) => void;
}

export const useHotkeyStore = create<HotkeyState>()((set) => ({
	isPressed: false,
	isActive: false,
	// Source of truth for the default PTT combo is the Zod schema — this avoids
	// the rename drift the file used to have (was hardcoded "LCtrl+LMeta").
	accelerator: DEFAULT_SETTINGS.hotkey.pushToTalkKey,
	setPressed: (pressed) => set({ isPressed: pressed }),
	setActive: (active) => set({ isActive: active }),
	setAccelerator: (accelerator) => set({ accelerator }),
}));
