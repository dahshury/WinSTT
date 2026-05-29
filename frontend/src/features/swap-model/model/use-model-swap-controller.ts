import { resolveEffectiveQuant, resolveQuantCache } from "@picker";
import { useCallback, useEffect, useRef, useState } from "react";
import { providerOf } from "@/entities/cloud-stt-provider";
import {
	type useCatalogStore,
	type useModelStateStore,
	useModelSwapStore,
} from "@/entities/model-catalog";
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
	statesById: StatesById;
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
				statesById,
			}),
		[
			assessDictationFitOnServer,
			currentQuantization,
			deviceValue,
			getModel,
			proceedWithSelection,
			statesById,
		]
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
				handleSwapFailedEvent(
					event.kind,
					event.category,
					prevMainModelRef,
					prevRealtimeModelRef,
					update,
					getModel
				)
			),
		[update, getModel]
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
	info: NonNullable<ReturnType<GetModelFn>>,
	quantization: OnnxQuantization | undefined,
	quantizationChanging: boolean
): UpdatePatch {
	const patch: UpdatePatch = { model: value, backend: info.backend };
	return applyQuantOverride(patch, quantization, quantizationChanging);
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
	// The picker only surfaces models that are in the catalog, so ``info``
	// is always defined in production. Bail rather than write an inconsistent
	// ``{ model, backend? }`` pair — the typed ``ModelPatch`` would reject
	// that anyway, but the explicit guard makes the invariant readable.
	if (!info) {
		return;
	}
	args.prevMainModelRef.current = args.previous;
	// Synchronously open the swap-in-flight guard BEFORE settings.model
	// changes. ``useSyncActiveModel`` short-circuits on ``activeMain !==
	// null``; if we wait for the server's ``model_swap_started`` echo to
	// flip it (~50ms later), the renderer's next render sees the new
	// settings.model vs the still-stale runtimeInfo.model and "adopts"
	// the runtime back into settings — reverting the user's pick. The
	// regression-guard comment in use-sync-active-model.ts assumed this
	// already happened.
	useModelSwapStore.getState().beginSwap("main", args.previous, args.value);
	args.update(buildMainSwapPatch(args.value, info, args.quantization, quantizationChanging));
}

function applyRealtimeSwap(args: IssueSwapArgs, quantizationChanging: boolean): void {
	args.prevRealtimeModelRef.current = args.previous;
	// See applyMainSwap — same race; the realtime slot has the same
	// reconciler guard via ``activeRealtime``.
	useModelSwapStore.getState().beginSwap("realtime", args.previous, args.value);
	args.update(buildRealtimeSwapPatch(args.value, args.quantization, quantizationChanging));
}

function applySwapByKind(args: IssueSwapArgs, quantizationChanging: boolean): void {
	const handlers: Record<"main" | "realtime", () => void> = {
		main: () => applyMainSwap(args, quantizationChanging),
		realtime: () => applyRealtimeSwap(args, quantizationChanging),
	};
	handlers[args.kind]();
}

/** Whether to fire the in-place ``reload_*_model`` for a hot swap.
 *  Skips ONLY a pure same-model quant change — that reload is driven by the
 *  ``set_parameter("onnx_quantization")`` push instead. See the call site
 *  for the full rationale + regression history. */
function shouldReloadForHotSwap(quantizationChanging: boolean, modelChanging: boolean): boolean {
	return modelChanging || !quantizationChanging;
}

function maybeHotReload(
	kind: "main" | "realtime",
	value: string,
	quantizationChanging: boolean,
	modelChanging: boolean
): void {
	// Decide whether to fire the in-place model reload (``reload_main_model``
	// / ``reload_realtime_model``), which loads ``value`` at the server's
	// CURRENT onnx_quantization config.
	//
	// - Model changed → ALWAYS reload, even if the quant is also changing.
	//   ``onnxQuantization`` is no longer a STARTUP_ONLY key (it's hot-applied
	//   via ``set_parameter("onnx_quantization")`` from sync-actions.ts), so
	//   the old "skip the reload, a restart will load the new model" assumption
	//   is dead — there is no restart. Skipping the reload on a cross-model
	//   pick left the OLD model loaded (only the quant set_parameter fired,
	//   which reloads whatever model is current) → the user's new model never
	//   loaded and the swap chip spun forever.
	// - Only the quant changed (same model) → skip the reload here; the
	//   ``set_parameter("onnx_quantization")`` push already triggers a reload
	//   of the current model at the new precision. Firing reload_main_model
	//   too would just be a redundant superseding swap.
	const reloads = shouldReloadForHotSwap(quantizationChanging, modelChanging)
		? [() => sttReloadModel(kind, value)]
		: [];
	reloads.forEach(invokeReload);
}

function invokeReload(fn: () => void): void {
	fn();
}

function runIssueSwap(args: IssueSwapArgs): void {
	const quantizationChanging = isQuantizationChanging(args.quantization, args.currentQuantization);
	const modelChanging = args.value !== args.previous;
	applySwapByKind(args, quantizationChanging);
	maybeHotReload(args.kind, args.value, quantizationChanging, modelChanging);
}

function needsDownloadPrompt(
	state: ModelState | undefined,
	targetQuant: OnnxQuantization
): boolean {
	// Unknown state → fail SAFE to "prompt for download". ``state`` is
	// ``undefined`` when the model-state map hasn't loaded yet (e.g. the
	// startup ``list_models_with_state`` IPC timed out, which the logs show
	// happening on a slow server-ready). The old ``Boolean(state) && …``
	// guard failed OPEN: with no state it returned false and the caller
	// issued a silent swap that assumed the weights were already on disk —
	// so clicking a not-downloaded quant badge kicked off a swap (spinner
	// on) instead of a download, and nothing ever loaded. We can't prove
	// the quant is cached without state, and the badge is rendering its
	// not-cached style anyway, so prompting is the correct, honest default.
	if (state === undefined) {
		return true;
	}
	const targetCache = resolveTargetCache(state, targetQuant);
	return targetCache?.state !== "cached";
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
	currentQuantization: OnnxQuantization,
	state?: ModelState | undefined
): OnnxQuantization {
	// The precision the SERVER will actually load. The auto/default sentinel
	// ("") is re-resolved per model by the server (NeMo / Cohere / GigaAM /…
	// → int8 on non-CUDA) and surfaced as ``effective_quantization``; honor
	// it so the cache check targets the file set that truly loads. A concrete
	// pick (int8/fp16/…) passes through. Without this, switching to canary on
	// auto checks the (cached) default export and silently background-loads
	// the uncached int8 weights.
	const selected = quantization ?? currentQuantization;
	return resolveEffectiveQuant(state, selected) as OnnxQuantization;
}

function runProceedWithSelection(args: ProceedArgs): void {
	// If the *target precision* isn't already on disk, prompt before
	// kicking off the download — a model can be cached at int8 but not
	// at fp16, so check the quantization the swap will actually load.
	const state = args.statesById[args.value];
	const targetQuant = resolveTargetQuant(args.quantization, args.currentQuantization, state);
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
	const targetQuant = resolveTargetQuant(
		args.quantization,
		args.currentQuantization,
		args.statesById[args.value]
	);
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
	// True no-op: same model + same quant. Skip the gate so we don't trigger
	// the assessment round-trip and the begin/clear chrome for a setting that
	// didn't change.
	if (
		args.value === args.currentModel &&
		!isQuantizationChanging(args.quantization, args.currentQuantization)
	) {
		return;
	}
	// Always route through the gate. The old short-circuit to applyPureQuantSwap
	// skipped the cache-state check, so a pure-quant swap to an uncached quant
	// restarted the server with --onnx_quantization X, the server tried to
	// fetch silently, the load failed, model_swap_failed fired, and the picker
	// rolled back to the previous selection — the "default-quant revert"
	// symptom on Cohere. Routing through dispatchChange opens the download
	// dialog when the target quant isn't on disk.
	dispatchChange(args);
}

function runHandleRealtimeChange(args: HandleChangeArgs): void {
	// Mirror runHandleMainChange — same no-op short-circuit, same gate.
	if (
		args.value === args.currentModel &&
		!isQuantizationChanging(args.quantization, args.currentQuantization)
	) {
		return;
	}
	dispatchChange(args);
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

/** Swap-failure categories that are NOT genuine failures and must NOT roll the
 *  picker back:
 *   - ``superseded``: a newer swap took over — IT owns the final model; rolling
 *     back here reverts the picker (and persisted settings) off the model the
 *     winning swap committed (the "switch reverts to the old model" bug).
 *   - ``cancelled``: the user aborted the swap themselves; the picker already
 *     reflects their intent. */
const NON_ROLLBACK_SWAP_FAILURE_CATEGORIES: ReadonlySet<string> = new Set([
	"superseded",
	"cancelled",
]);

function handleSwapFailedEvent(
	kind: "main" | "realtime",
	category: string,
	prevMainModelRef: React.MutableRefObject<string | null>,
	prevRealtimeModelRef: React.MutableRefObject<string | null>,
	update: UpdateModelFn,
	getModel: GetModelFn
): void {
	if (NON_ROLLBACK_SWAP_FAILURE_CATEGORIES.has(category)) {
		return;
	}
	const handlers: Record<"main" | "realtime", () => void> = {
		main: () => rollbackMain(prevMainModelRef, update, getModel),
		realtime: () => rollbackRealtime(prevRealtimeModelRef, update),
	};
	handlers[kind]();
}

function rollbackMain(
	prevMainModelRef: React.MutableRefObject<string | null>,
	update: UpdateModelFn,
	getModel: GetModelFn
): void {
	const prev = prevMainModelRef.current;
	if (prev === null) {
		return;
	}
	// Resolve backend so the rollback patch is well-formed under the typed
	// ``ModelPatch`` — writing ``{ model: prev }`` alone is the same drift
	// pattern that produced model/backend mismatches on disk.
	const info = getModel(prev);
	if (info?.backend) {
		update({ model: prev, backend: info.backend });
	}
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
	runGateWithAssessment,
	runHandleMainChange,
	runHandleRealtimeChange,
	runIssueSwap,
	runProceedWithSelection,
	shouldReloadForHotSwap,
	surfaceFitWarning,
	toIssueSwapInvoker,
	toPresentList,
	toQuantPatch,
} as const;
