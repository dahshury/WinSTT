import {
	isSelectableRealtimeModel,
	isVisibleSttModel,
	modelsHaveLanguageOverlap,
	useModelSwapStore,
} from "@/entities/model-catalog";
import { providerOf } from "@/entities/cloud-stt-provider";
import { sttReloadModel } from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import type {
	GetModelFn,
	IssueSwapArgs,
	UpdateModelFn,
	UpdatePatch,
} from "./swap-types";

export function isQuantizationChanging(
	quantization: OnnxQuantization | undefined,
	currentQuantization: OnnxQuantization,
): boolean {
	return quantization !== undefined && quantization !== currentQuantization;
}

export function buildMainSwapPatch(
	value: string,
	info: NonNullable<ReturnType<GetModelFn>>,
	quantization: OnnxQuantization | undefined,
	quantizationChanging: boolean,
): UpdatePatch {
	const patch: UpdatePatch = { model: value, backend: info.backend };
	return applyQuantOverride(patch, quantization, quantizationChanging);
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

// Cloud transcribers carry no local weights and aren't catalog entries, so
// the server's ``build_transcriber`` routes them purely by the ``provider:``
// prefix and never reads ``backend``. The renderer's ``ModelPatch`` still
// requires a backend when ``model`` is set, so persist a benign valid value.
const CLOUD_MODEL_BACKEND = "onnx_asr" as const;

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
			args.prevMainModelRef.current = args.previous;
			useModelSwapStore.getState().beginSwap("main", args.previous, args.value);
			args.update({ model: args.value, backend: CLOUD_MODEL_BACKEND });
			return true;
		}
		// A genuinely-missing LOCAL id can't form a valid ``{ model, backend }``
		// pair, so bail rather than write an inconsistent couple.
		return false;
	}
	if (!isVisibleSttModel(info)) {
		return false;
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
	const patch = buildMainSwapPatch(
		args.value,
		info,
		args.quantization,
		quantizationChanging,
	);
	Object.assign(
		patch,
		realtimePatchForMainSwap(info, args.currentRealtimeModel, args.getModel) ??
			{},
	);
	args.update(patch);
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
		args.prevRealtimeModelRef.current = args.previous;
		useModelSwapStore
			.getState()
			.beginSwap("realtime", args.previous, args.value);
		args.update(
			buildRealtimeSwapPatch("", args.quantization, quantizationChanging),
		);
		return true;
	}
	const realtimeInfo = args.getModel(args.value);
	if (
		!realtimeInfo ||
		!isRealtimeCompatibleWithCurrentMain(
			realtimeInfo,
			args.currentMainModel,
			args.getModel,
		)
	) {
		return false;
	}
	args.prevRealtimeModelRef.current = args.previous;
	// See applyMainSwap — same race; the realtime slot has the same
	// reconciler guard via ``activeRealtime``.
	useModelSwapStore.getState().beginSwap("realtime", args.previous, args.value);
	args.update(
		buildRealtimeSwapPatch(args.value, args.quantization, quantizationChanging),
	);
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

/** Whether to fire the explicit in-place model reload for a hot swap.
 *  Skips ONLY a pure same-model quant change: the settings save owns that
 *  backend reload after the new quantization is persisted. */
export function shouldReloadForHotSwap(
	quantizationChanging: boolean,
	modelChanging: boolean,
): boolean {
	return modelChanging || !quantizationChanging;
}

export function maybeHotReload(
	kind: "main" | "realtime",
	value: string,
	quantization: OnnxQuantization | undefined,
	quantizationChanging: boolean,
	modelChanging: boolean,
): void {
	// Decide whether to fire the in-place model reload (``reload_main_model``
	// / ``reload_realtime_model``), which loads ``value`` at the server's
	// CURRENT onnx_quantization config.
	//
	// - Model changed → ALWAYS reload, even if the quant is also changing.
	//   ``onnxQuantization`` is no longer a startup-only key. Skipping the
	//   reload on a cross-model pick left the OLD model loaded while settings
	//   moved to the new id, so the user's new model never loaded and the swap
	//   chip spun forever.
	// - Only the quant changed (same model) → skip the immediate reload here.
	//   The Tauri settings save path observes the same-model load-input change
	//   after persistence and reloads/unloads the resident engine with the new
	//   quantization. Firing reload_main_model here can race ahead of that save
	//   and rebuild the old quant.
	const reloads = shouldReloadForHotSwap(quantizationChanging, modelChanging)
		? [() => sttReloadModel(kind, value, quantization)]
		: [];
	reloads.forEach(invokeReload);
}

export function invokeReload(fn: () => void): void {
	fn();
}

export function runIssueSwap(args: IssueSwapArgs): void {
	const quantizationChanging = isQuantizationChanging(
		args.quantization,
		args.currentQuantization,
	);
	const modelChanging = args.value !== args.previous;
	const applied = applySwapByKind(args, quantizationChanging);
	if (!applied) {
		return;
	}
	maybeHotReload(
		args.kind,
		args.value,
		args.quantization,
		quantizationChanging,
		modelChanging,
	);
}

export function applyPureQuantSwap(
	quantizationChanging: boolean,
	quantization: OnnxQuantization | undefined,
	update: UpdateModelFn,
): void {
	// Pure quantization swap on the already-loaded model. Persist the new value;
	// the Tauri settings-save path reloads or unloads the resident engine after
	// the quantization is saved.
	const patches = quantizationChanging ? definedQuantPatches(quantization) : [];
	patches.forEach(update);
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
