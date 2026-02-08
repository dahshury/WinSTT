import { create } from "zustand";

interface HotkeyState {
	isPressed: boolean;
	accelerator: string;
	setPressed: (pressed: boolean) => void;
	setAccelerator: (accelerator: string) => void;
}

export const useHotkeyStore = create<HotkeyState>((set) => ({
	isPressed: false,
	accelerator: "Space",
	setPressed: (pressed) => set({ isPressed: pressed }),
	setAccelerator: (accelerator) => set({ accelerator }),
}));
