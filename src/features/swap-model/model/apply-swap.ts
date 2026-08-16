import {
	isSelectableRealtimeModel,
	isVisibleSttModel,
	modelsHaveLanguageOverlap,
	type SwapQuant,
	useModelSwapStore,
} from "@/entities/model-catalog";
import { providerOf } from "@/entities/cloud-stt-provider";
import type { SttSwitchModelRequest, SttSwitchModelResult } from "@/bindings";
import {
	nextSttSwitchRequestId,
	requestSttModelSwitch,
} from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import type { GetModelFn, IssueSwapArgs, UpdatePatch } from "./swap-types";

export function isQuantizationChanging(
	quantization: OnnxQuantization | undefined,
	currentQuantization: OnnxQuantization,
): boolean {
	return quantization !== undefined && quantization !== currentQuantization;
}

/** The precision transition to surface in the swap-in-flight trigger. Only a
 *  genuine precision change carries one — a plain model switch that keeps the
 *  precision returns null so the trigger shows the model→model row alone. The
 *  swap store holds this so the picker can render "FP32 → INT8" even for a pure
 *  same-model quant swap (where the model legs are identical). */
export function swapQuantTransition(
	quantization: OnnxQuantization | undefined,
	quantizationChanging: boolean,
	currentQuantization: OnnxQuantization,
): SwapQuant | null {
	if (!(quantizationChanging && quantization !== undefined)) {
		return null;
	}
	return { from: currentQuantization, to: quantization };
}

/** The concrete default-file precision sentinel. It ships with every catalog
 *  entry. The separate persisted `"auto"` selection is also universal and the
 *  server re-resolves it per model (e.g. NeMo / parakeet → int8). */
const DEFAULT_QUANTIZATION: OnnxQuantization = "";
export function buildAtomicSwitchRequest(
	args: IssueSwapArgs,
	patch: UpdatePatch,
): SttSwitchModelRequest {
	const quantization =
		"onnxQuantization" in patch
			? (patch.onnxQuantization ?? args.currentQuantization)
			: args.currentQuantization;
	const realtimeModel =
		"realtimeModel" in patch ? (patch.realtimeModel ?? null) : null;
	return {
		kind: args.kind,
		modelId: args.value,
		quantization,
		device: args.atomicDevice ?? null,
		realtimeModel,
		requestId: nextSttSwitchRequestId("picker"),
		forceReload: false,
	};
}

function invokeAtomicMainSwitch(request: SttSwitchModelRequest): void {
	void requestSttModelSwitch(request)
		.then((result: SttSwitchModelResult) => {
			// Lifecycle events normally clear this state in every window. The response
			// is a second, correlated terminal signal for event-loss/teardown edges.
			if (result.status !== "completed") {
				useModelSwapStore.getState().clear("main", result.requestId);
			}
		})
		.catch((error: unknown) => {
			console.error("Atomic STT model switch failed", error);
			useModelSwapStore.getState().clear("main", request.requestId);
		});
}

function dispatchAtomicMainSwitch(
	args: IssueSwapArgs,
	request: SttSwitchModelRequest,
): void {
	(args.atomicInvoker ?? invokeAtomicMainSwitch)(request);
}

/** True when ``info`` ships ``quantization`` (or it's the universal default). */
function modelOffersQuantization(
	info: NonNullable<ReturnType<GetModelFn>>,
	quantization: OnnxQuantization | "auto",
): boolean {
	if (quantization === DEFAULT_QUANTIZATION || quantization === "auto") {
		return true;
	}
	const available = info.availableQuantizations;
	// A partial / cloud entry that carries no precision list → don't force a
	// change (we can't prove the precision is unavailable).
	return Array.isArray(available) ? available.includes(quantization) : true;
}

/** Resolve the precision to persist for the model being switched TO. A model
 *  switch must NOT carry the previous model's precision onto a model that doesn't
 *  offer it (e.g. tiny's ``q4`` onto parakeet, which only ships ``["", "int8"]`` —
 *  the source of the rejected ``settings:save``). Returns ``undefined`` when no
 *  ``onnxQuantization`` override is needed (the carried value is already valid):
 *   - an explicit user pick wins (respect the newly selected precision);
 *   - else keep the carried-over precision when the new model offers it;
 *   - else fall back to the new model's default precision. */
function resolveSwapQuantization(
	info: NonNullable<ReturnType<GetModelFn>>,
	quantization: OnnxQuantization | undefined,
	quantizationChanging: boolean,
	currentQuantization: OnnxQuantization | "auto",
): OnnxQuantization | undefined {
	if (quantizationChanging) {
		return quantization;
	}
	return modelOffersQuantization(info, currentQuantization)
		? undefined
		: DEFAULT_QUANTIZATION;
}

export function buildMainSwapPatch(
	value: string,
	info: NonNullable<ReturnType<GetModelFn>>,
	quantization: OnnxQuantization | undefined,
	quantizationChanging: boolean,
	currentQuantization: OnnxQuantization | "auto" = DEFAULT_QUANTIZATION,
): UpdatePatch {
	const patch: UpdatePatch = { model: value };
	const resolved = resolveSwapQuantization(
		info,
		quantization,
		quantizationChanging,
		currentQuantization,
	);
	if (resolved !== undefined) {
		Object.assign(patch, toQuantPatch(resolved));
	}
	return patch;
}

export function buildRealtimeSwapPatch(
	value: string,
	quantization: OnnxQuantization | undefined,
	quantizationChanging: boolean,
): UpdatePatch {
	const patch: UpdatePatch = { realtimeModel: value };
	return applyQuantOverride(patch, quantization, quantizationChanging);
}

export function realtimePatchForMainSwap(
	mainInfo: NonNullable<ReturnType<GetModelFn>>,
	currentRealtimeModel: string | undefined,
	getModel: GetModelFn,
): UpdatePatch | null {
	if (isSelectableRealtimeModel(mainInfo)) {
		return currentRealtimeModel === mainInfo.id
			? null
			: { realtimeModel: mainInfo.id };
	}
	if (!currentRealtimeModel) {
		return null;
	}
	const realtimeInfo = getModel(currentRealtimeModel);
	if (!realtimeInfo) {
		return { realtimeModel: "" };
	}
	if (!isSelectableRealtimeModel(realtimeInfo)) {
		return { realtimeModel: "" };
	}
	return modelsHaveLanguageOverlap(mainInfo, realtimeInfo)
		? null
		: { realtimeModel: "" };
}

function isRealtimeCompatibleWithCurrentMain(
	realtimeInfo: NonNullable<ReturnType<GetModelFn>>,
	currentMainModel: string | undefined,
	getModel: GetModelFn,
): boolean {
	if (!isSelectableRealtimeModel(realtimeInfo)) {
		return false;
	}
	if (!currentMainModel || isCloudModel(currentMainModel)) {
		return true;
	}
	const mainInfo = getModel(currentMainModel);
	if (!mainInfo) {
		return true;
	}
	if (isSelectableRealtimeModel(mainInfo)) {
		return realtimeInfo.id === mainInfo.id;
	}
	return modelsHaveLanguageOverlap(mainInfo, realtimeInfo);
}

export function applyQuantOverride(
	patch: UpdatePatch,
	quantization: OnnxQuantization | undefined,
	quantizationChanging: boolean,
): UpdatePatch {
	const overrides = quantizationChanging
		? definedQuantPatches(quantization)
		: [];
	return Object.assign(patch, ...overrides);
}

function applyMainSwap(
	args: IssueSwapArgs,
	quantizationChanging: boolean,
): boolean {
	const info = args.getModel(args.value);
	// Cloud models (``openai:…`` / ``elevenlabs:…``) have no catalog entry, so
	// ``getModel`` returns undefined. Persist the selection anyway — without
	// this the swap silently no-ops and the cloud combo shows "no model
	// chosen" (the picker never reflects the pick, and the auto-select on
	// switching the source to Cloud appears to do nothing).
	if (!info) {
		if (isCloudModel(args.value)) {
			const patch: UpdatePatch = { model: args.value };
			const request = buildAtomicSwitchRequest(args, patch);
			useModelSwapStore
				.getState()
				.beginSwap("main", args.previous, args.value, null, request.requestId);
			dispatchAtomicMainSwitch(args, request);
			return true;
		}
		// A genuinely-missing LOCAL id isn't a real catalog selection, so bail
		// rather than persist an id the picker can't resolve.
		return false;
	}
	if (!isVisibleSttModel(info)) {
		return false;
	}
	// Synchronously open the swap-in-flight guard BEFORE settings.model
	// changes. ``useSyncActiveModel`` short-circuits on ``activeMain !==
	// null``; if we wait for the server's ``model_swap_started`` echo to
	// flip it (~50ms later), the renderer's next render sees the new
	// settings.model vs the still-stale runtimeInfo.model and "adopts"
	// the runtime back into settings — reverting the user's pick. The
	// regression-guard comment in use-sync-active-model.ts assumed this
	// already happened.
	const patch = buildMainSwapPatch(
		args.value,
		info,
		args.quantization,
		quantizationChanging,
		args.currentQuantization,
	);
	Object.assign(
		patch,
		realtimePatchForMainSwap(info, args.currentRealtimeModel, args.getModel) ??
			{},
	);
	const quantTransition = swapQuantTransition(
		args.quantization,
		quantizationChanging,
		args.currentQuantization,
	);
	const request = buildAtomicSwitchRequest(args, patch);
	useModelSwapStore
		.getState()
		.beginSwap(
			"main",
			args.previous,
			args.value,
			quantTransition,
			request.requestId,
		);
	dispatchAtomicMainSwitch(args, request);
	return true;
}

function applyRealtimeSwap(
	args: IssueSwapArgs,
	quantizationChanging: boolean,
): boolean {
	if (!args.value) {
		const mainInfo = args.currentMainModel
			? args.getModel(args.currentMainModel)
			: undefined;
		if (mainInfo && isSelectableRealtimeModel(mainInfo)) {
			return false;
		}
		const patch = buildRealtimeSwapPatch(
			"",
			args.quantization,
			quantizationChanging,
		);
		const request = buildAtomicSwitchRequest(args, patch);
		useModelSwapStore
			.getState()
			.beginSwap(
				"realtime",
				args.previous,
				args.value,
				null,
				request.requestId,
			);
		dispatchAtomicMainSwitch(args, request);
		return true;
	}
	const realtimeInfo = args.getModel(args.value);
	if (
		!(
			realtimeInfo &&
			isRealtimeCompatibleWithCurrentMain(
				realtimeInfo,
				args.currentMainModel,
				args.getModel,
			)
		)
	) {
		return false;
	}
	// See applyMainSwap — same race; the realtime slot has the same
	// reconciler guard via ``activeRealtime``.
	const patch = buildRealtimeSwapPatch(
		args.value,
		args.quantization,
		quantizationChanging,
	);
	const request = buildAtomicSwitchRequest(args, patch);
	useModelSwapStore
		.getState()
		.beginSwap(
			"realtime",
			args.previous,
			args.value,
			swapQuantTransition(
				args.quantization,
				quantizationChanging,
				args.currentQuantization,
			),
			request.requestId,
		);
	dispatchAtomicMainSwitch(args, request);
	return true;
}

function applySwapByKind(
	args: IssueSwapArgs,
	quantizationChanging: boolean,
): boolean {
	const handlers: Record<"main" | "realtime", () => boolean> = {
		main: () => applyMainSwap(args, quantizationChanging),
		realtime: () => applyRealtimeSwap(args, quantizationChanging),
	};
	return handlers[args.kind]();
}

export function runIssueSwap(args: IssueSwapArgs): void {
	const quantizationChanging = isQuantizationChanging(
		args.quantization,
		args.currentQuantization,
	);
	applySwapByKind(args, quantizationChanging);
}

export function definedQuantPatches(
	quantization: OnnxQuantization | undefined,
): UpdatePatch[] {
	const defined = quantization === undefined ? [] : [quantization];
	return defined.map(toQuantPatch);
}

export function toQuantPatch(quantization: OnnxQuantization): UpdatePatch {
	return { onnxQuantization: quantization };
}

export function isCloudModel(value: string): boolean {
	return providerOf(value) !== null;
}
