import { resolveQuantCache } from "@picker";
import { useCallback, useEffect, useRef, useState } from "react";
import type { useCatalogStore, useModelStateStore } from "@/entities/model-catalog";
import type { useSettingsStore } from "@/entities/setting";
import { useSystemResourcesStore } from "@/entities/system-resources";
import {
	type FitAssessmentEntry,
	onModelDownloadComplete,
	onModelSwapFailed,
	sttReloadModel,
} from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";

type SettingsStoreState = ReturnType<typeof useSettingsStore.getState>;
type ModelSettings = SettingsStoreState["settings"]["model"];
type UpdateModelFn = SettingsStoreState["updateModelSettings"];

export type DeviceValue = "auto" | "cpu";
export type StatesById = ReturnType<typeof useModelStateStore.getState>["statesById"];
type GetModelFn = ReturnType<typeof useCatalogStore.getState>["getModel"];

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
	handleRealtimeModelChange: (v: string, quantization?: OnnxQuantization) => void;
	pendingDownload: PendingDownload | null;
	pendingFitWarning: PendingFitWarning | null;
	setPendingFitWarning: (value: PendingFitWarning | null) => void;
}

/** Owns the resource-gate → download-confirm → hot-swap pipeline plus its
 *  rollback effects. Lives in a feature so every surface that lets the user
 *  pick a model (settings panel, footer chip) commits the swap identically
 *  instead of merely mutating local settings. */
export function useModelSwapController(
	settings: ModelSettings | undefined,
	selectedModel: string,
	currentQuantization: OnnxQuantization,
	deviceValue: DeviceValue,
	getModel: GetModelFn,
	statesById: StatesById,
	update: UpdateModelFn
): SwapController {
	const assessDictationFitOnServer = useSystemResourcesStore((s) => s.assessDictationFitOnServer);

	// Track the previous model id for each picker so a server-side swap
	// failure can revert the setting back to what was actually loaded.
	const prevMainModelRef = useRef<string | null>(null);
	const prevRealtimeModelRef = useRef<string | null>(null);

	const [pendingDownload, setPendingDownload] = useState<PendingDownload | null>(null);
	const [pendingFitWarning, setPendingFitWarning] = useState<PendingFitWarning | null>(null);

	const issueSwap = useCallback(
		(
			kind: "main" | "realtime",
			value: string,
			previous: string,
			quantization?: OnnxQuantization
		) => {
			const quantizationChanging =
				quantization !== undefined && quantization !== currentQuantization;
			if (kind === "main") {
				const info = getModel(value);
				prevMainModelRef.current = previous;
				const patch: Parameters<UpdateModelFn>[0] = info
					? { model: value, backend: info.backend }
					: { model: value };
				if (quantizationChanging) {
					patch.onnxQuantization = quantization;
				}
				update(patch);
			} else {
				prevRealtimeModelRef.current = previous;
				const patch: Parameters<UpdateModelFn>[0] = { realtimeModel: value };
				if (quantizationChanging) {
					patch.onnxQuantization = quantization;
				}
				update(patch);
			}
			// model.onnxQuantization is a STARTUP_ONLY key — touching it triggers a
			// full server restart that boots with the new quantization (and the new
			// model field). Skip the hot-swap call to avoid racing the restart.
			if (!quantizationChanging) {
				sttReloadModel(kind, value);
			}
		},
		[update, getModel, currentQuantization]
	);

	// Common downstream behavior once the user has accepted any warnings:
	// either prompt for download (if target precision isn't cached) or
	// hot-swap directly.
	const proceedWithSelection = useCallback(
		(
			kind: "main" | "realtime",
			v: string,
			previous: string,
			quantization: OnnxQuantization | undefined
		) => {
			// If the *target precision* isn't already on disk, prompt before
			// kicking off the download — a model can be cached at int8 but not
			// at fp16, so check the quantization the swap will actually load.
			const state = statesById[v];
			const targetQuant = quantization ?? currentQuantization;
			const targetCache = resolveQuantCache(state, targetQuant);
			if (state && targetCache?.state !== "cached") {
				setPendingDownload({ kind, modelId: v, previousModelId: previous, quantization });
				return;
			}
			issueSwap(kind, v, previous, quantization);
		},
		[issueSwap, statesById, currentQuantization]
	);

	// Resource-aware gate: round-trip the server for an authoritative fit
	// verdict. If ``critical`` (won't fit given current load), surface the
	// ResourceWarningDialog and stash the onward action; otherwise proceed
	// straight to the existing download/swap path.
	const gateWithAssessment = useCallback(
		async (
			kind: "main" | "realtime",
			v: string,
			previous: string,
			quantization: OnnxQuantization | undefined
		) => {
			const candidate = getModel(v);
			const candidateName = candidate?.displayName ?? v;
			const targetQuant = quantization ?? currentQuantization;
			const assessment = await assessDictationFitOnServer(v, targetQuant, deviceValue);
			if (assessment && assessment.severity === "critical") {
				setPendingFitWarning({
					assessment,
					candidateName,
					next: () => proceedWithSelection(kind, v, previous, quantization),
				});
				return;
			}
			proceedWithSelection(kind, v, previous, quantization);
		},
		[assessDictationFitOnServer, currentQuantization, deviceValue, getModel, proceedWithSelection]
	);

	const handleModelChange = useCallback(
		(v: string, quantization?: OnnxQuantization) => {
			const currentModel = settings?.model ?? selectedModel;
			const quantizationChanging =
				quantization !== undefined && quantization !== currentQuantization;
			if (v === currentModel) {
				// Pure quantization swap on the already-loaded model. Push the new
				// value; the STARTUP_ONLY restart handles the rest.
				if (quantizationChanging) {
					update({ onnxQuantization: quantization });
				}
				return;
			}
			gateWithAssessment("main", v, currentModel, quantization).catch(reportSwapGateError);
		},
		[gateWithAssessment, settings?.model, selectedModel, currentQuantization, update]
	);

	const handleRealtimeModelChange = useCallback(
		(v: string, quantization?: OnnxQuantization) => {
			const current = settings?.realtimeModel ?? "";
			const quantizationChanging =
				quantization !== undefined && quantization !== currentQuantization;
			if (v === current) {
				if (quantizationChanging) {
					update({ onnxQuantization: quantization });
				}
				return;
			}
			gateWithAssessment("realtime", v, current, quantization).catch(reportSwapGateError);
		},
		[gateWithAssessment, settings?.realtimeModel, currentQuantization, update]
	);

	// Kick off the swap (which triggers the download) but keep the modal
	// open so the user sees live progress and can Stop without re-clicking
	// the picker. Closing only happens on explicit Cancel/Esc or when the
	// download-complete event fires (handled below).
	const confirmPendingDownload = useCallback(() => {
		if (!pendingDownload) {
			return;
		}
		issueSwap(
			pendingDownload.kind,
			pendingDownload.modelId,
			pendingDownload.previousModelId,
			pendingDownload.quantization
		);
	}, [issueSwap, pendingDownload]);

	const cancelPendingDownload = useCallback(() => {
		setPendingDownload(null);
	}, []);

	// Auto-close when the model the modal is targeting finishes downloading
	// successfully — at that point the swap completes naturally and the
	// settings panel can show the new active model. Cancellations keep the
	// modal open so the user can resume or discard.
	useEffect(
		() =>
			onModelDownloadComplete((model, cancelled) => {
				if (cancelled) {
					return;
				}
				setPendingDownload((current) => (current?.modelId === model ? null : current));
			}),
		[]
	);

	// Failure handler: roll the picker back to whatever was loaded before
	// the user's selection. Uses the per-kind ref captured at click time.
	useEffect(
		() =>
			onModelSwapFailed(({ kind }) => {
				if (kind === "main") {
					const prev = prevMainModelRef.current;
					if (prev !== null) {
						update({ model: prev });
					}
				} else {
					const prev = prevRealtimeModelRef.current;
					if (prev !== null) {
						update({ realtimeModel: prev });
					}
				}
			}),
		[update]
	);

	return {
		pendingDownload,
		pendingFitWarning,
		setPendingFitWarning,
		handleModelChange,
		handleRealtimeModelChange,
		confirmPendingDownload,
		cancelPendingDownload,
	};
}

/** Fire-and-forget guard for the model-swap gate. The gate already surfaces
 *  user-facing failures via the resource/download dialogs; this only keeps an
 *  unexpected rejection from becoming an unhandled promise. */
function reportSwapGateError(err: unknown): void {
	console.error("model swap gate failed", err);
}
