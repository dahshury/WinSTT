import { Button as BaseButton } from "@base-ui/react/button";
import {
	CheckmarkCircle02Icon,
	CloudDownloadIcon,
	Download04Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	resolveEffectiveQuant,
	resolveQuantCache,
	SttModelSelector,
} from "@/widgets/model-picker";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	isVisibleSttModel,
	pickDefaultSttModel,
	useCatalogStore,
	useModelStateStore,
} from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";
import {
	canDeleteSttQuant,
	DownloadConfirmationDialog,
	resolveSttDeleteRecovery,
	useDownloadStore,
	useQuantActions,
} from "@/features/model-download";
import type { ModelStateEntry } from "@/shared/api/ipc-client";
import type { OnnxQuantization } from "@/shared/config/defaults";
import { cn } from "@/shared/lib/cn";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { Spinner } from "@/shared/ui/spinner";
import { useOnboardingWizardStore } from "../../model/wizard-store";

type PendingSttDownload = {
	kind: "main";
	modelId: string;
	previousModelId: string;
	quantization?: OnnxQuantization | undefined;
};

function normalizeDownloadQuant(quantization: string): OnnxQuantization {
	return (quantization === "auto" ? "" : quantization) as OnnxQuantization;
}

function targetQuantFor(
	state: ModelStateEntry | undefined,
	selectedQuantization: string,
): string {
	return resolveEffectiveQuant(state, selectedQuantization);
}

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
	const sttModelId = useOnboardingWizardStore((s) => s.sttModelId);
	const sttQuantization = useOnboardingWizardStore((s) => s.sttQuantization);
	const setSttSelection = useOnboardingWizardStore((s) => s.setSttSelection);
	const setSttModelReady = useOnboardingWizardStore((s) => s.setSttModelReady);
	const settingsModel = useSettingsStore((s) => s.settings.model);
	const updateModelSettings = useSettingsStore((s) => s.updateModelSettings);
	const quantDownloads = useDownloadStore((s) => s.quantDownloads);
	const { handleDeleteQuant, handleDownloadAction, handleDownloadSnapshot } =
		useQuantActions();
	const [pendingDownload, setPendingDownload] =
		useState<PendingSttDownload | null>(null);

	useEffect(() => {
		refreshModelState();
	}, [refreshModelState]);

	const defaultModelId = useMemo(
		() =>
			pickDefaultSttModel(catalogModels, statesById, isVisibleSttModel) ?? "",
		[catalogModels, statesById],
	);

	useEffect(() => {
		if (!sttModelId && defaultModelId) {
			setSttSelection(defaultModelId, "auto");
		}
	}, [defaultModelId, setSttSelection, sttModelId]);

	const selectedModelId = sttModelId || defaultModelId;
	const selectedInfo = selectedModelId ? getModel(selectedModelId) : undefined;
	const selectedState = selectedModelId
		? statesById[selectedModelId]
		: undefined;
	const selectedQuantization = sttQuantization || "auto";
	const targetQuantization = targetQuantFor(
		selectedState,
		selectedQuantization,
	);
	const downloadQuantization = normalizeDownloadQuant(targetQuantization);
	const targetCache = resolveQuantCache(selectedState, targetQuantization);
	const ready =
		selectedInfo !== undefined &&
		isCachedTarget(selectedState, targetQuantization);
	const downloadSnapshot =
		quantDownloads[`${selectedModelId}@${downloadQuantization}`];
	const busyDownloading =
		downloadSnapshot !== undefined && !downloadSnapshot.paused;
	const canRequestDownload =
		selectedModelId !== "" &&
		selectedInfo !== undefined &&
		modelStatesLoaded &&
		!ready &&
		!busyDownloading;

	useEffect(() => {
		setSttModelReady(ready);
	}, [ready, setSttModelReady]);

	useEffect(() => {
		if (!ready || selectedInfo === undefined) {
			return;
		}
		const realtimeModel = selectedInfo.nativeStreaming ? selectedModelId : "";
		if (
			settingsModel.model === selectedModelId &&
			settingsModel.onnxQuantization === selectedQuantization &&
			settingsModel.realtimeModel === realtimeModel
		) {
			return;
		}
		updateModelSettings({
			model: selectedModelId,
			backend: selectedInfo.backend,
			onnxQuantization: selectedQuantization,
			realtimeModel,
		});
	}, [
		ready,
		selectedInfo,
		selectedModelId,
		selectedQuantization,
		settingsModel.model,
		settingsModel.onnxQuantization,
		settingsModel.realtimeModel,
		updateModelSettings,
	]);

	const openDownloadDialog = (
		modelId = selectedModelId,
		quantization = downloadQuantization,
	) => {
		if (!modelId) {
			return;
		}
		setPendingDownload({
			kind: "main",
			modelId,
			previousModelId: settingsModel.model,
			quantization,
		});
	};

	const handleSelect = (modelId: string, quantization?: OnnxQuantization) => {
		const nextQuantization = quantization ?? "auto";
		setSttSelection(modelId, nextQuantization);
		const nextState = statesById[modelId];
		const nextTargetQuantization = targetQuantFor(nextState, nextQuantization);
		if (
			nextState !== undefined &&
			!isCachedTarget(nextState, nextTargetQuantization)
		) {
			openDownloadDialog(
				modelId,
				normalizeDownloadQuant(nextTargetQuantization),
			);
		}
	};

	const handleSelectorDownloadAction: typeof handleDownloadAction = (
		action,
		modelId,
		quantization,
	) => {
		if (action === "start") {
			setSttSelection(modelId, quantization);
			openDownloadDialog(modelId, quantization);
			return;
		}
		handleDownloadAction(action, modelId, quantization);
	};
	const canDeleteQuant = useCallback(
		(modelId: string, quantization: OnnxQuantization) =>
			canDeleteSttQuant(catalogModels, statesById, modelId, quantization),
		[catalogModels, statesById],
	);
	const handleSelectorDeleteQuant = useCallback(
		(modelId: string, quantization: OnnxQuantization) => {
			const recovery = resolveSttDeleteRecovery({
				currentMainModel: selectedModelId,
				currentQuantization: selectedQuantization as OnnxQuantization | "auto",
				mainModelInfo: selectedInfo,
				modelId,
				models: catalogModels,
				quantization,
				statesById,
			});
			if (!recovery.canDelete) {
				return;
			}
			if (recovery.mainTarget) {
				setSttSelection(
					recovery.mainTarget.modelId,
					recovery.mainTarget.quantization ?? "auto",
				);
			}
			handleDeleteQuant(modelId, quantization);
		},
		[
			catalogModels,
			handleDeleteQuant,
			selectedInfo,
			selectedModelId,
			selectedQuantization,
			setSttSelection,
			statesById,
		],
	);

	return (
		<div className="flex flex-col gap-3">
			<FormControl
				caption="Pick the model WinSTT should use for your first dictation."
				label="Speech-to-text model"
				layout="stacked"
			>
				<ElevatedSurface inline>
					<SttModelSelector
						currentQuantization={selectedQuantization as OnnxQuantization}
						isLoading={!catalogLoaded || !modelStatesLoaded}
						kind="main"
						models={catalogModels}
						onChange={handleSelect}
						canDeleteQuant={canDeleteQuant}
						onDeleteQuant={handleSelectorDeleteQuant}
						onDownloadAction={handleSelectorDownloadAction}
						onDownloadSnapshot={handleDownloadSnapshot}
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
				canRequestDownload={canRequestDownload}
				catalogLoaded={catalogLoaded}
				modelStatesLoaded={modelStatesLoaded}
				onDownload={() => openDownloadDialog()}
				progress={downloadSnapshot?.progress ?? null}
				ready={ready}
				selectedName={selectedInfo?.displayName ?? selectedModelId}
				targetQuantization={targetQuantization}
			/>

			<DownloadConfirmationDialog
				getModel={getModel}
				onCancel={() => setPendingDownload(null)}
				pending={pendingDownload}
				statesById={statesById}
				systemInfo={systemInfo}
			/>
		</div>
	);
}

function ModelReadinessCard({
	busyDownloading,
	cacheState,
	canRequestDownload,
	catalogLoaded,
	modelStatesLoaded,
	onDownload,
	progress,
	ready,
	selectedName,
	targetQuantization,
}: {
	busyDownloading: boolean;
	cacheState: "cached" | "partial" | "not_cached";
	canRequestDownload: boolean;
	catalogLoaded: boolean;
	modelStatesLoaded: boolean;
	onDownload: () => void;
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
	const actionLabel =
		cacheState === "partial" ? "Resume download" : "Download model";

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
			{!ready ? (
				<BaseButton
					className={cn(
						"inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 font-medium text-body-sm outline-none transition-[background-color,box-shadow] duration-150",
						"bg-accent text-white shadow-elevated hover:bg-accent-hover",
						"focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1",
						"disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none",
					)}
					disabled={!canRequestDownload}
					onClick={onDownload}
					type="button"
				>
					<HugeiconsIcon icon={CloudDownloadIcon} size={13} />
					<span>{actionLabel}</span>
				</BaseButton>
			) : null}
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
	return "download required";
}
