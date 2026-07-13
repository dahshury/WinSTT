import { useState } from "react";
import {
	assessEncoderDictFitClient,
	useSystemResourcesStore,
} from "@/entities/system-resources";
import type { FitAssessmentEntry } from "@/shared/api/ipc-client";
import { fireAndForget } from "@/shared/lib/fire-and-forget";

/** A critical fit warning awaiting the user's decision. ``proceed`` applies the
 * enable that was gated; dismissing (cancel/escape) drops it and leaves the
 * feature off. */
export interface PendingEncoderWarning {
	assessment: FitAssessmentEntry;
	proceed: () => void;
}

export interface EncoderFitGate {
	pendingWarning: PendingEncoderWarning | null;
	/** Gate turning the encoder dictionary ON. Refreshes live resources, checks
	 * the ~310 MB CPU footprint against available RAM, and either applies
	 * ``enable`` immediately (fits / no snapshot to judge) or stashes a warning
	 * the user must confirm. Disabling should NOT go through here — freeing
	 * memory is always safe. */
	requestEnable: (enable: () => void) => void;
	clearWarning: () => void;
}

async function gateEnable(
	enable: () => void,
	setPending: (p: PendingEncoderWarning | null) => void,
): Promise<void> {
	const store = useSystemResourcesStore.getState();
	// Force a fresh snapshot — the Vocabulary tab doesn't poll resources, so a
	// stale reading could clear or raise a warning that no longer matches reality.
	await store.refresh(true);
	const live = useSystemResourcesStore.getState().liveResources;
	if (live === null) {
		// No snapshot to judge against — fail open, same as the STT gate.
		enable();
		return;
	}
	const assessment = assessEncoderDictFitClient(live);
	// Only a hard "won't fit" blocks — mirrors the STT model gate, which surfaces
	// the dialog on ``critical`` and lets ``warning`` through silently.
	if (assessment.severity === "critical") {
		setPending({ assessment, proceed: enable });
		return;
	}
	enable();
}

export function useEncoderFitGate(): EncoderFitGate {
	const [pendingWarning, setPendingWarning] =
		useState<PendingEncoderWarning | null>(null);

	const requestEnable = (enable: () => void) => {
		fireAndForget(
			gateEnable(enable, setPendingWarning),
			"encoder_dict_fit_gate",
		);
	};

	const clearWarning = () => setPendingWarning(null);

	return { pendingWarning, requestEnable, clearWarning };
}
