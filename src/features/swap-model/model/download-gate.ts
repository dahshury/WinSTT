// Deep-import the lightweight cache helpers (not the `@/widgets/model-picker` barrel) so this
// main-window-reachable feature doesn't drag the whole model-picker UI into the
// main entry chunk via the barrel re-export.
import {
	resolveEffectiveQuant,
	resolveQuantCache,
} from "@/widgets/model-picker/stt/lib/cache-helpers";
import {
	assessDictationFitClient,
	useSystemResourcesStore,
} from "@/entities/system-resources";
import type { FitAssessmentEntry } from "@/shared/api/ipc-client";
import {
	ONNX_QUANTIZATIONS,
	type OnnxQuantization,
} from "@/shared/config/defaults";
import { invokeReload, isCloudModel } from "./apply-swap";
import type {
	DeviceValue,
	GateArgs,
	GetModelFn,
	ModelState,
	ProceedArgs,
	StatesById,
} from "./swap-types";

export function needsDownloadPrompt(
	state: ModelState | undefined,
	targetQuant: OnnxQuantization,
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

export function resolveTargetCache(
	state: ModelState | undefined,
	targetQuant: OnnxQuantization,
): ReturnType<typeof resolveQuantCache> {
	const present = toPresentList(state);
	return mapFirstToCache(present, targetQuant);
}

export function toPresentList(state: ModelState | undefined): ModelState[] {
	return state ? [state] : [];
}

export function mapFirstToCache(
	present: ModelState[],
	targetQuant: OnnxQuantization,
): ReturnType<typeof resolveQuantCache> {
	return present.map((s) => resolveQuantCache(s, targetQuant))[0];
}

export function resolveTargetQuant(
	quantization: OnnxQuantization | undefined,
	currentQuantization: OnnxQuantization,
	state?: ModelState | undefined,
): OnnxQuantization {
	// The precision the SERVER will actually load. The auto/default sentinel
	// ("") is re-resolved per model by the server (NeMo / Cohere / GigaAM /…
	// → int8 on non-CUDA) and surfaced as ``effective_quantization``; honor
	// it so the cache check targets the file set that truly loads. A concrete
	// pick (int8/fp16/…) passes through. Without this, switching to canary on
	// auto checks the (cached) default export and silently background-loads
	// the uncached int8 weights.
	const selected = quantization ?? currentQuantization;
	return toOnnxQuantization(resolveEffectiveQuant(state, selected), selected);
}

/** ``resolveEffectiveQuant`` returns the server-reported ``effective_quantization``
 *  string, which we can't statically prove is one of our known tiers. Validate it
 *  against the ``ONNX_QUANTIZATIONS`` union instead of an unchecked ``as`` — an
 *  unrecognized server value falls back to the (already-typed) selected tier
 *  rather than poisoning the cache check with a bogus quant. */
function isOnnxQuantization(value: string): value is OnnxQuantization {
	return (ONNX_QUANTIZATIONS as readonly string[]).includes(value);
}

function toOnnxQuantization(
	value: string,
	fallback: OnnxQuantization,
): OnnxQuantization {
	return isOnnxQuantization(value) ? value : fallback;
}

/** True when a swap to ``(value, target precision)`` must be refused because
 *  that precision is mid-download. Mirrors the target-quant resolution the swap
 *  itself uses (``resolveTargetQuant``) so a row-select (no explicit quant →
 *  effective) and a precision-badge click (explicit quant) are both checked
 *  against the precision that would actually load. */
export function isSwapBlockedByDownload(
	value: string,
	quantization: OnnxQuantization | undefined,
	currentQuantization: OnnxQuantization,
	statesById: StatesById,
	isQuantDownloading: (modelId: string, quantization: string) => boolean,
): boolean {
	const targetQuant = resolveTargetQuant(
		quantization,
		currentQuantization,
		statesById[value],
	);
	return isQuantDownloading(value, targetQuant);
}

export function runProceedWithSelection(args: ProceedArgs): void {
	// If the *target precision* isn't already on disk, prompt before
	// kicking off the download — a model can be cached at int8 but not
	// at fp16, so check the quantization the swap will actually load.
	const state = args.statesById[args.value];
	const targetQuant = resolveTargetQuant(
		args.quantization,
		args.currentQuantization,
		state,
	);
	const branches = needsDownloadPrompt(state, targetQuant)
		? [() => promptDownload(args)]
		: [
				() =>
					args.issueSwap(
						args.kind,
						args.value,
						args.previous,
						args.quantization,
					),
			];
	branches.forEach(invokeReload);
}

export function promptDownload(args: ProceedArgs): void {
	args.setPendingDownload({
		kind: args.kind,
		modelId: args.value,
		previousModelId: args.previous,
		quantization: args.quantization,
	});
}

export function isCriticalAssessment(
	assessment: FitAssessmentEntry | null | undefined,
): assessment is FitAssessmentEntry {
	return Boolean(assessment) && assessment?.severity === "critical";
}

export function resolveCandidateName(
	getModel: GetModelFn,
	value: string,
): string {
	return getModel(value)?.displayName ?? value;
}

function requestedDeviceForFit(deviceValue: DeviceValue): string | null {
	return deviceValue === "cpu" ? "cpu" : null;
}

function localModelIdOrNull(modelId: string | undefined): string | null {
	if (!modelId || isCloudModel(modelId)) {
		return null;
	}
	return modelId;
}

function quantForFit(
	statesById: StatesById,
	modelId: string | null,
	currentQuantization: OnnxQuantization,
): string {
	return modelId
		? resolveEffectiveQuant(statesById[modelId], currentQuantization)
		: "";
}

function clientGateAssessment(
	args: GateArgs,
	targetQuant: OnnxQuantization,
): FitAssessmentEntry | null {
	const live = useSystemResourcesStore.getState().liveResources;
	if (live === null) {
		return null;
	}
	const mainId = localModelIdOrNull(args.currentMainModel);
	const realtimeId = localModelIdOrNull(args.currentRealtimeModel);
	return assessDictationFitClient(args.value, {
		candidateQuant: targetQuant,
		live,
		loaded: {
			mainId,
			mainQuant: quantForFit(args.statesById, mainId, args.currentQuantization),
			realtimeId,
			realtimeQuant: quantForFit(
				args.statesById,
				realtimeId,
				args.currentQuantization,
			),
		},
		requestedDevice: requestedDeviceForFit(args.deviceValue),
		statesById: args.statesById,
	});
}

export async function runGateWithAssessment(args: GateArgs): Promise<void> {
	const candidateName = resolveCandidateName(args.getModel, args.value);
	const targetQuant = resolveTargetQuant(
		args.quantization,
		args.currentQuantization,
		args.statesById[args.value],
	);
	const serverAssessment = await args.assessDictationFitOnServer(
		args.value,
		targetQuant,
		args.deviceValue,
	);
	const assessment =
		serverAssessment ?? clientGateAssessment(args, targetQuant);
	const branches = isCriticalAssessment(assessment)
		? [() => surfaceFitWarning(args, assessment, candidateName)]
		: [
				() =>
					args.proceed(args.kind, args.value, args.previous, args.quantization),
			];
	branches.forEach(invokeReload);
}

export function surfaceFitWarning(
	args: GateArgs,
	assessment: FitAssessmentEntry,
	candidateName: string,
): void {
	args.setPendingFitWarning({
		assessment,
		candidateName,
		next: () =>
			args.proceed(args.kind, args.value, args.previous, args.quantization),
	});
}

/** Fire-and-forget guard for the model-swap gate. The gate already surfaces
 *  user-facing failures via the resource/download dialogs; this only keeps an
 *  unexpected rejection from becoming an unhandled promise. */
export function reportSwapGateError(err: unknown): void {
	console.error("model swap gate failed", err);
}
