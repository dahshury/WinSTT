import { create } from "zustand";

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
	accelerator: "LCtrl+LMeta",
	setPressed: (pressed) => set({ isPressed: pressed }),
	setActive: (active) => set({ isActive: active }),
	setAccelerator: (accelerator) => set({ accelerator }),
}));
