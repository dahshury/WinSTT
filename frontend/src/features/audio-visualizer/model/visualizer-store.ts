import { create } from "zustand";

interface VisualizerState {
	frequencyData: Uint8Array;
	isActive: boolean;
	setFrequencyData: (data: Uint8Array) => void;
	setActive: (active: boolean) => void;
}

export const useVisualizerStore = create<VisualizerState>((set) => ({
	frequencyData: new Uint8Array(64),
	isActive: false,
	setFrequencyData: (data) => set({ frequencyData: data }),
	setActive: (active) => set({ isActive: active }),
}));
