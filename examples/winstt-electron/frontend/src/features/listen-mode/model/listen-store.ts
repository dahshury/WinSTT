import { create } from "zustand";

interface LoopbackDevice {
	defaultSampleRate: number;
	index: number;
	maxOutputChannels: number;
	name: string;
}

interface ListenStore {
	deviceName: string;
	devices: LoopbackDevice[];
	isListening: boolean;
	setDevices: (devices: LoopbackDevice[]) => void;
	setListening: (listening: boolean, deviceName?: string) => void;
}

export const useListenStore = create<ListenStore>()((set) => ({
	isListening: false,
	deviceName: "",
	devices: [],
	setListening: (listening, deviceName) =>
		set({ isListening: listening, deviceName: listening ? (deviceName ?? "") : "" }),
	setDevices: (devices) => set({ devices }),
}));
