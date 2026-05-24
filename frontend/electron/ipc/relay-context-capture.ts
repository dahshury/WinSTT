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
 *   2. relay.fullSentence     → consume() → "...formatted..." or ""
 *   3. relay.recording_start  → capture() (overwrites stale promise)
 *
 * When the setting is off, capture() / consume() are cheap no-ops that
 * never spawn the helper binary. The user pays nothing until they opt in.
 *
 * Deny-list filter: the post-capture snapshot is matched against the
 * user-managed `general.contextDenyList` BEFORE it's formatted for the
 * LLM. Apps/URL hosts on the list still produce a snapshot (so the LLM
 * knows *something* was active) but the sensitive fields are stripped.
 * This is checked at consume-time rather than capture-time so the list
 * can be edited live without restarting a recording.
 */
export interface ContextCapture {
	capture(): void;
	clear(): void;
	consume(): Promise<string>;
}

export interface ContextCaptureDeps {
	getDenyList: () => readonly string[];
	isEnabled: () => boolean;
	read: () => Promise<WindowContextSnapshot>;
}

export function createContextCapture(deps: ContextCaptureDeps): ContextCapture {
	let pending: Promise<WindowContextSnapshot> | null = null;

	const capture = (): void => {
		if (!deps.isEnabled()) {
			pending = null;
			return;
		}
		// Fire the read immediately so the helper's cold-start runs in
		// parallel with the user's first words. By the time the final
		// transcript arrives, the snapshot is almost always already
		// resolved.
		pending = deps.read().catch(() => EMPTY_CONTEXT);
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
		const filtered = isDeniedByList(snapshot, deps.getDenyList())
			? redactSensitiveFields(snapshot)
			: snapshot;
		return formatContextForPrompt(filtered);
	};

	const clear = (): void => {
		pending = null;
	};

	return { capture, consume, clear };
}
