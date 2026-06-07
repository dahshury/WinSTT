import { TtsModelSelector } from "@picker/tts";
import { useEffect } from "react";
import { useSettingsStore } from "@/entities/setting";
import {
	useTtsCatalogStore,
	useTtsModelStateStore,
} from "@/entities/tts-catalog";
import { useTtsModelPickerStore } from "@/features/tts-model-picker";
import {
	onTtsModelDownloadCompleteCatalog,
	ttsDeleteModel,
} from "@/shared/api/ipc-client";
import { Modal } from "@/shared/ui/modal";
import { isTtsModelCached } from "../model/use-tts-install-gate";
import { useTtsModelDownloads } from "../model/use-tts-model-downloads";

// The inline picker fills its host; pin the modal body to the same footprint
// the detached STT picker window uses so both surfaces read identically.
const PANEL_HEIGHT = "h-full";

/**
 * Host for the read-aloud (TTS) model-picker modal. Mirrors `LlmModelPickerHost`
 * in SettingsPage: turning the read-aloud toggle on with no cached model opens
 * this picker (via `useTtsModelPickerStore`); the picker never enables the
 * feature itself — only a downloaded/selected model does, through
 * `commitInstalled`. Closing the picker empty therefore leaves the toggle off.
 *
 * Mounted once at the view layer (the modal is rendered here, not from the
 * settings widget) so it's available regardless of which settings tab is shown.
 */
export function TtsModelPickerHost() {
	const open = useTtsModelPickerStore((s) => s.open);
	const close = useTtsModelPickerStore((s) => s.close);
	const commitInstalled = useTtsModelPickerStore((s) => s.commitInstalled);

	const models = useTtsCatalogStore((s) => s.models);
	const isLoaded = useTtsCatalogStore((s) => s.isLoaded);
	const statesById = useTtsModelStateStore((s) => s.statesById);
	const refresh = useTtsModelStateStore((s) => s.refresh);
	const currentModel = useSettingsStore((s) => s.settings.tts?.model ?? "");
	const currentQuant = statesById[currentModel]?.effectiveQuantization ?? "";
	const { getSnapshot, onDownloadAction } = useTtsModelDownloads();

	// Refresh cache state whenever the picker opens so the badges reflect reality
	// (the user may have downloaded/deleted models since the last visit).
	useEffect(() => {
		if (open) {
			refresh();
		}
	}, [open, refresh]);

	// Turn-on flow: the first model to finish downloading while the picker is
	// open is auto-selected and read-aloud is enabled, then the picker closes.
	useEffect(() => {
		if (!open) {
			return;
		}
		return onTtsModelDownloadCompleteCatalog((model, cancelled) => {
			if (cancelled) {
				return;
			}
			commitInstalled(model);
			close();
		});
	}, [open, commitInstalled, close]);

	// Picking an already-cached model commits + closes (the user chose it). An
	// uncached pick is ignored — the user must download it first; the on-complete
	// listener above then commits the freshly downloaded model.
	const handleChange = (modelId: string): void => {
		if (isTtsModelCached(statesById[modelId])) {
			commitInstalled(modelId);
			close();
		}
	};

	return (
		<Modal isOpen={open} onClose={close}>
			<div className="flex h-[560px] w-[600px] max-w-[92vw] flex-col [&>*]:size-full">
				<TtsModelSelector
					currentQuantization={currentQuant}
					inline
					isLoading={!isLoaded}
					models={models}
					onChange={handleChange}
					onDeleteQuant={(modelId, quant) => ttsDeleteModel(modelId, quant)}
					onDownloadAction={onDownloadAction}
					onDownloadSnapshot={getSnapshot}
					popupHeightClass={PANEL_HEIGHT}
					statesById={statesById}
					value={currentModel}
				/>
			</div>
		</Modal>
	);
}
