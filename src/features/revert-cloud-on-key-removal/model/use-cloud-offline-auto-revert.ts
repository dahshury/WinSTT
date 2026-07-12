import { useEffect } from "react";
import { providerOf } from "@/entities/cloud-stt-provider";
import { useLlmCatalogStore } from "@/entities/llm-catalog";
import {
	useCatalogStore,
	useModelStateStore,
	useModelSwapStore,
} from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";
import { useTtsModelStateStore } from "@/entities/tts-catalog";
import { IPC } from "@/shared/api/ipc-channels";
import { ipcOn, sttReloadModel } from "@/shared/api/ipc-client";
import {
	type ClearableProvider,
	resolveLocalSttTarget,
} from "./cloud-revert-decision";
import { useRevertNoticeStore } from "./revert-notice-store";

/** `cloud:connectivity` payload — the backend's per-provider offline/online signal. */
interface ConnectivityPayload {
	provider?: string;
	status?: "offline" | "online";
}

/** True when at least one local STT model is fully downloaded (a usable fallback). */
function hasCachedLocalStt(): boolean {
	const { models } = useCatalogStore.getState();
	const { statesById } = useModelStateStore.getState();
	return models.some((m) => statesById[m.id]?.cache.state === "cached");
}

/** True when at least one local TTS voice pack is fully downloaded. */
function hasCachedLocalTts(): boolean {
	const { statesById } = useTtsModelStateStore.getState();
	return Object.values(statesById).some((entry) =>
		Object.values(entry.cacheByQuantization).some((q) => q.state === "cached"),
	);
}

/** The first installed Ollama model, or null when Ollama is unreachable / has none.
 *  Ollama is loopback, so it stays reachable even when the internet is down. */
function firstInstalledOllamaModel(): string | null {
	const { models, isReachable } = useLlmCatalogStore.getState();
	if (!isReachable || models.length === 0) {
		return null;
	}
	return models[0]?.name ?? null;
}

/** Swap the main STT slot from the offline cloud model back to a cached local one.
 *  Mirrors `useCloudKeyAutoRevert`'s revert: the swap primitives (not a bare
 *  settings write) so `sttReloadModel` actually reloads the server engine. */
function revertSttToLocal(currentCloudModel: string): void {
	const { models } = useCatalogStore.getState();
	const { statesById } = useModelStateStore.getState();
	const target = resolveLocalSttTarget(models, statesById);
	useModelSwapStore
		.getState()
		.beginSwap("main", currentCloudModel, target.model);
	useSettingsStore.getState().updateModelSettings({ model: target.model });
	sttReloadModel("main", target.model);
}

/**
 * Revert every surface backed by a now-offline cloud provider to its local
 * engine — but ONLY when a local model actually exists for that surface (a
 * cached STT/TTS model, or an installed Ollama model). When no local model
 * exists we leave the surface on cloud: the record-time gate + the runtime
 * salvage own the "offline, no local" case (overlay error / suppressed chime).
 */
export function revertSurfacesForOfflineProvider(
	provider: ClearableProvider,
): void {
	const store = useSettingsStore.getState();
	const settings = store.settings;
	const notice = useRevertNoticeStore.getState();
	const notified = new Set<ClearableProvider>();
	const note = (p: ClearableProvider) => {
		if (!notified.has(p)) {
			notified.add(p);
			notice.push(p);
		}
	};

	// Main STT model on this provider → smallest cached local model.
	const sttModel = settings.model?.model ?? "";
	if (providerOf(sttModel) === provider && hasCachedLocalStt()) {
		revertSttToLocal(sttModel);
		note(provider);
	}

	// Cloud TTS on this provider → local Kokoro.
	if (
		settings.tts.source === "cloud" &&
		settings.tts.cloud?.provider === provider &&
		hasCachedLocalTts()
	) {
		store.updateTtsSettings({ source: "local" });
		note(provider);
	}

	// LLM dictation/transforms on OpenRouter → installed Ollama model (kept
	// enabled, so post-processing keeps running locally). Skipped when Ollama has
	// no installed model — the raw-transcript soft-fail + connectivity toast cover
	// that case without enabling a model-less feature.
	if (provider === "openrouter") {
		const ollama = firstInstalledOllamaModel();
		if (ollama) {
			if (settings.llm.dictation.provider === "openrouter") {
				store.updateLlmDictation({ provider: "ollama", model: ollama });
				note(provider);
			}
			if (settings.llm.transforms.provider === "openrouter") {
				store.updateLlmTransforms({ provider: "ollama", model: ollama });
				note(provider);
			}
		}
	}
}

/**
 * Auto-switch every cloud surface to its local engine when its provider goes
 * offline (fired by the backend's `cloud:connectivity` watch after a network
 * failure) — the user-chosen "persist Local while offline" behavior. Only
 * reverts surfaces that have a local model installed; the rest keep failing
 * over per-utterance (STT) or show an offline notice (record-time gate).
 *
 * Mounted ONCE in `RootLayout` (main window) — that's where dictation runs and
 * where the connectivity event is received. Unlike `useCloudKeyAutoRevert`
 * (settings-window-only, because keys are edited there), the offline signal
 * arrives while the settings window is typically closed, so a same-main-window
 * write persists and broadcasts without the LLM-section merge race.
 */
export function useCloudOfflineAutoRevert(enabled = true): void {
	useEffect(() => {
		if (!enabled) {
			return;
		}
		return ipcOn(IPC.CLOUD_CONNECTIVITY, (data) => {
			const payload = data as ConnectivityPayload;
			if (payload.status !== "offline") {
				return;
			}
			const provider = payload.provider;
			if (provider !== "elevenlabs" && provider !== "openrouter") {
				return;
			}
			revertSurfacesForOfflineProvider(provider);
		});
	}, [enabled]);
}
