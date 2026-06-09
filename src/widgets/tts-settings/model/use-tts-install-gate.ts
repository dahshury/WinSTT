import { useEffect, useState } from "react";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import {
	type TtsModelState,
	useTtsModelStateStore,
} from "@/entities/tts-catalog";
import { useTtsModelPickerStore } from "@/features/tts-model-picker";
import {
	initTts,
	onTtsInstallFailed,
	onTtsInstallStatus,
	onTtsModelDownloadComplete,
	type TtsInstallPhase,
} from "@/shared/api/ipc-client";

export interface TtsInstallGate {
	/** Pass to `SettingSection.onToggle` (LOCAL path). Enables directly when the
	 *  selected model is already on disk; otherwise opens the model selector so
	 *  the user picks/downloads one (the selector's commit flips `enabled`). */
	handleEnabledToggle: (next: boolean) => void;
	/** Classified install-failure reason, or null when no error is showing. */
	installError: string | null;
	/** Current install phase, or null when idle / ready. */
	installPhase: TtsInstallPhase | null;
	/** Re-trigger init_tts after a failure — clears the banner and re-runs warm-up. */
	retryInstall: () => void;
}

// Pure projection: `ready` collapses to `null` (idle); every other phase
// passes through unchanged. Record indexing keeps CC at 1.
const READY_PROJECTION: Record<TtsInstallPhase, TtsInstallPhase | null> = {
	engine: "engine",
	model: "model",
	ready: null,
	unknown: "unknown",
};

/** Pure helper — exported for tests. */
export function projectInstallPhase(
	phase: TtsInstallPhase,
): TtsInstallPhase | null {
	return READY_PROJECTION[phase];
}

/**
 * Whether the selected read-aloud model is usable offline — i.e. at least one
 * of its quantizations is fully cached on disk. Pure so the toggle decision
 * ("enable now" vs "open the picker to download") is unit-testable.
 *
 * Any cached quant counts (not just the server's `effectiveQuantization`): if
 * the user already downloaded a usable variant we shouldn't re-prompt them to
 * pick one. An unknown / not-yet-loaded state is treated as "not cached" so the
 * first-run path opens the selector.
 */
export function isTtsModelCached(state: TtsModelState | undefined): boolean {
	if (!state) {
		return false;
	}
	return Object.values(state.cacheByQuantization).some(
		(c) => c.state === "cached",
	);
}

type TtsStatesById = Record<string, TtsModelState | undefined>;

export function pickCachedTtsModel(
	models: readonly { id: string }[],
	statesById: TtsStatesById,
): string | null {
	return (
		models.find((candidate) => isTtsModelCached(statesById[candidate.id]))
			?.id ?? null
	);
}

export interface TtsEnabledReconcileInput {
	cloudFallbackAllowed: boolean;
	enabled: boolean;
	isCloud: boolean;
	model: string;
	models: readonly { id: string }[];
	statesById: TtsStatesById;
	statesLoaded: boolean;
}

export function resolveTtsEnabledModelPatch({
	cloudFallbackAllowed,
	enabled,
	isCloud,
	model,
	models,
	statesById,
	statesLoaded,
}: TtsEnabledReconcileInput): {
	enabled?: false;
	model?: string;
	source?: "cloud";
} | null {
	if (!enabled || isCloud || !statesLoaded) {
		return null;
	}
	if (isTtsModelCached(statesById[model])) {
		return null;
	}
	const fallback = pickCachedTtsModel(models, statesById);
	if (fallback !== null) {
		return fallback === model ? null : { model: fallback };
	}
	if (cloudFallbackAllowed) {
		return { source: "cloud" };
	}
	return { enabled: false };
}

/** Picks the toggle action without an `if`. */
export type ToggleActionKey = "disable" | "enable";

const TOGGLE_ACTION_BY_INDEX: readonly ToggleActionKey[] = [
	"disable",
	"enable",
];

/** Pure helper — exported for tests. */
export function resolveToggleAction(next: boolean): ToggleActionKey {
	return TOGGLE_ACTION_BY_INDEX[Number(next === true)] as ToggleActionKey;
}

/**
 * Pure helper — exported for tests. Decides whether to fold the default
 * "Speak selection" hotkey into the enabled-edge patch. Existing users may
 * have a persisted empty hotkey from when "" was the schema default; folding
 * the default in alongside `enabled: true` guarantees the combo is always
 * armed once TTS is on (see memory: capability-must-have-model).
 */
export function buildTtsEnablePatch(
	currentHotkey: string,
	defaultHotkey: string,
): { enabled: true; hotkey?: string } {
	return currentHotkey.trim()
		? { enabled: true }
		: { enabled: true, hotkey: defaultHotkey };
}

const selectTtsHotkey = (
	s: ReturnType<typeof useSettingsStore.getState>,
): string => s.settings.tts?.hotkey ?? "";
const selectTtsModel = (
	s: ReturnType<typeof useSettingsStore.getState>,
): string => s.settings.tts?.model ?? DEFAULT_SETTINGS.tts.model;

/**
 * Enable gate for the read-aloud (TTS) feature.
 *
 * The settings store's `tts.enabled` flag is what actually triggers the
 * on-demand warm-up (the server's tts store listener fires `init_tts` on the
 * off→on edge → loads the selected model, downloading it only if it's missing).
 * To honor "never enabled without a model the user chose", turning ON does NOT
 * auto-download a default: if the selected model is already cached it enables
 * straight away, otherwise it opens the model selector and lets the picker's
 * commit flip `enabled` once a model lands. Turning OFF is immediate.
 *
 * The post-enable warm-up banner (phase pings + classified failures + retry)
 * stays here so the section can show download/extraction progress after the
 * toggle commits.
 */
export function useTtsInstallGate(): TtsInstallGate {
	const update = useSettingsStore((s) => s.updateTtsSettings);
	const currentHotkey = useSettingsStore(selectTtsHotkey);
	const model = useSettingsStore(selectTtsModel);
	const statesById = useTtsModelStateStore((s) => s.statesById);

	const [installPhase, setInstallPhase] = useState<TtsInstallPhase | null>(
		null,
	);
	const [installError, setInstallError] = useState<string | null>(null);

	const enablePatch = (): Partial<{ enabled: true; hotkey: string }> =>
		buildTtsEnablePatch(currentHotkey, DEFAULT_SETTINGS.tts.hotkey);

	// Install-phase ping (engine pack → voice model → ready) labels the
	// progress UI; cleared once the engine reports ready or the download
	// finishes. Any phase ping is also proof a fresh attempt is in flight,
	// so clear any stale install-error banner from a prior failure.
	useEffect(
		() =>
			onTtsInstallStatus(({ phase }) => {
				setInstallPhase(projectInstallPhase(phase));
				setInstallError(null);
			}),
		[],
	);
	// The on-demand install fires THREE distinct download-complete events
	// (engine pack → voice model → voicepacks), interleaved with phase
	// pings. Resetting the phase on every complete event caused the
	// section to briefly re-enable between assets — the toggle/voice/speed
	// controls would flash interactive for ~50 ms each time. Only treat
	// CANCELLED completion as "install over"; for successful completion,
	// trust the server's `tts_install_status: ready` ping (which the other
	// effect handles) to mark the install as done.
	useEffect(
		() =>
			onTtsModelDownloadComplete(({ cancelled }) => {
				if (cancelled) {
					setInstallPhase(null);
				}
			}),
		[],
	);
	// A failed eager warm-up clears the progress UI and surfaces the
	// classified reason via the section's error banner. The toggle stays
	// `enabled: true` so the user's choice is preserved; recovery is the
	// Retry button (which re-dispatches `init_tts`).
	useEffect(
		() =>
			onTtsInstallFailed(({ reason }) => {
				setInstallPhase(null);
				setInstallError(reason);
			}),
		[],
	);

	// Toggle dispatch: tuple keyed by `resolveToggleAction` — no `if`.
	const toggleActions: Record<ToggleActionKey, () => void> = {
		enable: () => {
			// Already on disk → enable straight away. Otherwise open the model
			// selector; its commit (download-complete / pick) flips `enabled`.
			if (isTtsModelCached(statesById[model])) {
				update(enablePatch());
				return;
			}
			useTtsModelPickerStore.getState().openFor(true);
		},
		disable: () => {
			update({ enabled: false });
			setInstallPhase(null);
		},
	};
	const handleEnabledToggle = (next: boolean): void => {
		toggleActions[resolveToggleAction(next)]();
	};

	// Re-trigger the eager warm-up. Clears any prior error so the banner
	// disappears immediately; the next failure (or `ready` status ping) is
	// what reinstates it / dismisses it for real.
	const retryInstall = (): void => {
		setInstallError(null);
		setInstallPhase("engine");
		initTts();
	};

	return {
		installPhase,
		installError,
		handleEnabledToggle,
		retryInstall,
	};
}
