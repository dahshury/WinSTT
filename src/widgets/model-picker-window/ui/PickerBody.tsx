import { SttModelSelector } from "@picker";
import { providerOf } from "@/entities/cloud-stt-provider";
import { isVisibleSttModel } from "@/entities/model-catalog";
import { CloudModelSelect } from "@/features/select-cloud-stt-model";
import type { OnnxQuantization } from "@/shared/config/defaults";
import {
	type CatalogModels,
	close,
	type GetFitAssessment,
	PANEL_HEIGHT,
	type QuantActions,
	type StatesById,
	type SystemInfo,
} from "../lib/picker-helpers";

interface PickerBodyProps {
	catalogLoaded: boolean;
	catalogModels: CatalogModels;
	currentModel: string;
	currentQuantization: OnnxQuantization;
	fileQueueBusy: boolean;
	getFitAssessment: GetFitAssessment;
	hasAnyCloudKey: boolean;
	onDeleteQuant: QuantActions["handleDeleteQuant"];
	canDeleteQuant: (modelId: string, quantization: OnnxQuantization) => boolean;
	onDownloadAction: QuantActions["handleDownloadAction"];
	onDownloadSnapshot: QuantActions["handleDownloadSnapshot"];
	onSelect: (modelId: string, quantization?: OnnxQuantization) => void;
	statesById: StatesById;
	systemInfo: SystemInfo;
}

/**
 * The picker surface: the local STT grid, or the cloud picker when the active
 * model is a cloud provider's. There is NO Local/Cloud switch here — choosing
 * the source is a Settings-only control (`SourceArea` in ModelSettingsPanel);
 * this window just browses the models for whatever source the persisted model
 * already uses. The host mounts it with `key={effectiveSourceIsCloud}` so a
 * persisted-source flip cleanly re-mounts the right sub-picker.
 */
export function PickerBody({
	catalogLoaded,
	catalogModels,
	currentModel,
	currentQuantization,
	fileQueueBusy,
	getFitAssessment,
	hasAnyCloudKey,
	onDeleteQuant,
	canDeleteQuant,
	onDownloadAction,
	onDownloadSnapshot,
	onSelect,
	statesById,
	systemInfo,
}: PickerBodyProps) {
	// Which sub-picker shows is derived purely from the active model — there is
	// NO Local/Cloud switch in this window. The source toggle is a Settings-only
	// control (see `SourceArea` in ModelSettingsPanel); this detached picker just
	// browses the models for whatever source the persisted model already uses.
	// A persisted cloud model whose key was removed falls back to the local list
	// (the key-removal banner explains why), matching the Settings behaviour.
	const isCloud = providerOf(currentModel) !== null;
	const showCloud = isCloud && hasAnyCloudKey;

	return (
		// Bottom-aligned so the short Cloud panel hugs the chip instead of
		// floating at the top of the (chip-height-capped) window. In Cloud mode
		// the empty area above the control is the flex container itself — a
		// pointer-down on it (not a child) closes the picker, same as the
		// backdrop. In Local mode the grid fills via `flex-1`, leaving no gap.
		<div
			className="flex h-full flex-col justify-end gap-2"
			onPointerDown={(e) => {
				if (e.target === e.currentTarget) {
					close();
				}
			}}
		>
			{showCloud ? (
				// Auto-open: the detached window exists only to show the picker, so a
				// closed combobox would force a pointless second click.
				<CloudModelSelect
					defaultOpen
					onSelect={onSelect}
					selectedId={currentModel}
				/>
			) : (
				<div className="min-h-0 flex-1 [&>*]:size-full">
					<SttModelSelector
						currentQuantization={currentQuantization}
						disabled={fileQueueBusy}
						getFitAssessment={getFitAssessment}
						inline
						isLoading={!catalogLoaded}
						kind="main"
						models={catalogModels}
						onChange={onSelect}
						canDeleteQuant={canDeleteQuant}
						onDeleteQuant={onDeleteQuant}
						onDownloadAction={onDownloadAction}
						onDownloadSnapshot={onDownloadSnapshot}
						popupHeightClass={PANEL_HEIGHT}
						prefilter={isVisibleSttModel}
						statesById={statesById}
						systemInfo={systemInfo}
						value={isCloud ? "" : currentModel}
					/>
				</div>
			)}
		</div>
	);
}
