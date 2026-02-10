import { create } from "zustand";

interface HotkeyState {
	isPressed: boolean;
	isActive: boolean;
	accelerator: string;
	setPressed: (pressed: boolean) => void;
	setActive: (active: boolean) => void;
	setAccelerator: (accelerator: string) => void;
}

export const useHotkeyStore = create<HotkeyState>((set) => ({
	isPressed: false,
	isActive: false,
	accelerator: "LCtrl+LMeta",
	setPressed: (pressed) => set({ isPressed: pressed }),
	setActive: (active) => set({ isActive: active }),
	setAccelerator: (accelerator) => set({ accelerator }),
}));
