import type {
	useCatalogStore,
	useModelStateStore,
} from "@/entities/model-catalog";
import type { useSettingsStore } from "@/entities/setting";
import type { useSystemResourcesStore } from "@/entities/system-resources";
import type { FitAssessmentEntry } from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";

export type SettingsStoreState = ReturnType<typeof useSettingsStore.getState>;
export type ModelSettings = SettingsStoreState["settings"]["model"];
export type UpdateModelFn = SettingsStoreState["updateModelSettings"];
export type UpdatePatch = Parameters<UpdateModelFn>[0];

export type DeviceValue = "auto" | "cpu";
export type StatesById = ReturnType<
	typeof useModelStateStore.getState
>["statesById"];
export type GetModelFn = ReturnType<
	typeof useCatalogStore.getState
>["getModel"];
export type ModelState = StatesById[string];
export type AssessFitFn = ReturnType<
	typeof useSystemResourcesStore.getState
>["assessDictationFitOnServer"];

// Pending-download confirmation dialog state. Holds the model id that
// the user picked when it wasn't already cached. Cleared on confirm or
// cancel; cancel also reverts the picker (mirror of swap-failed path).
export interface PendingDownload {
	kind: "main" | "realtime";
	modelId: string;
	previousModelId: string;
	quantization?: OnnxQuantization | undefined;
}

// Pending resource-warning dialog state. When the server's fit assessment
// returns ``critical`` (definitely won't fit), we hold the user's choice
// here and require an explicit "Proceed anyway" before either kicking off
// the download or issuing the swap. Cancel reverts the picker silently.
export interface PendingFitWarning {
	assessment: FitAssessmentEntry;
	candidateName: string;
	// next: what to do after the user confirms. Either open the download
	// dialog or issue the swap directly, depending on cache state at
	// decision time.
	next: () => void;
}

export interface SwapController {
	cancelPendingDownload: () => void;
	confirmPendingDownload: () => void;
	handleModelChange: (v: string, quantization?: OnnxQuantization) => void;
	handleRealtimeModelChange: (
		v: string,
		quantization?: OnnxQuantization,
	) => void;
	pendingDownload: PendingDownload | null;
	pendingFitWarning: PendingFitWarning | null;
	/** Open the download-confirmation dialog for an explicit per-quant download
	 *  (the precision-badge "download this variant" action) WITHOUT selecting /
	 *  swapping to the model. The dialog's Download button runs the same
	 *  background predownload the badge used to fire directly — gating it behind
	 *  the size + hardware-fit confirmation. */
	promptDownload: (
		kind: "main" | "realtime",
		modelId: string,
		quantization?: OnnxQuantization,
	) => void;
	setPendingFitWarning: (value: PendingFitWarning | null) => void;
}

export interface IssueSwapArgs {
	currentQuantization: OnnxQuantization;
	currentMainModel?: string | undefined;
	currentRealtimeModel?: string | undefined;
	getModel: GetModelFn;
	kind: "main" | "realtime";
	previous: string;
	prevMainModelRef: React.MutableRefObject<string | null>;
	prevRealtimeModelRef: React.MutableRefObject<string | null>;
	quantization: OnnxQuantization | undefined;
	update: UpdateModelFn;
	value: string;
}

export interface ProceedArgs {
	currentQuantization: OnnxQuantization;
	issueSwap: (
		kind: "main" | "realtime",
		value: string,
		previous: string,
		quantization?: OnnxQuantization,
	) => void;
	kind: "main" | "realtime";
	previous: string;
	quantization: OnnxQuantization | undefined;
	setPendingDownload: (value: PendingDownload) => void;
	statesById: StatesById;
	value: string;
}

export interface GateArgs {
	assessDictationFitOnServer: AssessFitFn;
	currentQuantization: OnnxQuantization;
	deviceValue: DeviceValue;
	getModel: GetModelFn;
	currentMainModel?: string | undefined;
	currentRealtimeModel?: string | undefined;
	kind: "main" | "realtime";
	previous: string;
	proceed: (
		kind: "main" | "realtime",
		value: string,
		previous: string,
		quantization: OnnxQuantization | undefined,
	) => void;
	quantization: OnnxQuantization | undefined;
	setPendingFitWarning: (value: PendingFitWarning | null) => void;
	statesById: StatesById;
	value: string;
}

export interface HandleChangeArgs {
	currentModel: string;
	currentQuantization: OnnxQuantization;
	gateWithAssessment: (
		kind: "main" | "realtime",
		value: string,
		previous: string,
		quantization: OnnxQuantization | undefined,
	) => Promise<void>;
	issueSwap: (
		kind: "main" | "realtime",
		value: string,
		previous: string,
		quantization?: OnnxQuantization,
	) => void;
	kind: "main" | "realtime";
	quantization: OnnxQuantization | undefined;
	update: UpdateModelFn;
	value: string;
}
