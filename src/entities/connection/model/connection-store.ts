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
	/** GPU list returned by `gpu_get_info`. Empty array = no GPU detected. */
	gpuInfo: GpuInfo[];
	runtimeInfo: RuntimeInfo | null;
	serverStatus: ServerStatus;
	setConnectionStatus: (status: ConnectionStatus) => void;
	setGpuInfo: (info: GpuInfo[]) => void;
	setRuntimeInfo: (info: RuntimeInfo | null) => void;
	setServerStatus: (status: ServerStatus) => void;
}

export const useConnectionStore = create<ConnectionState>()((set) => ({
	// Initial "connecting" instead of "disconnected" so the cold-start
	// chip reads "CONNECTING…" not "OFFLINE" while the stt-server binds
	// its WS ports (5–8 s on first launch). The relay in main suppresses
	// "disconnected" broadcasts until the first successful connect, so
	// this state holds until either we connect or the renderer is closed.
	connectionStatus: "connecting",
	serverStatus: "idle",
	gpuInfo: [],
	runtimeInfo: null,
	setConnectionStatus: (status) => set({ connectionStatus: status }),
	setServerStatus: (status) => set({ serverStatus: status }),
	setGpuInfo: (info) => set({ gpuInfo: info }),
	setRuntimeInfo: (info) => set({ runtimeInfo: info }),
}));
