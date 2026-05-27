import {
	EMPTY_CONTEXT,
	formatContextForPrompt,
	isDeniedByList,
	redactSensitiveFields,
	type WindowContextSnapshot,
} from "../lib/context-snapshot";

/**
 * Context-awareness state machine: captures a window snapshot on
 * recording_start and serves it back to fullSentence as a formatted
 * prompt fragment. State is closure-local so multiple relays
 * (theoretically) and tests can each own an independent instance.
 *
 * Lifecycle per dictation cycle:
 *   1. relay.recording_start  → capture()
 *      → when the read resolves, onSnapshotReady(snapshot) fires once
 *        (deny-list filter applied). Used to push a per-utterance ASR
 *        prompt augmentation to the server.
 *   2. relay.fullSentence     → consume() → "...formatted..." or ""
 *      → onSnapshotCleared() fires (so the ASR augmentation is dropped
 *        even when the dictation LLM never reads the snapshot).
 *   3. relay.recording_start  → capture() (overwrites stale promise;
 *      stale onSnapshotReady firings are ignored via a generation token).
 *
 * When the setting is off, capture() / consume() are cheap no-ops that
 * never spawn the helper binary. The user pays nothing until they opt in.
 *
 * Deny-list filter: the post-capture snapshot is matched against the
 * user-managed `general.contextDenyList` BEFORE it's formatted for the
 * LLM (and before it's handed to onSnapshotReady). Apps/URL hosts on
 * the list still produce a snapshot (so the LLM knows *something* was
 * active) but sensitive fields are stripped. This is checked at
 * consume-/notify-time rather than capture-time so the list can be
 * edited live without restarting a recording.
 */
export interface ContextCapture {
	capture(): void;
	clear(): void;
	consume(): Promise<string>;
}

export interface ContextCaptureDeps {
	getDenyList: () => readonly string[];
	isEnabled: () => boolean;
	/**
	 * Fired when the snapshot's lifetime ends: consume(), clear(), or
	 * when a second capture() overrides the first. Use this to drop any
	 * per-utterance side effects (e.g., the volatile ASR prompt tail in
	 * initial-prompt-sync). Optional — falsy = no-op.
	 */
	onSnapshotCleared?: () => void;
	/**
	 * Fired once per capture(), after the read resolves and the
	 * deny-list filter has been applied. Receives the post-filter
	 * snapshot — fields stripped by the deny-list will be empty.
	 * Optional — falsy = no-op. Stale firings (a second capture
	 * overrode the first while the read was in-flight) are suppressed.
	 */
	onSnapshotReady?: (snapshot: WindowContextSnapshot) => void;
	read: () => Promise<WindowContextSnapshot>;
}

function applyDenyList(
	snapshot: WindowContextSnapshot,
	denyList: readonly string[]
): WindowContextSnapshot {
	return isDeniedByList(snapshot, denyList) ? redactSensitiveFields(snapshot) : snapshot;
}

export function createContextCapture(deps: ContextCaptureDeps): ContextCapture {
	let pending: Promise<WindowContextSnapshot> | null = null;

	const fireCleared = (): void => {
		deps.onSnapshotCleared?.();
	};

	const capture = (): void => {
		if (!deps.isEnabled()) {
			// If a previous capture left state behind (setting flipped
			// mid-session), drop it so the ASR side doesn't keep a stale
			// volatile prompt around.
			if (pending !== null) {
				pending = null;
				fireCleared();
			}
			return;
		}
		// Overwriting an in-flight capture: drop the previous lifecycle
		// before kicking off the new one. The generation-token guard
		// below stops the old read's onSnapshotReady from firing once
		// the new pending replaces it.
		if (pending !== null) {
			fireCleared();
		}
		// Fire the read immediately so the helper's cold-start runs in
		// parallel with the user's first words. By the time the final
		// transcript arrives, the snapshot is almost always already
		// resolved.
		const myPending: Promise<WindowContextSnapshot> = deps.read().catch(() => EMPTY_CONTEXT);
		pending = myPending;
		// Side channel: hand the snapshot to the onSnapshotReady consumer
		// as soon as it's available, so per-utterance bias (e.g., Whisper
		// prompt) lands before recording_stop kicks off transcribe. Stale
		// resolutions (capture #2 raced ahead of capture #1's read) are
		// dropped via the identity check on `pending`. The await is
		// fire-and-forget — `read()` is already wrapped in `.catch()` so
		// the inner promise never rejects.
		myPending.then(
			(snapshot) => {
				if (pending !== myPending) {
					return;
				}
				deps.onSnapshotReady?.(applyDenyList(snapshot, deps.getDenyList()));
			},
			() => {
				// Unreachable — read() is wrapped above — but biome's
				// noFloatingPromises wants both arms attached.
			}
		);
	};

	const consume = async (): Promise<string> => {
		const promise = pending;
		pending = null;
		if (!promise) {
			return "";
		}
		const snapshot = await promise;
		// Apply deny-list at consume-time, not capture-time, so the
		// user can edit the list from settings and have the change
		// take effect on the next dictation without a restart.
		const filtered = applyDenyList(snapshot, deps.getDenyList());
		// Drop ASR-side state alongside the LLM-side state — they share
		// one snapshot lifetime, so we can't leave the augmented prompt
		// hanging after consume().
		fireCleared();
		return formatContextForPrompt(filtered);
	};

	const clear = (): void => {
		if (pending === null) {
			return;
		}
		pending = null;
		fireCleared();
	};

	return { capture, consume, clear };
}
