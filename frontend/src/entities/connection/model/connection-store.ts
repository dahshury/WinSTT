import type { components } from "@spec/schema";
import { create } from "zustand";
import type { GpuInfo, ServerStatus } from "@/shared/api/models";

type ConnectionStatus = components["schemas"]["ConnectionStatus"];

/**
 * Live ORT runtime snapshot published by the server. Honest about what
 * inference is actually using — a CPU-only onnxruntime install on a
 * CUDA-capable machine reports ``is_gpu=false`` here even when the user's
 * config requested ``device=cuda``. Drives the bottom-left GPU/CPU chip.
 */
export interface RuntimeInfo {
	device: string;
	is_gpu: boolean;
	model: string | null;
	providers: string[];
	realtime_model: string | null;
}

interface ConnectionState {
	connectionStatus: ConnectionStatus;
	gpuInfo: GpuInfo | null;
	runtimeInfo: RuntimeInfo | null;
	serverStatus: ServerStatus;
	setConnectionStatus: (status: ConnectionStatus) => void;
	setGpuInfo: (info: GpuInfo | null) => void;
	setRuntimeInfo: (info: RuntimeInfo | null) => void;
	setServerStatus: (status: ServerStatus) => void;
}

export const useConnectionStore = create<ConnectionState>()((set) => ({
	connectionStatus: "disconnected",
	serverStatus: "idle",
	gpuInfo: null,
	runtimeInfo: null,
	setConnectionStatus: (status) => set({ connectionStatus: status }),
	setServerStatus: (status) => set({ serverStatus: status }),
	setGpuInfo: (info) => set({ gpuInfo: info }),
	setRuntimeInfo: (info) => set({ runtimeInfo: info }),
}));
