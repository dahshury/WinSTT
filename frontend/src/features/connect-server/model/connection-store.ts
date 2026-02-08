import type { components } from "@spec/schema";
import { create } from "zustand";

type ConnectionStatus = components["schemas"]["ConnectionStatus"];
type ServerStatus = components["schemas"]["ServerStatus"];
type GpuInfo = components["schemas"]["GpuInfo"];

interface ConnectionState {
	connectionStatus: ConnectionStatus;
	serverStatus: ServerStatus;
	gpuInfo: GpuInfo | null;
	setConnectionStatus: (status: ConnectionStatus) => void;
	setServerStatus: (status: ServerStatus) => void;
	setGpuInfo: (info: GpuInfo | null) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
	connectionStatus: "disconnected",
	serverStatus: "idle",
	gpuInfo: null,
	setConnectionStatus: (status) => set({ connectionStatus: status }),
	setServerStatus: (status) => set({ serverStatus: status }),
	setGpuInfo: (info) => set({ gpuInfo: info }),
}));
