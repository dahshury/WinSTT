import type { components } from "@spec/schema";
import { create } from "zustand";
import type { GpuInfo, ServerStatus } from "@/shared/api/models";

type ConnectionStatus = components["schemas"]["ConnectionStatus"];

interface ConnectionState {
	connectionStatus: ConnectionStatus;
	serverStatus: ServerStatus;
	gpuInfo: GpuInfo | null;
	setConnectionStatus: (status: ConnectionStatus) => void;
	setServerStatus: (status: ServerStatus) => void;
	setGpuInfo: (info: GpuInfo | null) => void;
}

export const useConnectionStore = create<ConnectionState>()((set) => ({
	connectionStatus: "disconnected",
	serverStatus: "idle",
	gpuInfo: null,
	setConnectionStatus: (status) => set({ connectionStatus: status }),
	setServerStatus: (status) => set({ serverStatus: status }),
	setGpuInfo: (info) => set({ gpuInfo: info }),
}));
