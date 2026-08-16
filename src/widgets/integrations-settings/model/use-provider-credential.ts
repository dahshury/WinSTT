import { type RefObject, useEffect, useRef, useState } from "react";
import { useCredentialStatusStore } from "@/entities/cloud-stt-credential";
import { useSettingsStore } from "@/entities/setting";
import {
	type ClearableProvider,
	revertSurfacesForClearedProvider,
} from "@/features/revert-cloud-on-key-removal";
import {
	type VerifyResponse,
	verifyCredentialCommand,
} from "@/features/verify-credentials";
import {
	displaySecretValue,
	isProbedSecretCurrent,
	isSecretPresent,
	SECRET_CLEAR_SENTINEL,
} from "@/shared/config/settings-schema";
import { fireAndForget } from "@/shared/lib/fire-and-forget";
import {
	type IntegrationVerifyEntry,
	useIntegrationVerifyStatus,
	useIntegrationVerifyStore,
} from "./integration-verify-store";

/** Window after the last keystroke before the provider's auth endpoint is hit.
 *  Long enough that a paste produces one probe, short enough that the verdict
 *  lands before the user moves on. Unchanged from both legacy rows. */
const VERIFY_DEBOUNCE_MS = 600;

/** What a settled probe means for the pill AND for the persisted verdict.
 *  `verified: null` = "don't record anything" — a transport failure says
 *  nothing about the key, so it must not overwrite a good `verified` flag. */
interface VerifyOutcome {
	entry: IntegrationVerifyEntry;
	verified: boolean | null;
}

type VerifySettlement =
	| { err: unknown; ok: false }
	| { ok: true; response: VerifyResponse };

/** Pure mapper from a settled probe to the next pill state + persisted verdict.
 *  Split out of the runner so the async path stays under Biome's cognitive
 *  complexity cap and avoids nested ternaries. */
function outcomeOf(settled: VerifySettlement): VerifyOutcome {
	if (!settled.ok) {
		const message =
			settled.err instanceof Error
				? settled.err.message
				: String(settled.err ?? "");
		// IPC transport failure — same semantics as `code: "network"`: the key may
		// be fine, we just could not reach the provider.
		return {
			entry: { status: "offline", ...(message ? { lastError: message } : {}) },
			verified: null,
		};
	}
	const { response } = settled;
	if (response.ok) {
		return { entry: { status: "verified" }, verified: true };
	}
	if (response.code === "network") {
		return {
			entry: { status: "offline", lastError: response.message },
			verified: null,
		};
	}
	// Anything else (auth failure, malformed key, key_missing) — the provider has
	// explicitly rejected this value. The key stays persisted so the user can fix
	// it without re-typing; only the verdict flips.
	return {
		entry: { status: "invalid", lastError: response.message },
		verified: false,
	};
}

/**
 * Marker for an OPEN, uncommitted Replace — its presence is what makes the
 * hook hold the draft back instead of writing it through (see `onType`).
 *
 * It carries only the live pill entry, because that is the one piece of state a
 * pending Replace still mutates: the draft's own probes overwrite it, and
 * abandoning the edit must leave no trace. The stored key and its persisted
 * verdict are deliberately NOT in here — nothing writes them while a Replace is
 * pending, so there is nothing to put back.
 */
interface CredentialSnapshot {
	live: IntegrationVerifyEntry;
}

/** A settled verdict for a Replace draft that is not the stored key yet. It
 *  cannot be persisted on arrival — `integrations.elevenlabs.verified` would
 *  then describe the OLD key — so it waits here for the commit that writes the
 *  key it belongs to, and is dropped if the edit is abandoned. */
interface PendingVerdict {
	key: string;
	verified: boolean;
}

export interface ProviderCredential {
	/** Abandon a Replace: drop the draft and put the pill back the way Replace
	 *  found it. The stored key was never touched, so there is nothing to undo. */
	cancelReplace: () => void;
	/** The remove ConfirmDialog said yes. */
	confirmRemove: () => void;
	/** Value for the editable field (empty while a Replace is pending). */
	editableValue: string;
	editing: boolean;
	/** Commit the edit and seal it (blur with a real value). For a Replace this
	 *  is the ONE moment the stored key is overwritten. */
	endEditing: () => void;
	/** A key is registered — sealed display, Remove and the in-use gate all
	 *  hang off this. */
	hasKey: boolean;
	inputRef: RefObject<HTMLInputElement | null>;
	live: IntegrationVerifyEntry;
	onType: (value: string) => void;
	/** Last verdict written to disk, or `null` when the provider has no such
	 *  settings field. Feeds the pill's idle fallback. */
	persistedVerified: boolean | null;
	removeDialogOpen: boolean;
	/** Remove pressed. `blockingActive` opens the confirm gate instead of
	 *  clearing outright; the caller owns that decision. */
	requestRemove: (blockingActive: boolean) => void;
	/** A key is stored AND not being edited → show the sealed display. */
	sealed: boolean;
	setRemoveDialogOpen: (open: boolean) => void;
	/** Swap the sealed display for an empty, focused field WITHOUT destroying
	 *  the stored key. */
	startReplace: () => void;
	/** Raw settings value — masked sentinel, plaintext draft, or empty. Only
	 *  `maskedKeyDisplay` may read characters out of it. */
	storedKey: string;
	/** Manual re-verify, bypassing the debounce. */
	testConnection: () => void;
}

/**
 * The ONE credential state machine behind every keyed provider card.
 *
 * OpenRouter and ElevenLabs used to have parallel, drifted copies of this logic
 * in two separate components: only ElevenLabs persisted its verdict and joined
 * the shared status store, so a rejected OpenRouter key silently read as good
 * after any remount. Everything provider-specific is now confined to the small
 * branches below — where the key lives, where the verdict goes, and which store
 * mirrors it.
 *
 * Persistence is never gated on verification — the probe only drives the pill
 * and the `verified` metadata — but WHEN it happens depends on whether there is
 * a key at risk:
 *
 *   - Entering a key into an empty field writes through on every keystroke, so
 *     unmounting the panel (switching settings tabs) cannot lose it mid-probe.
 *     The only thing a partial write can destroy there is itself.
 *   - A Replace over a SEALED key holds the draft in React state until
 *     `endEditing` commits it. The renderer only ever holds that key's mask, so
 *     a half-typed write-through would reach `preserve_masked_secret`
 *     (settings_store.rs) as real material and overwrite — and re-seal — the
 *     user's actual key. Cancelling could not undo it: the renderer has nothing
 *     to restore but the mask, which the backend resolves to "keep whatever is
 *     stored", i.e. the fragment. Abandoning a Replace therefore costs the
 *     draft (and only the draft); the stored key survives untouched.
 */
export function useProviderCredential(
	provider: ClearableProvider,
): ProviderCredential {
	const openrouterKey = useSettingsStore(
		(s) => s.settings.llm.openrouterApiKey,
	);
	const elevenlabsKey = useSettingsStore(
		(s) => s.settings.integrations.elevenlabs.apiKey,
	);
	const elevenlabsVerified = useSettingsStore(
		(s) => s.settings.integrations.elevenlabs.verified,
	);
	const updateLlmSettings = useSettingsStore((s) => s.updateLlmSettings);
	const updateIntegrations = useSettingsStore((s) => s.updateIntegrations);
	const live = useIntegrationVerifyStatus(provider);

	const isOpenrouter = provider === "openrouter";
	const storedKey = isOpenrouter ? openrouterKey : elevenlabsKey;
	// OpenRouter's key lives on `llm.openrouterApiKey`, which carries no
	// verified/lastVerifiedAt companion — see the store's deviation note.
	const persistedVerified = isOpenrouter ? null : elevenlabsVerified;

	const [draft, setDraft] = useState("");
	const [editing, setEditing] = useState(false);
	const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
	const debounceRef = useRef<number | null>(null);
	const reqIdRef = useRef(0);
	const snapshotRef = useRef<CredentialSnapshot | null>(null);
	const pendingVerdictRef = useRef<PendingVerdict | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);

	/** A Replace is open and has not been committed — the stored key is still the
	 *  old one, so nothing may be written against it. */
	const replacePending = () => snapshotRef.current !== null;

	// ── provider-specific seams ───────────────────────────────────────────────

	const readStoredKey = () => {
		const settings = useSettingsStore.getState().settings;
		return isOpenrouter
			? settings.llm.openrouterApiKey
			: settings.integrations.elevenlabs.apiKey;
	};

	const setStatus = (entry: IntegrationVerifyEntry) => {
		useIntegrationVerifyStore.getState().setStatus(provider, entry);
		// The onboarding wizard reads ElevenLabs' pill straight from the
		// cloud-stt-credential entity store, so keep mirroring into it — the two
		// surfaces must never disagree. OpenRouter is absent from that store's
		// provider union (`IntegrationCloudProvider` excludes it), which is
		// precisely the asymmetry `useIntegrationVerifyStore` exists to absorb.
		if (!isOpenrouter) {
			useCredentialStatusStore.getState().setStatus("elevenlabs", entry);
		}
	};

	/** Write a typed key. ElevenLabs' verdict fields reset alongside it — the
	 *  stored verdict belongs to the OLD key and would otherwise be read as this
	 *  one's. */
	const writeTypedKey = (value: string) => {
		if (isOpenrouter) {
			updateLlmSettings({ openrouterApiKey: value });
			return;
		}
		updateIntegrations({
			elevenlabs: { apiKey: value, lastVerifiedAt: null, verified: null },
		});
	};

	const recordVerdict = (verified: boolean) => {
		if (isOpenrouter) {
			return;
		}
		updateIntegrations({
			elevenlabs: { lastVerifiedAt: Date.now(), verified },
		});
	};

	/** Route a settled verdict to disk — or park it until the key it describes is
	 *  actually stored. A probe carrying the MASK is a probe of the stored key
	 *  (`resolve_verify_api_key` swaps the sealed material back in), so its
	 *  verdict is about that key and persists straight away. A probe of a Replace
	 *  draft is not: writing it now would stamp the old key with the new key's
	 *  verdict. */
	const persistVerdict = (probedKey: string, verified: boolean) => {
		if (replacePending() && !isSecretPresent(probedKey)) {
			pendingVerdictRef.current = { key: probedKey, verified };
			return;
		}
		recordVerdict(verified);
	};

	/** Explicit removal posts the CLEAR sentinel (not `""`): the backend now
	 *  reads an empty incoming secret as "keep the stored key", so an empty
	 *  string would silently no-op the removal. */
	const writeClear = () => {
		if (isOpenrouter) {
			updateLlmSettings({ openrouterApiKey: SECRET_CLEAR_SENTINEL });
			return;
		}
		updateIntegrations({
			elevenlabs: {
				apiKey: SECRET_CLEAR_SENTINEL,
				lastVerifiedAt: null,
				verified: null,
			},
		});
	};

	// ── probe lifecycle ───────────────────────────────────────────────────────

	const cancelPendingProbe = () => {
		if (debounceRef.current !== null) {
			window.clearTimeout(debounceRef.current);
			debounceRef.current = null;
		}
		// Bump the request id so any IN-FLIGHT probe resolves into the stale branch
		// and cannot write a verdict for a key that is no longer current.
		reqIdRef.current++;
	};

	useEffect(
		() => () => {
			if (debounceRef.current !== null) {
				window.clearTimeout(debounceRef.current);
			}
			reqIdRef.current++;
		},
		[],
	);

	// Replace hands the user an empty field; move focus there so the action is
	// finished by typing rather than by a second click.
	useEffect(() => {
		if (editing) {
			inputRef.current?.focus();
		}
	}, [editing]);

	const runVerify = async (key: string) => {
		const myReqId = ++reqIdRef.current;
		if (key.trim().length === 0) {
			setStatus({ status: "idle" });
			return;
		}
		setStatus({ status: "verifying" });
		// Dispatch, then fold BOTH settlements into one outcome. No conditional
		// early-return follows the await — the stale check feeds the same sink —
		// which keeps `react-doctor/async-defer-await` satisfied.
		const settled: VerifySettlement = await verifyCredentialCommand(
			provider,
			key,
		).then(
			(response) => ({ ok: true as const, response }),
			(err: unknown) => ({ err, ok: false as const }),
		);
		// A stored key masked to the SECRET_PRESENT sentinel by a backend
		// save/broadcast that raced this probe is the SAME key we verified, now
		// sealed — not a stale signal. Only a request-id bump (fresh keystroke,
		// removal, cancelled replace) marks the probe stale.
		const isStale =
			myReqId !== reqIdRef.current ||
			!isProbedSecretCurrent(readStoredKey(), key);
		if (!isStale) {
			const outcome = outcomeOf(settled);
			setStatus(outcome.entry);
			if (outcome.verified !== null) {
				persistVerdict(key, outcome.verified);
			}
		}
	};

	// ── actions ───────────────────────────────────────────────────────────────

	const onType = (value: string) => {
		setDraft(value);
		setEditing(true);
		// A pending Replace is the one path that must NOT write through: see the
		// hook's header note — the stored key is sealed on the native side and a
		// partial draft reaching the backend destroys it irreversibly. The draft
		// lives in state until `endEditing` commits it whole.
		if (!replacePending()) {
			writeTypedKey(value);
		}
		cancelPendingProbe();
		if (value.trim().length === 0) {
			setStatus({ status: "idle" });
			return;
		}
		debounceRef.current = window.setTimeout(() => {
			debounceRef.current = null;
			fireAndForget(runVerify(value), "integrations.verifyOnType");
		}, VERIFY_DEBOUNCE_MS);
	};

	const startReplace = () => {
		// Setting the snapshot is what ARMS the hold-back in `onType`; capturing the
		// pill alongside it is what makes abandoning the edit leave no trace, since
		// the draft's probes are the only thing a pending Replace still mutates.
		snapshotRef.current = {
			live: useIntegrationVerifyStore.getState().byProvider[provider],
		};
		pendingVerdictRef.current = null;
		setDraft("");
		setEditing(true);
	};

	const cancelReplace = () => {
		cancelPendingProbe();
		setDraft("");
		setEditing(false);
		const snapshot = snapshotRef.current;
		snapshotRef.current = null;
		pendingVerdictRef.current = null;
		if (snapshot) {
			// Nothing was persisted while the Replace was open, so the stored key and
			// its verdict are already exactly as they were. Only the pill moved —
			// put it back so a rejected draft cannot leave the kept key looking bad.
			setStatus(snapshot.live);
		}
	};

	const endEditing = () => {
		const snapshot = snapshotRef.current;
		if (snapshot && draft.trim().length === 0) {
			// An empty Replace field is an abandonment, not a removal — removal goes
			// through `clearKey`. (The row already routes this to `cancelReplace`;
			// the guard keeps the invariant if another caller does not.)
			cancelReplace();
			return;
		}
		snapshotRef.current = null;
		setEditing(false);
		if (!snapshot) {
			// First-time entry: every keystroke already wrote through, so sealing is
			// purely a display switch.
			return;
		}
		// The commit point for a Replace. Only here is the sealed key overwritten,
		// and only with a whole draft.
		writeTypedKey(draft);
		const verdict = pendingVerdictRef.current;
		pendingVerdictRef.current = null;
		// `writeTypedKey` reset the verdict fields for the OLD key; a verdict that
		// settled for THIS draft is now safe to persist, because the draft is what
		// is stored.
		if (verdict?.key === draft) {
			recordVerdict(verdict.verified);
		}
	};

	const clearKey = () => {
		cancelPendingProbe();
		setDraft("");
		setEditing(false);
		snapshotRef.current = null;
		pendingVerdictRef.current = null;
		// Order is load-bearing and survives a fast settings-window close: revert
		// the surfaces this key backs SYNCHRONOUSLY, then wipe.
		revertSurfacesForClearedProvider(provider);
		writeClear();
		setStatus({ status: "idle" });
	};

	const requestRemove = (blockingActive: boolean) => {
		if (blockingActive) {
			setRemoveDialogOpen(true);
			return;
		}
		clearKey();
	};

	const testConnection = () => {
		cancelPendingProbe();
		// A sealed key's plaintext never reaches the renderer, so the masked value
		// is what gets sent: `resolve_verify_api_key` (verify.rs) recognises the
		// mask by prefix and probes with the key the backend already holds. An
		// open-but-empty Replace field falls back to the stored key for the same
		// reason — testing "" would report the saved credential as missing.
		const candidate = draft.trim().length > 0 ? draft : readStoredKey();
		fireAndForget(runVerify(candidate), "integrations.testConnection");
	};

	// The CLEAR sentinel is parked in the store until the backend broadcasts the
	// cleared value back — treat it as "no key" for every display-derived value.
	const displayKey = displaySecretValue(storedKey);
	const hasKey = displayKey.trim().length > 0;

	return {
		cancelReplace,
		confirmRemove: clearKey,
		editableValue: editing ? draft : displayKey,
		editing,
		endEditing,
		hasKey,
		inputRef,
		live,
		onType,
		persistedVerified,
		removeDialogOpen,
		requestRemove,
		sealed: hasKey && !editing,
		setRemoveDialogOpen,
		startReplace,
		storedKey,
		testConnection,
	};
}
