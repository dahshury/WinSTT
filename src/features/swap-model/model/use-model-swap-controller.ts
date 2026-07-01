import { useEffect, useRef, useState } from "react";
import { useSystemResourcesStore } from "@/entities/system-resources";
import {
	onModelDownloadComplete,
	onModelSwapFailed,
} from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import {
	applyPureQuantSwap,
	applyQuantOverride,
	buildMainSwapPatch,
	buildRealtimeSwapPatch,
	definedQuantPatches,
	isCloudModel,
	isQuantizationChanging,
	maybeHotReload,
	realtimePatchForMainSwap,
	runIssueSwap,
	shouldReloadForHotSwap,
	toQuantPatch,
} from "./apply-swap";
import {
	isCriticalAssessment,
	isSwapBlockedByDownload,
	mapFirstToCache,
	needsDownloadPrompt,
	promptDownload,
	reportSwapGateError,
	resolveCandidateName,
	resolveTargetCache,
	resolveTargetQuant,
	runGateWithAssessment,
	runProceedWithSelection,
	surfaceFitWarning,
	toPresentList,
} from "./download-gate";
import {
	clearIfMatches,
	closePendingDownloadFor,
	dispatchChange,
	dispatchGate,
	handleDownloadCompleteEvent,
	handleSwapFailedEvent,
	matchesPending,
	resolveCurrentMainModel,
	resolveCurrentRealtimeModel,
	rollbackMain,
	rollbackRealtime,
	runConfirmPendingDownload,
	runHandleChange,
	toIssueSwapInvoker,
} from "./dispatch-and-events";
import type {
	DeviceValue,
	GetModelFn,
	ModelSettings,
	PendingDownload,
	PendingFitWarning,
	StatesById,
	SwapController,
	UpdateModelFn,
} from "./swap-types";

export type {
	DeviceValue,
	PendingDownload,
	PendingFitWarning,
	StatesById,
	SwapController,
} from "./swap-types";

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
	update: UpdateModelFn,
	// Injected (FSD: a feature can't import the model-download feature) so the
	// controller can refuse to switch TO a model whose target precision is
	// still downloading. Defaults to "nothing downloading" for callers/tests
	// that don't wire it.
	isQuantDownloading: (modelId: string, quantization: string) => boolean = () =>
		false,
	// Injected (FSD: a feature can't import the file-transcription feature) so
	// the controller refuses to swap the shared STT model while the file queue
	// is busy — the swap would shut down and reload the very transcriber the
	// queue is mid-stream on. The Rust backend enforces the same block
	// as a safety net; this keeps the renderer from even issuing the request.
	// Defaults to "not busy" for callers/tests that don't wire it.
	isFileQueueBusy: () => boolean = () => false,
): SwapController {
	const assessDictationFitOnServer = useSystemResourcesStore(
		(s) => s.assessDictationFitOnServer,
	);

	// Track the previous model id for each picker so a server-side swap
	// failure can revert the setting back to what was actually loaded.
	const prevMainModelRef = useRef<string | null>(null);
	const prevRealtimeModelRef = useRef<string | null>(null);

	const [pendingDownload, setPendingDownload] =
		useState<PendingDownload | null>(null);
	const [pendingFitWarning, setPendingFitWarning] =
		useState<PendingFitWarning | null>(null);
	const currentMainModel = resolveCurrentMainModel(settings, selectedModel);
	const currentRealtimeModel = resolveCurrentRealtimeModel(settings);

	const issueSwap = (
		kind: "main" | "realtime",
		value: string,
		previous: string,
		quantization?: OnnxQuantization,
	) => {
		runIssueSwap({
			kind,
			value,
			previous,
			quantization,
			currentQuantization,
			currentMainModel,
			currentRealtimeModel,
			getModel,
			update,
			prevMainModelRef,
			prevRealtimeModelRef,
		});
	};

	// Common downstream behavior once the user has accepted any warnings:
	// either prompt for download (if target precision isn't cached) or
	// hot-swap directly.
	const proceedWithSelection = (
		kind: "main" | "realtime",
		v: string,
		previous: string,
		quantization: OnnxQuantization | undefined,
	) => {
		runProceedWithSelection({
			kind,
			value: v,
			previous,
			quantization,
			currentQuantization,
			statesById,
			issueSwap,
			setPendingDownload,
		});
	};

	// Resource-aware gate: round-trip the server for an authoritative fit
	// verdict. If ``critical`` (won't fit given current load), surface the
	// ResourceWarningDialog and stash the onward action; otherwise proceed
	// straight to the existing download/swap path.
	const gateWithAssessment = (
		kind: "main" | "realtime",
		v: string,
		previous: string,
		quantization: OnnxQuantization | undefined,
	) =>
		runGateWithAssessment({
			kind,
			value: v,
			previous,
			quantization,
			currentQuantization,
			deviceValue,
			getModel,
			currentMainModel,
			currentRealtimeModel,
			assessDictationFitOnServer,
			proceed: proceedWithSelection,
			setPendingFitWarning,
			statesById,
		});

	const handleModelChange = (v: string, quantization?: OnnxQuantization) => {
		// Block model swaps while the file-transcription queue is busy — the
		// swap would yank the shared transcriber out from under in-flight
		// file work. The UI also disables the selector when busy.
		if (isFileQueueBusy()) {
			return;
		}
		// Refuse to switch TO a model whose target precision is still
		// downloading — it isn't on disk yet, so a swap would just fail /
		// re-trigger a fetch. The download keeps running in the background;
		// the user can switch once it finishes.
		if (
			isSwapBlockedByDownload(
				v,
				quantization,
				currentQuantization,
				statesById,
				isQuantDownloading,
			)
		) {
			return;
		}
		runHandleChange({
			value: v,
			quantization,
			currentModel: currentMainModel,
			currentQuantization,
			kind: "main",
			update,
			issueSwap,
			gateWithAssessment,
		});
	};

	const handleRealtimeModelChange = (
		v: string,
		quantization?: OnnxQuantization,
	) => {
		if (isFileQueueBusy()) {
			return;
		}
		if (
			isSwapBlockedByDownload(
				v,
				quantization,
				currentQuantization,
				statesById,
				isQuantDownloading,
			)
		) {
			return;
		}
		runHandleChange({
			value: v,
			quantization,
			currentModel: currentRealtimeModel,
			currentQuantization,
			kind: "realtime",
			update,
			issueSwap,
			gateWithAssessment,
		});
	};

	// Kick off the swap (which triggers the download) but keep the modal
	// open so the user sees live progress and can Stop without re-clicking
	// the picker. Closing only happens on explicit Cancel/Esc or when the
	// download-complete event fires (handled below).
	const confirmPendingDownload = () => {
		runConfirmPendingDownload(pendingDownload, issueSwap);
	};

	const cancelPendingDownload = () => {
		setPendingDownload(null);
	};

	// Explicit per-quant download (precision-badge click): open the confirmation
	// dialog for ``(modelId, quantization)`` without touching the loaded model.
	// The dialog already surfaces the download size + hardware-fit warning and
	// runs a background predownload on confirm — so a badge click no longer
	// silently kicks off a multi-GB fetch. ``previousModelId``
	// is the currently-loaded model for the slot; it is only consulted by the
	// swap-rollback path, which this predownload-only flow never reaches.
	const promptDownload = (
		kind: "main" | "realtime",
		modelId: string,
		quantization?: OnnxQuantization,
	) => {
		setPendingDownload({
			kind,
			modelId,
			previousModelId:
				kind === "main" ? currentMainModel : currentRealtimeModel,
			quantization,
		});
	};

	// Auto-close when the model the modal is targeting finishes downloading
	// successfully — at that point the swap completes naturally and the
	// settings panel can show the new active model. Cancellations keep the
	// modal open so the user can resume or discard.
	useEffect(
		() =>
			onModelDownloadComplete((model, cancelled) =>
				handleDownloadCompleteEvent(model, cancelled, setPendingDownload),
			),
		[],
	);

	// Failure handler: roll the picker back to whatever was loaded before
	// the user's selection. Uses the per-kind ref captured at click time.
	useEffect(
		() =>
			onModelSwapFailed((event) =>
				handleSwapFailedEvent(
					event.kind,
					event.category,
					prevMainModelRef,
					prevRealtimeModelRef,
					update,
					getModel,
				),
			),
		[update, getModel],
	);

	return {
		pendingDownload,
		pendingFitWarning,
		setPendingFitWarning,
		handleModelChange,
		handleRealtimeModelChange,
		confirmPendingDownload,
		cancelPendingDownload,
		promptDownload,
	};
}

/** Test-only re-exports of the module-level helpers so the sibling
 *  `.test.ts` can exercise their branches without spinning up a React
 *  renderer. Keeps the public API of the slice limited to
 *  `useModelSwapController` while still satisfying the CRAP coverage gate.
 *  DO NOT import this from production code. */
export const __testables = {
	applyPureQuantSwap,
	applyQuantOverride,
	buildMainSwapPatch,
	buildRealtimeSwapPatch,
	clearIfMatches,
	closePendingDownloadFor,
	definedQuantPatches,
	dispatchChange,
	dispatchGate,
	handleDownloadCompleteEvent,
	handleSwapFailedEvent,
	isCloudModel,
	isCriticalAssessment,
	isQuantizationChanging,
	isSwapBlockedByDownload,
	mapFirstToCache,
	matchesPending,
	maybeHotReload,
	needsDownloadPrompt,
	promptDownload,
	reportSwapGateError,
	resolveCandidateName,
	resolveCurrentMainModel,
	resolveCurrentRealtimeModel,
	realtimePatchForMainSwap,
	resolveTargetCache,
	resolveTargetQuant,
	rollbackMain,
	rollbackRealtime,
	runConfirmPendingDownload,
	runGateWithAssessment,
	runHandleChange,
	runIssueSwap,
	runProceedWithSelection,
	shouldReloadForHotSwap,
	surfaceFitWarning,
	toIssueSwapInvoker,
	toPresentList,
	toQuantPatch,
} as const;
