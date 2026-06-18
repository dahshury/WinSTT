import {
	CheckmarkCircle02Icon,
	Download04Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	resolveEffectiveQuant,
	resolveQuantCache,
	SttModelSelector,
} from "@/widgets/model-picker";
import { useEffect } from "react";
import {
	isVisibleSttModel,
	useCatalogStore,
	useModelStateStore,
} from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";
import { useDownloadStore } from "@/features/model-download";
import { type ModelStateEntry, ipcSend } from "@/shared/api/ipc-client";
import { IPC } from "@/shared/api/ipc-channels";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { cn } from "@/shared/lib/cn";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { Spinner } from "@/shared/ui/spinner";
import { useOnboardingWizardStore } from "../../model/wizard-store";

/**
 * Open the detached model-picker window — the SAME canonical picker the settings
 * Main-model selector uses (`MainModelSection`) — anchored to the trigger's
 * on-screen rect. That window owns selection, download-gating, the engine
 * swap/reload, and its own close, so onboarding never re-implements any of it.
 * Crucially, picking there drives the real engine swap, so the chosen model is
 * actually loaded (not just persisted) by the time the wizard finishes.
 */
function openDetachedPicker(rect: DOMRect): void {
	ipcSend(IPC.MODEL_PICKER_OPEN, {
		x: rect.x,
		y: rect.y,
		width: rect.width,
		height: rect.height,
	});
}

/** Selection is owned by the detached picker window, so the in-window `onChange`
 *  is never invoked in this (detached) mode — the prop is still required by the
 *  selector's contract. */
const noopChange = () => undefined;

function isCachedTarget(
	state: ModelStateEntry | undefined,
	targetQuantization: string,
): boolean {
	return resolveQuantCache(state, targetQuantization)?.state === "cached";
}

export function OnboardingSttModelStep() {
	const catalogModels = useCatalogStore((s) => s.models);
	const catalogLoaded = useCatalogStore((s) => s.isLoaded);
	const getModel = useCatalogStore((s) => s.getModel);
	const statesById = useModelStateStore((s) => s.statesById);
	const modelStatesLoaded = useModelStateStore((s) => s.isLoaded);
	const systemInfo = useModelStateStore((s) => s.systemInfo);
	const refreshModelState = useModelStateStore((s) => s.refresh);
	const setSttModelReady = useOnboardingWizardStore((s) => s.setSttModelReady);
	const settingsModel = useSettingsStore((s) => s.settings.model);
	const quantDownloads = useDownloadStore((s) => s.quantDownloads);

	useEffect(() => {
		refreshModelState();
	}, [refreshModelState]);

	// The chosen model lives in `settings.model` — written by the detached picker
	// (through its swap controller) and broadcast back to this window via
	// `useSyncSettings`. We only READ it here to drive the readiness gate; the
	// picker is the sole writer.
	const selectedModelId = settingsModel.model;
	const selectedInfo = selectedModelId ? getModel(selectedModelId) : undefined;
	const selectedState = selectedModelId
		? statesById[selectedModelId]
		: undefined;
	const selectedQuantization = settingsModel.onnxQuantization;
	const targetQuantization = resolveEffectiveQuant(
		selectedState,
		selectedQuantization,
	);
	const downloadQuantization =
		targetQuantization === "auto" ? "" : targetQuantization;
	const targetCache = resolveQuantCache(selectedState, targetQuantization);
	const ready =
		selectedInfo !== undefined &&
		isCachedTarget(selectedState, targetQuantization);
	const downloadSnapshot =
		quantDownloads[`${selectedModelId}@${downloadQuantization}`];
	const busyDownloading =
		downloadSnapshot !== undefined && !downloadSnapshot.paused;

	useEffect(() => {
		setSttModelReady(ready);
	}, [ready, setSttModelReady]);

	const downloadProgress = busyDownloading
		? { modelId: selectedModelId, percent: downloadSnapshot?.progress ?? null }
		: null;

	return (
		<div className="flex flex-col gap-3">
			<FormControl
				caption="Pick the model WinSTT should use for your first dictation."
				label="Speech-to-text model"
				layout="stacked"
			>
				<ElevatedSurface inline>
					<SttModelSelector
						currentQuantization={
							(selectedQuantization || "") as OnnxQuantization
						}
						downloadProgress={downloadProgress}
						isLoading={!catalogLoaded || !modelStatesLoaded}
						kind="main"
						models={catalogModels}
						onChange={noopChange}
						onOpenDetached={openDetachedPicker}
						placeholder="Select a speech model"
						prefilter={isVisibleSttModel}
						statesById={statesById}
						systemInfo={systemInfo}
						value={selectedModelId}
					/>
				</ElevatedSurface>
			</FormControl>

			<ModelReadinessCard
				busyDownloading={busyDownloading}
				cacheState={targetCache?.state ?? "not_cached"}
				catalogLoaded={catalogLoaded}
				modelStatesLoaded={modelStatesLoaded}
				progress={downloadSnapshot?.progress ?? null}
				ready={ready}
				selectedName={selectedInfo?.displayName ?? selectedModelId}
				targetQuantization={targetQuantization}
			/>
		</div>
	);
}

/**
 * Read-only readiness reflector for the model in `settings.model`. The detached
 * picker owns downloading + selecting; this card just tells the user whether the
 * chosen model is on disk (which is what gates the wizard's Next button).
 */
function ModelReadinessCard({
	busyDownloading,
	cacheState,
	catalogLoaded,
	modelStatesLoaded,
	progress,
	ready,
	selectedName,
	targetQuantization,
}: {
	busyDownloading: boolean;
	cacheState: "cached" | "partial" | "not_cached";
	catalogLoaded: boolean;
	modelStatesLoaded: boolean;
	progress: number | null;
	ready: boolean;
	selectedName: string;
	targetQuantization: string;
}) {
	const loading = !catalogLoaded || !modelStatesLoaded || !selectedName;
	const statusLabel = resolveStatusLabel({
		busyDownloading,
		cacheState,
		loading,
		progress,
		ready,
	});

	return (
		<div
			className={cn(
				"flex items-center justify-between gap-3 rounded-md px-3 py-2 ring-1",
				ready
					? "bg-success/10 text-success ring-success/25"
					: "bg-surface-2 text-foreground-secondary ring-divider",
			)}
		>
			<div className="flex min-w-0 items-center gap-2.5">
				<span
					aria-hidden
					className={cn(
						"flex size-8 shrink-0 items-center justify-center rounded-md",
						ready
							? "bg-success/15 text-success ring-1 ring-success/30"
							: "bg-surface-3 text-foreground-muted ring-1 ring-divider",
					)}
				>
					<ReadinessIcon loading={loading} ready={ready} />
				</span>
				<span className="min-w-0">
					<span className="block truncate font-medium text-body">
						{selectedName || "Loading models"}
					</span>
					<span className="block text-body-sm text-foreground-muted">
						{targetQuantization === "auto"
							? "auto precision"
							: targetQuantization || "default precision"}{" "}
						- {statusLabel}
					</span>
				</span>
			</div>
		</div>
	);
}

function ReadinessIcon({
	loading,
	ready,
}: {
	loading: boolean;
	ready: boolean;
}) {
	if (loading) {
		return <Spinner className="size-3 border" />;
	}
	return (
		<HugeiconsIcon
			icon={ready ? CheckmarkCircle02Icon : Download04Icon}
			size={14}
		/>
	);
}

function resolveStatusLabel({
	busyDownloading,
	cacheState,
	loading,
	progress,
	ready,
}: {
	busyDownloading: boolean;
	cacheState: "cached" | "partial" | "not_cached";
	loading: boolean;
	progress: number | null;
	ready: boolean;
}): string {
	if (loading) {
		return "checking local cache";
	}
	if (ready) {
		return "downloaded and ready";
	}
	if (busyDownloading) {
		return progress === null ? "download starting" : `downloading ${progress}%`;
	}
	if (cacheState === "partial") {
		return "partial download found";
	}
	return "click above to choose and download";
}
