import { TtsModelSelector } from "@/features/tts-model-picker";
import { useEffect } from "react";
import { useSettingsStore } from "@/entities/setting";
import {
	useTtsCatalogStore,
	useTtsModelStateStore,
} from "@/entities/tts-catalog";
import { useTtsSuggestions } from "@/features/suggested-models";
import {
	useTtsModelDownloads,
	useTtsModelPickerStore,
} from "@/features/tts-model-picker";
import {
	onTtsModelDownloadCompleteCatalog,
	ttsDeleteModel,
} from "@/shared/api/ipc-client";
import type { QuantDownloadAction } from "@/shared/lib/download-progress-core";
import { Modal } from "@/shared/ui/modal";
import { isTtsModelCached } from "../model/use-tts-install-gate";

// The inline picker fills its host; pin the modal body to the same footprint
// the detached STT picker window uses so both surfaces read identically.
const PANEL_HEIGHT = "h-full";

/**
 * Host for the read-aloud (TTS) model-picker modal. Mirrors `LlmModelPickerHost`
 * in SettingsPage: turning the read-aloud toggle on with no cached model opens
 * this picker (via `useTtsModelPickerStore`); the picker never enables the
 * feature itself — only a downloaded/selected model does, through
 * `commitInstalled`. Closing the picker empty leaves the toggle off — unless a
 * download the user started here is still running: the store parks the intent
 * (`pendingEnable`) and the completion listener below (which is NOT gated on
 * `open`) commits the enable when the model lands, so the user can switch to
 * other apps while the download finishes.
 *
 * Mounted once at the view layer (the modal is rendered here, not from the
 * settings widget) so it's available regardless of which settings tab is shown.
 */
export function TtsModelPickerHost() {
	const open = useTtsModelPickerStore((s) => s.open);
	const close = useTtsModelPickerStore((s) => s.close);
	const commitInstalled = useTtsModelPickerStore((s) => s.commitInstalled);
	const trackEnableDownload = useTtsModelPickerStore(
		(s) => s.trackEnableDownload,
	);
	const untrackEnableDownload = useTtsModelPickerStore(
		(s) => s.untrackEnableDownload,
	);

	const models = useTtsCatalogStore((s) => s.models);
	const isLoaded = useTtsCatalogStore((s) => s.isLoaded);
	const statesById = useTtsModelStateStore((s) => s.statesById);
	const refresh = useTtsModelStateStore((s) => s.refresh);
	const currentModel = useSettingsStore((s) => s.settings.tts?.model ?? "");
	const currentQuant = statesById[currentModel]?.effectiveQuantization ?? "";
	const { getSnapshot, onDownloadAction } = useTtsModelDownloads();
	// Suggested (spec-based recommender) verdict: cross-modality budgets with
	// the TTS slot excluded → per-quant fit + language de-rank. `undefined`
	// until system info arrives — the picker hides the chip then.
	const getSuggestion = useTtsSuggestions({ models, statesById });

	// Refresh cache state whenever the picker opens so the badges reflect reality
	// (the user may have downloaded/deleted models since the last visit).
	useEffect(() => {
		if (open) {
			refresh();
		}
	}, [open, refresh]);

	// Turn-on flow: the first model to finish downloading while the picker is
	// open is auto-selected and read-aloud is enabled, then the picker closes.
	// NOT gated on `open`: a download the user started from a turn-on session
	// keeps its commit rights after the picker closes (`pendingEnable`) — the
	// store's commit guard is what rejects unrelated completions while closed.
	useEffect(
		() =>
			onTtsModelDownloadCompleteCatalog((model, cancelled) => {
				if (cancelled) {
					untrackEnableDownload(model);
					return;
				}
				const wasOpen = useTtsModelPickerStore.getState().open;
				commitInstalled(model);
				if (wasOpen) {
					close();
				}
			}),
		[commitInstalled, close, untrackEnableDownload],
	);

	// Downloads started/resumed inside a turn-on session arm the pending enable
	// intent (so it survives closing the picker); cancelling disarms it.
	const handleDownloadAction = (
		action: QuantDownloadAction,
		modelId: string,
		quant: string,
	): void => {
		if (action === "start" || action === "resume") {
			trackEnableDownload(modelId);
		} else if (action === "cancel") {
			untrackEnableDownload(modelId);
		}
		onDownloadAction(action, modelId, quant);
	};

	// Picking an already-cached model commits + closes (the user chose it). An
	// uncached pick is ignored — the user must download it first; the on-complete
	// listener above then commits the freshly downloaded model.
	const handleChange = (modelId: string, quant?: string): void => {
		if (isTtsModelCached(statesById[modelId])) {
			commitInstalled(modelId, quant);
			close();
		}
	};

	return (
		<Modal isOpen={open} onClose={close}>
			<div className="flex h-[560px] w-[600px] max-w-[92vw] flex-col [&>*]:size-full">
				<TtsModelSelector
					currentQuantization={currentQuant}
					getSuggestion={getSuggestion}
					inline
					isLoading={!isLoaded}
					models={models}
					onChange={handleChange}
					onDeleteQuant={(modelId, quant) => ttsDeleteModel(modelId, quant)}
					onDownloadAction={handleDownloadAction}
					onDownloadSnapshot={getSnapshot}
					popupHeightClass={PANEL_HEIGHT}
					statesById={statesById}
					value={currentModel}
				/>
			</div>
		</Modal>
	);
}
