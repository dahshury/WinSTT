import { resolveQuantCache } from "@picker";
import { useCallback, useEffect, useRef, useState } from "react";
import { providerOf } from "@/entities/cloud-stt-provider";
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
type UpdatePatch = Parameters<UpdateModelFn>[0];

export type DeviceValue = "auto" | "cpu";
export type StatesById = ReturnType<typeof useModelStateStore.getState>["statesById"];
type GetModelFn = ReturnType<typeof useCatalogStore.getState>["getModel"];
type ModelState = StatesById[string];
type AssessFitFn = ReturnType<
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
	handleRealtimeModelChange: (v: string, quantization?: OnnxQuantization) => void;
	pendingDownload: PendingDownload | null;
	pendingFitWarning: PendingFitWarning | null;
	setPendingFitWarning: (value: PendingFitWarning | null) => void;
}

interface IssueSwapArgs {
	currentQuantization: OnnxQuantization;
	getModel: GetModelFn;
	kind: "main" | "realtime";
	previous: string;
	prevMainModelRef: React.MutableRefObject<string | null>;
	prevRealtimeModelRef: React.MutableRefObject<string | null>;
	quantization: OnnxQuantization | undefined;
	update: UpdateModelFn;
	value: string;
}

interface ProceedArgs {
	currentQuantization: OnnxQuantization;
	issueSwap: (
		kind: "main" | "realtime",
		value: string,
		previous: string,
		quantization?: OnnxQuantization
	) => void;
	kind: "main" | "realtime";
	previous: string;
	quantization: OnnxQuantization | undefined;
	setPendingDownload: (value: PendingDownload) => void;
	statesById: StatesById;
	value: string;
}

interface GateArgs {
	assessDictationFitOnServer: AssessFitFn;
	currentQuantization: OnnxQuantization;
	deviceValue: DeviceValue;
	getModel: GetModelFn;
	kind: "main" | "realtime";
	previous: string;
	proceed: (
		kind: "main" | "realtime",
		value: string,
		previous: string,
		quantization: OnnxQuantization | undefined
	) => void;
	quantization: OnnxQuantization | undefined;
	setPendingFitWarning: (value: PendingFitWarning | null) => void;
	value: string;
}

interface HandleChangeArgs {
	currentModel: string;
	currentQuantization: OnnxQuantization;
	gateWithAssessment: (
		kind: "main" | "realtime",
		value: string,
		previous: string,
		quantization: OnnxQuantization | undefined
	) => Promise<void>;
	issueSwap: (
		kind: "main" | "realtime",
		value: string,
		previous: string,
		quantization?: OnnxQuantization
	) => void;
	kind: "main" | "realtime";
	quantization: OnnxQuantization | undefined;
	update: UpdateModelFn;
	value: string;
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
			runIssueSwap({
				kind,
				value,
				previous,
				quantization,
				currentQuantization,
				getModel,
				update,
				prevMainModelRef,
				prevRealtimeModelRef,
			});
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
		},
		[issueSwap, statesById, currentQuantization]
	);

	// Resource-aware gate: round-trip the server for an authoritative fit
	// verdict. If ``critical`` (won't fit given current load), surface the
	// ResourceWarningDialog and stash the onward action; otherwise proceed
	// straight to the existing download/swap path.
	const gateWithAssessment = useCallback(
		(
			kind: "main" | "realtime",
			v: string,
			previous: string,
			quantization: OnnxQuantization | undefined
		) =>
			runGateWithAssessment({
				kind,
				value: v,
				previous,
				quantization,
				currentQuantization,
				deviceValue,
				getModel,
				assessDictationFitOnServer,
				proceed: proceedWithSelection,
				setPendingFitWarning,
			}),
		[assessDictationFitOnServer, currentQuantization, deviceValue, getModel, proceedWithSelection]
	);

	const currentMainModel = resolveCurrentMainModel(settings, selectedModel);
	const currentRealtimeModel = resolveCurrentRealtimeModel(settings);

	const handleModelChange = useCallback(
		(v: string, quantization?: OnnxQuantization) => {
			runHandleMainChange({
				value: v,
				quantization,
				currentModel: currentMainModel,
				currentQuantization,
				kind: "main",
				update,
				issueSwap,
				gateWithAssessment,
			});
		},
		[gateWithAssessment, issueSwap, currentMainModel, currentQuantization, update]
	);

	const handleRealtimeModelChange = useCallback(
		(v: string, quantization?: OnnxQuantization) => {
			runHandleRealtimeChange({
				value: v,
				quantization,
				currentModel: currentRealtimeModel,
				currentQuantization,
				kind: "realtime",
				update,
				issueSwap,
				gateWithAssessment,
			});
		},
		[gateWithAssessment, issueSwap, currentRealtimeModel, currentQuantization, update]
	);

	// Kick off the swap (which triggers the download) but keep the modal
	// open so the user sees live progress and can Stop without re-clicking
	// the picker. Closing only happens on explicit Cancel/Esc or when the
	// download-complete event fires (handled below).
	const confirmPendingDownload = useCallback(() => {
		runConfirmPendingDownload(pendingDownload, issueSwap);
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
			onModelDownloadComplete((model, cancelled) =>
				handleDownloadCompleteEvent(model, cancelled, setPendingDownload)
			),
		[]
	);

	// Failure handler: roll the picker back to whatever was loaded before
	// the user's selection. Uses the per-kind ref captured at click time.
	useEffect(
		() =>
			onModelSwapFailed((event) =>
				handleSwapFailedEvent(event.kind, prevMainModelRef, prevRealtimeModelRef, update)
			),
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

function isQuantizationChanging(
	quantization: OnnxQuantization | undefined,
	currentQuantization: OnnxQuantization
): boolean {
	return quantization !== undefined && quantization !== currentQuantization;
}

function buildMainSwapPatch(
	value: string,
	info: ReturnType<GetModelFn>,
	quantization: OnnxQuantization | undefined,
	quantizationChanging: boolean
): UpdatePatch {
	const patch = baseMainPatch(value, info);
	return applyQuantOverride(patch, quantization, quantizationChanging);
}

function baseMainPatch(value: string, info: ReturnType<GetModelFn>): UpdatePatch {
	return info ? { model: value, backend: info.backend } : { model: value };
}

function buildRealtimeSwapPatch(
	value: string,
	quantization: OnnxQuantization | undefined,
	quantizationChanging: boolean
): UpdatePatch {
	const patch: UpdatePatch = { realtimeModel: value };
	return applyQuantOverride(patch, quantization, quantizationChanging);
}

function applyQuantOverride(
	patch: UpdatePatch,
	quantization: OnnxQuantization | undefined,
	quantizationChanging: boolean
): UpdatePatch {
	const overrides = quantizationChanging ? definedQuantPatches(quantization) : [];
	return Object.assign(patch, ...overrides);
}

function applyMainSwap(args: IssueSwapArgs, quantizationChanging: boolean): void {
	const info = args.getModel(args.value);
	args.prevMainModelRef.current = args.previous;
	args.update(buildMainSwapPatch(args.value, info, args.quantization, quantizationChanging));
}

function applyRealtimeSwap(args: IssueSwapArgs, quantizationChanging: boolean): void {
	args.prevRealtimeModelRef.current = args.previous;
	args.update(buildRealtimeSwapPatch(args.value, args.quantization, quantizationChanging));
}

function applySwapByKind(args: IssueSwapArgs, quantizationChanging: boolean): void {
	const handlers: Record<"main" | "realtime", () => void> = {
		main: () => applyMainSwap(args, quantizationChanging),
		realtime: () => applyRealtimeSwap(args, quantizationChanging),
	};
	handlers[args.kind]();
}

function maybeHotReload(
	kind: "main" | "realtime",
	value: string,
	quantizationChanging: boolean
): void {
	// model.onnxQuantization is a STARTUP_ONLY key — touching it triggers a
	// full server restart that boots with the new quantization (and the new
	// model field). Skip the hot-swap call to avoid racing the restart.
	const reloads = quantizationChanging ? [] : [() => sttReloadModel(kind, value)];
	reloads.forEach(invokeReload);
}

function invokeReload(fn: () => void): void {
	fn();
}

function runIssueSwap(args: IssueSwapArgs): void {
	const quantizationChanging = isQuantizationChanging(args.quantization, args.currentQuantization);
	applySwapByKind(args, quantizationChanging);
	maybeHotReload(args.kind, args.value, quantizationChanging);
}

function needsDownloadPrompt(
	state: ModelState | undefined,
	targetQuant: OnnxQuantization
): state is ModelState {
	const targetCache = resolveTargetCache(state, targetQuant);
	return Boolean(state) && targetCache?.state !== "cached";
}

function resolveTargetCache(
	state: ModelState | undefined,
	targetQuant: OnnxQuantization
): ReturnType<typeof resolveQuantCache> {
	const present = toPresentList(state);
	return mapFirstToCache(present, targetQuant);
}

function toPresentList(state: ModelState | undefined): ModelState[] {
	return state ? [state] : [];
}

function mapFirstToCache(
	present: ModelState[],
	targetQuant: OnnxQuantization
): ReturnType<typeof resolveQuantCache> {
	return present.map((s) => resolveQuantCache(s, targetQuant))[0];
}

function resolveTargetQuant(
	quantization: OnnxQuantization | undefined,
	currentQuantization: OnnxQuantization
): OnnxQuantization {
	return quantization ?? currentQuantization;
}

function runProceedWithSelection(args: ProceedArgs): void {
	// If the *target precision* isn't already on disk, prompt before
	// kicking off the download — a model can be cached at int8 but not
	// at fp16, so check the quantization the swap will actually load.
	const state = args.statesById[args.value];
	const targetQuant = resolveTargetQuant(args.quantization, args.currentQuantization);
	const branches = needsDownloadPrompt(state, targetQuant)
		? [() => promptDownload(args)]
		: [() => args.issueSwap(args.kind, args.value, args.previous, args.quantization)];
	branches.forEach(invokeReload);
}

function promptDownload(args: ProceedArgs): void {
	args.setPendingDownload({
		kind: args.kind,
		modelId: args.value,
		previousModelId: args.previous,
		quantization: args.quantization,
	});
}

function isCriticalAssessment(
	assessment: FitAssessmentEntry | null | undefined
): assessment is FitAssessmentEntry {
	return Boolean(assessment) && assessment?.severity === "critical";
}

function resolveCandidateName(getModel: GetModelFn, value: string): string {
	return getModel(value)?.displayName ?? value;
}

async function runGateWithAssessment(args: GateArgs): Promise<void> {
	const candidateName = resolveCandidateName(args.getModel, args.value);
	const targetQuant = resolveTargetQuant(args.quantization, args.currentQuantization);
	const assessment = await args.assessDictationFitOnServer(
		args.value,
		targetQuant,
		args.deviceValue
	);
	const branches = isCriticalAssessment(assessment)
		? [() => surfaceFitWarning(args, assessment, candidateName)]
		: [() => args.proceed(args.kind, args.value, args.previous, args.quantization)];
	branches.forEach(invokeReload);
}

function surfaceFitWarning(
	args: GateArgs,
	assessment: FitAssessmentEntry,
	candidateName: string
): void {
	args.setPendingFitWarning({
		assessment,
		candidateName,
		next: () => args.proceed(args.kind, args.value, args.previous, args.quantization),
	});
}

function resolveCurrentMainModel(
	settings: ModelSettings | undefined,
	selectedModel: string
): string {
	return settings?.model ?? selectedModel;
}

function resolveCurrentRealtimeModel(settings: ModelSettings | undefined): string {
	return settings?.realtimeModel ?? "";
}

function isCloudModel(value: string): boolean {
	return providerOf(value) !== null;
}

function applyPureQuantSwap(
	quantizationChanging: boolean,
	quantization: OnnxQuantization | undefined,
	update: UpdateModelFn
): void {
	// Pure quantization swap on the already-loaded model. Push the new
	// value; the STARTUP_ONLY restart handles the rest.
	const patches = quantizationChanging ? definedQuantPatches(quantization) : [];
	patches.forEach(update);
}

function definedQuantPatches(quantization: OnnxQuantization | undefined): UpdatePatch[] {
	const defined = quantization === undefined ? [] : [quantization];
	return defined.map(toQuantPatch);
}

function toQuantPatch(quantization: OnnxQuantization): UpdatePatch {
	return { onnxQuantization: quantization };
}

function dispatchChange(args: HandleChangeArgs): void {
	// Cloud model ids (`openai:…`, `elevenlabs:…`) skip the
	// catalog/cache/assessment gates — those guard local RAM/VRAM fit
	// and on-disk model caching, neither of which apply to a cloud
	// transcriber. Issue the swap directly so the server's unload-first
	// pipeline runs and frees the previous local model's memory.
	const branches = isCloudModel(args.value)
		? [() => args.issueSwap(args.kind, args.value, args.currentModel, args.quantization)]
		: [() => dispatchGate(args)];
	branches.forEach(invokeReload);
}

function dispatchGate(args: HandleChangeArgs): void {
	args
		.gateWithAssessment(args.kind, args.value, args.currentModel, args.quantization)
		.catch(reportSwapGateError);
}

function runHandleMainChange(args: HandleChangeArgs): void {
	const quantizationChanging = isQuantizationChanging(args.quantization, args.currentQuantization);
	const branches =
		args.value === args.currentModel
			? [() => applyPureQuantSwap(quantizationChanging, args.quantization, args.update)]
			: [() => dispatchChange(args)];
	branches.forEach(invokeReload);
}

function runHandleRealtimeChange(args: HandleChangeArgs): void {
	// Same cloud short-circuit as the main picker. See note above.
	const quantizationChanging = isQuantizationChanging(args.quantization, args.currentQuantization);
	const branches =
		args.value === args.currentModel
			? [() => applyPureQuantSwap(quantizationChanging, args.quantization, args.update)]
			: [() => dispatchChange(args)];
	branches.forEach(invokeReload);
}

function runConfirmPendingDownload(
	pendingDownload: PendingDownload | null,
	issueSwap: (
		kind: "main" | "realtime",
		value: string,
		previous: string,
		quantization?: OnnxQuantization
	) => void
): void {
	const present = pendingDownload === null ? [] : [pendingDownload];
	present.map(toIssueSwapInvoker(issueSwap)).forEach(invokeReload);
}

function toIssueSwapInvoker(
	issueSwap: (
		kind: "main" | "realtime",
		value: string,
		previous: string,
		quantization?: OnnxQuantization
	) => void
): (pd: PendingDownload) => () => void {
	return (pd) => () => issueSwap(pd.kind, pd.modelId, pd.previousModelId, pd.quantization);
}

function handleDownloadCompleteEvent(
	model: string,
	cancelled: boolean,
	setPendingDownload: React.Dispatch<React.SetStateAction<PendingDownload | null>>
): void {
	const handlers = cancelled ? [] : [() => closePendingDownloadFor(model, setPendingDownload)];
	handlers.forEach(invokeReload);
}

function closePendingDownloadFor(
	model: string,
	setPendingDownload: React.Dispatch<React.SetStateAction<PendingDownload | null>>
): void {
	setPendingDownload((current) => clearIfMatches(current, model));
}

function clearIfMatches(current: PendingDownload | null, model: string): PendingDownload | null {
	return matchesPending(current, model) ? null : current;
}

function matchesPending(current: PendingDownload | null, model: string): boolean {
	return current?.modelId === model;
}

function handleSwapFailedEvent(
	kind: "main" | "realtime",
	prevMainModelRef: React.MutableRefObject<string | null>,
	prevRealtimeModelRef: React.MutableRefObject<string | null>,
	update: UpdateModelFn
): void {
	const handlers: Record<"main" | "realtime", () => void> = {
		main: () => rollbackMain(prevMainModelRef, update),
		realtime: () => rollbackRealtime(prevRealtimeModelRef, update),
	};
	handlers[kind]();
}

function rollbackMain(
	prevMainModelRef: React.MutableRefObject<string | null>,
	update: UpdateModelFn
): void {
	const prev = prevMainModelRef.current;
	const patches = prev === null ? [] : [{ model: prev }];
	patches.forEach(update);
}

function rollbackRealtime(
	prevRealtimeModelRef: React.MutableRefObject<string | null>,
	update: UpdateModelFn
): void {
	const prev = prevRealtimeModelRef.current;
	const patches = prev === null ? [] : [{ realtimeModel: prev }];
	patches.forEach(update);
}

/** Test-only re-exports of the module-level helpers so the sibling
 *  `.test.ts` can exercise their branches without spinning up a React
 *  renderer. Keeps the public API of the slice limited to
 *  `useModelSwapController` while still satisfying the CRAP coverage gate.
 *  DO NOT import this from production code. */
export const __testables = {
	applyPureQuantSwap,
	applyQuantOverride,
	baseMainPatch,
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
	mapFirstToCache,
	matchesPending,
	maybeHotReload,
	needsDownloadPrompt,
	promptDownload,
	reportSwapGateError,
	resolveCandidateName,
	resolveCurrentMainModel,
	resolveCurrentRealtimeModel,
	resolveTargetCache,
	resolveTargetQuant,
	rollbackMain,
	rollbackRealtime,
	runConfirmPendingDownload,
	runHandleMainChange,
	runHandleRealtimeChange,
	runIssueSwap,
	runProceedWithSelection,
	surfaceFitWarning,
	toIssueSwapInvoker,
	toPresentList,
	toQuantPatch,
} as const;
