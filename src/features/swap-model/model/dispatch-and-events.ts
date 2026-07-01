import type { OnnxQuantization } from "@/shared/config/defaults";
import { isCloudModel, isQuantizationChanging } from "./apply-swap";
import { reportSwapGateError } from "./download-gate";
import type {
	GetModelFn,
	HandleChangeArgs,
	ModelSettings,
	PendingDownload,
	UpdateModelFn,
} from "./swap-types";

export function resolveCurrentMainModel(
	settings: ModelSettings | undefined,
	selectedModel: string,
): string {
	return settings?.model ?? selectedModel;
}

export function resolveCurrentRealtimeModel(
	settings: ModelSettings | undefined,
): string {
	return settings?.realtimeModel ?? "";
}

export function dispatchChange(args: HandleChangeArgs): void {
	// Cloud model ids (`openai:…`, `elevenlabs:…`) skip the
	// catalog/cache/assessment gates — those guard local RAM/VRAM fit
	// and on-disk model caching, neither of which apply to a cloud
	// transcriber. Issue the swap directly so the server's unload-first
	// pipeline runs and frees the previous local model's memory.
	if (isCloudModel(args.value)) {
		args.issueSwap(args.kind, args.value, args.currentModel, args.quantization);
		return;
	}
	dispatchGate(args);
}

export function dispatchGate(args: HandleChangeArgs): void {
	args
		.gateWithAssessment(
			args.kind,
			args.value,
			args.currentModel,
			args.quantization,
		)
		.catch(reportSwapGateError);
}

export function runHandleChange(args: HandleChangeArgs): void {
	// True no-op: same model + same quant. Skip the gate so we don't trigger
	// the assessment round-trip and the begin/clear chrome for a setting that
	// didn't change. (Same logic for both main and realtime — args.kind carries
	// the distinction downstream.)
	if (
		args.value === args.currentModel &&
		!isQuantizationChanging(args.quantization, args.currentQuantization)
	) {
		return;
	}
	// Always route through the gate. The old short-circuit to applyPureQuantSwap
	// skipped the cache-state check, so a pure-quant swap to an uncached quant
	// tried to load files that were not on disk, failed, and rolled the picker
	// back to the previous selection — the "default-quant revert" symptom on
	// Cohere. Routing through dispatchChange opens the download
	// dialog when the target quant isn't on disk.
	dispatchChange(args);
}

export function runConfirmPendingDownload(
	pendingDownload: PendingDownload | null,
	issueSwap: (
		kind: "main" | "realtime",
		value: string,
		previous: string,
		quantization?: OnnxQuantization,
	) => void,
): void {
	if (pendingDownload === null) {
		return;
	}
	toIssueSwapInvoker(issueSwap)(pendingDownload)();
}

export function toIssueSwapInvoker(
	issueSwap: (
		kind: "main" | "realtime",
		value: string,
		previous: string,
		quantization?: OnnxQuantization,
	) => void,
): (pd: PendingDownload) => () => void {
	return (pd) => () =>
		issueSwap(pd.kind, pd.modelId, pd.previousModelId, pd.quantization);
}

export function handleDownloadCompleteEvent(
	model: string,
	cancelled: boolean,
	setPendingDownload: React.Dispatch<
		React.SetStateAction<PendingDownload | null>
	>,
): void {
	if (cancelled) {
		return;
	}
	closePendingDownloadFor(model, setPendingDownload);
}

export function closePendingDownloadFor(
	model: string,
	setPendingDownload: React.Dispatch<
		React.SetStateAction<PendingDownload | null>
	>,
): void {
	setPendingDownload((current) => clearIfMatches(current, model));
}

export function clearIfMatches(
	current: PendingDownload | null,
	model: string,
): PendingDownload | null {
	return matchesPending(current, model) ? null : current;
}

export function matchesPending(
	current: PendingDownload | null,
	model: string,
): boolean {
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

export function handleSwapFailedEvent(
	kind: "main" | "realtime",
	category: string,
	prevMainModelRef: React.MutableRefObject<string | null>,
	prevRealtimeModelRef: React.MutableRefObject<string | null>,
	update: UpdateModelFn,
	getModel: GetModelFn,
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

export function rollbackMain(
	prevMainModelRef: React.MutableRefObject<string | null>,
	update: UpdateModelFn,
	getModel: GetModelFn,
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

export function rollbackRealtime(
	prevRealtimeModelRef: React.MutableRefObject<string | null>,
	update: UpdateModelFn,
): void {
	const prev = prevRealtimeModelRef.current;
	if (prev === null) {
		return;
	}
	update({ realtimeModel: prev });
}
