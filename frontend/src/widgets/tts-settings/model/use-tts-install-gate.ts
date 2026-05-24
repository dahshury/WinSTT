import { useEffect, useState } from "react";
import { useSettingsStore } from "@/entities/setting";
import {
	onTtsInstallStatus,
	onTtsModelDownloadComplete,
	type TtsDownloadEstimatePayload,
	type TtsInstallPhase,
	ttsDownloadEstimate,
} from "@/shared/api/ipc-client";

export interface TtsInstallGate {
	/** Backdrop/Escape close. */
	closeConfirm: () => void;
	/** Show the confirm dialog (suppressed while probing the estimate). */
	confirmOpen: boolean;
	/** Server's size breakdown, or null before the first probe. */
	estimate: TtsDownloadEstimatePayload | null;
	/** Pass to `SettingSection.onToggle`. Gates ON behind the dialog. */
	handleEnabledToggle: (next: boolean) => void;
	/** Dialog reject — stays disabled. */
	handleInstallCancel: () => void;
	/** Dialog accept. Enables (or re-probes when offline). */
	handleInstallConfirm: () => void;
	/** Current install phase, or null when idle / ready. */
	installPhase: TtsInstallPhase | null;
	/** True while the estimate is in flight. */
	probing: boolean;
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
export function projectInstallPhase(phase: TtsInstallPhase): TtsInstallPhase | null {
	return READY_PROJECTION[phase];
}

/**
 * Picks the post-probe action without `&&`/`if`:
 *   - `enable`: server says the engine + model are on disk and reachable
 *   - `confirm`: anything else — show the download dialog
 *
 * The two boolean checks are converted to 0/1 and multiplied, then used as
 * an index into the action tuple. Branch-free → CC 1.
 */
export type ProbeActionKey = "confirm" | "enable";

const PROBE_ACTION_BY_INDEX: readonly ProbeActionKey[] = ["confirm", "enable"];

/** Pure helper — exported for tests. */
export function resolveProbeAction(est: TtsDownloadEstimatePayload): ProbeActionKey {
	const installedFlag = Number(est.alreadyInstalled === true);
	const reachableFlag = Number(est.unavailable !== true);
	return PROBE_ACTION_BY_INDEX[installedFlag * reachableFlag] as ProbeActionKey;
}

/**
 * Picks the confirm-button action: "Retry" probes again offline,
 * "Confirm" closes the dialog and flips `enabled` on. Branch-free.
 */
export type ConfirmActionKey = "enable" | "retry";

const CONFIRM_ACTION_BY_INDEX: readonly ConfirmActionKey[] = ["enable", "retry"];

/** Pure helper — exported for tests. */
export function resolveConfirmAction(
	estimate: TtsDownloadEstimatePayload | null
): ConfirmActionKey {
	const offlineFlag = Number(estimate?.unavailable === true);
	return CONFIRM_ACTION_BY_INDEX[offlineFlag] as ConfirmActionKey;
}

/** Picks the toggle action without an `if`. */
export type ToggleActionKey = "disable" | "enable";

const TOGGLE_ACTION_BY_INDEX: readonly ToggleActionKey[] = ["disable", "enable"];

/** Pure helper — exported for tests. */
export function resolveToggleAction(next: boolean): ToggleActionKey {
	return TOGGLE_ACTION_BY_INDEX[Number(next === true)] as ToggleActionKey;
}

/**
 * Confirm-before-download gate for enabling TTS.
 *
 * The settings store's `tts.enabled` flag is what actually triggers the
 * on-demand install (electron's tts store listener fires `init_tts` on
 * the off→on edge → the server downloads the engine pack + model). So we
 * must NOT flip that flag until the user accepts the confirmation dialog.
 * Turning OFF is immediate; turning ON probes the download size first and
 * opens the dialog (or, if everything's already on disk, enables straight
 * away with no dialog).
 */
export function useTtsInstallGate(): TtsInstallGate {
	const update = useSettingsStore((s) => s.updateTtsSettings);

	const [confirmOpen, setConfirmOpen] = useState(false);
	const [estimate, setEstimate] = useState<TtsDownloadEstimatePayload | null>(null);
	const [probing, setProbing] = useState(false);
	const [installPhase, setInstallPhase] = useState<TtsInstallPhase | null>(null);

	// Install-phase ping (engine pack → voice model → ready) labels the
	// progress UI; cleared once the engine reports ready or the download
	// finishes.
	useEffect(
		() =>
			onTtsInstallStatus(({ phase }) => {
				setInstallPhase(projectInstallPhase(phase));
			}),
		[]
	);
	useEffect(
		() =>
			onTtsModelDownloadComplete(() => {
				setInstallPhase(null);
			}),
		[]
	);

	const runProbe = async (): Promise<TtsDownloadEstimatePayload> => {
		setProbing(true);
		try {
			const est = await ttsDownloadEstimate();
			setEstimate(est);
			return est;
		} finally {
			setProbing(false);
		}
	};

	// Post-probe dispatch: tuple keyed by `resolveProbeAction` — no `if`.
	const probeActions: Record<ProbeActionKey, (est: TtsDownloadEstimatePayload) => void> = {
		enable: () => {
			update({ enabled: true });
		},
		confirm: () => {
			setConfirmOpen(true);
		},
	};
	const handleProbeResult = (est: TtsDownloadEstimatePayload): void => {
		probeActions[resolveProbeAction(est)](est);
	};

	// Toggle dispatch: tuple keyed by `resolveToggleAction` — no `if`.
	const toggleActions: Record<ToggleActionKey, () => void> = {
		enable: () => {
			runProbe().then(handleProbeResult);
		},
		disable: () => {
			update({ enabled: false });
			setInstallPhase(null);
			setConfirmOpen(false);
		},
	};
	const handleEnabledToggle = (next: boolean): void => {
		toggleActions[resolveToggleAction(next)]();
	};

	// Confirm-button dispatch: tuple keyed by `resolveConfirmAction` — no `if`.
	const confirmActions: Record<ConfirmActionKey, () => void> = {
		enable: () => {
			setConfirmOpen(false);
			update({ enabled: true });
		},
		retry: () => {
			runProbe();
		},
	};
	const handleInstallConfirm = (): void => {
		confirmActions[resolveConfirmAction(estimate)]();
	};

	const handleInstallCancel = (): void => {
		setConfirmOpen(false);
	};

	const closeConfirm = (): void => {
		setConfirmOpen(false);
	};

	return {
		confirmOpen,
		estimate,
		probing,
		installPhase,
		handleEnabledToggle,
		handleInstallConfirm,
		handleInstallCancel,
		closeConfirm,
	};
}
