import { create } from "zustand";

interface LoopbackDevice {
	index: number;
	name: string;
	defaultSampleRate: number;
	maxOutputChannels: number;
}

interface ListenStore {
	isListening: boolean;
	deviceName: string;
	devices: LoopbackDevice[];
	setListening: (listening: boolean, deviceName?: string) => void;
	setDevices: (devices: LoopbackDevice[]) => void;
}

export const useListenStore = create<ListenStore>((set) => ({
	isListening: false,
	deviceName: "",
	devices: [],
	setListening: (listening, deviceName) =>
		set({ isListening: listening, deviceName: listening ? (deviceName ?? "") : "" }),
	setDevices: (devices) => set({ devices }),
}));
