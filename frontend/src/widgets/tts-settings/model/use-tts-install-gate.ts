import { useCallback, useEffect, useState } from "react";
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
				setInstallPhase(phase === "ready" ? null : phase);
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

	const runProbe = useCallback(async (): Promise<TtsDownloadEstimatePayload> => {
		setProbing(true);
		try {
			const est = await ttsDownloadEstimate();
			setEstimate(est);
			return est;
		} finally {
			setProbing(false);
		}
	}, []);

	const handleEnabledToggle = useCallback(
		(next: boolean) => {
			if (!next) {
				update({ enabled: false });
				setInstallPhase(null);
				setConfirmOpen(false);
				return;
			}
			runProbe().then((est) => {
				if (est.alreadyInstalled && !est.unavailable) {
					update({ enabled: true });
					return;
				}
				setConfirmOpen(true);
			});
		},
		[update, runProbe]
	);

	const handleInstallConfirm = useCallback(() => {
		if (estimate?.unavailable) {
			// Offline: the confirm button is "Retry" — re-probe instead of
			// enabling (which would just fail without a network).
			runProbe();
			return;
		}
		setConfirmOpen(false);
		update({ enabled: true });
	}, [estimate?.unavailable, runProbe, update]);

	const handleInstallCancel = useCallback(() => {
		setConfirmOpen(false);
	}, []);

	const closeConfirm = useCallback(() => {
		setConfirmOpen(false);
	}, []);

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
