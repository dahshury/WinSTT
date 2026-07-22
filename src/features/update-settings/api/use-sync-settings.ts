import { useEffect, useRef } from "react";
import { useConnectionStore } from "@/entities/connection";
import {
	getSettingsStoreState,
	useSettingsHydrationStore,
	useSettingsStore,
} from "@/entities/setting";
import {
	hasSettingsBackend,
	onSettingsChangedSnapshot,
	onSettingsSaveError,
	settingsLoadSnapshotStrict,
	settingsSave,
	settingsSaveAck,
	sttRequestDiarizationToggle,
	sttSetParameter,
	waitForPendingNativeListeners,
} from "@/shared/api/ipc-client";
import type { SettingsDecodeDiagnostics } from "@/shared/config/settings-codec";
import type { AppSettingsOutput as AppSettings } from "@/shared/config/settings-schema";
import {
	markIpcLoadResolved,
	recentIpcLoadAt,
} from "@/shared/lib/ipc-load-timing";

// Window during which we treat any debounced disk save as "potentially
// racing a setSettings(loaded) revert". When the debounce timer fires
// within this window, we re-check the latest settings against the value
// the IPC load just stamped — if they match a load-induced revert, the
// save is suppressed (we'd otherwise persist whichever transient state
// won the StrictMode-double-mount race, which has been the source of
// the recurring "disk gets stale tiny" → "switching to tiny" loop).
// Matches the guard in `useSyncActiveModel`.
const SAVE_IPC_LOAD_GUARD_MS = 500;

import { type SyncDeps, syncToServer } from "../lib/sync-actions";
import {
	advanceSkipRefs,
	deriveBroadcastUpdate,
	deriveIpcLoadUpdate,
	isModeChanged,
	isPrimarySyncWindow,
	mergeBroadcastPreservingUserDirty,
	scheduleSave,
	settingsSectionsEqual,
	shouldSyncOnConnect,
	treeCarriesNoUserInfo,
} from "../lib/sync-helpers";

const DEPS: SyncDeps = {
	sttRequestDiarizationToggle,
	sttSetParameter,
};

export function useSyncSettings(): void {
	const settings = useSettingsStore((s) => s.settings);
	const isLoaded = useSettingsStore((s) => s.isLoaded);
	const setSettings = useSettingsStore((s) => s.setSettings);
	const hydrationStatus = useSettingsHydrationStore((s) => s.status);
	const setHydrationStatus = useSettingsHydrationStore((s) => s.setStatus);
	const retryToken = useSettingsHydrationStore((s) => s.retryToken);
	const serverStatus = useConnectionStore((s) => s.serverStatus);
	const prevRef = useRef(settings);
	const loadedOnceRef = useRef(false);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Absolute-time deadline of the current debounced user save. Unlike
	// `debounceRef` (which the effect cleanup clears on every settings change),
	// this survives across broadcast-driven re-renders so a burst of unrelated
	// broadcasts can't keep pushing the save out indefinitely (audit #32).
	const saveDeadlineRef = useRef<number | null>(null);
	// Set whenever the latest settings change originated from an incoming
	// broadcast (imported or another window's save). The save effect reads it to
	// avoid RESTARTING the user's debounce window on broadcast-origin churn.
	const broadcastOriginRef = useRef(false);
	// Initialised from the store's current snapshot (a non-reactive getState
	// read, equal to `settings` on first render) rather than the reactive
	// `settings` binding, so the sync effect below doesn't touch the ref with
	// render-time reactive state — which `react-hooks-js/refs` flags. Every
	// consumer reads `latestSettingsRef.current` after mount, by which point
	// the effect has synced the live value.
	const latestSettingsRef = useRef(getSettingsStoreState().settings);
	const hasSyncedOnConnect = useRef(false);
	const fromBroadcastRef = useRef(false);
	const fromIpcLoadRef = useRef(false);
	const hasIpcLoadResolvedRef = useRef(false);
	// Last settings value we know persisted store has — set on initial load and
	// after every successful debounced save. The broadcast merge uses this as
	// the baseline for "what's user-dirty" so a `settings:changed` from another
	// window can't wipe an unsaved local change the user just made.
	const lastSavedRef = useRef<AppSettings | undefined>(undefined);
	const settingsRevisionRef = useRef<number | undefined>(undefined);
	useEffect(() => {
		latestSettingsRef.current = settings;
	}, [settings]);

	// Reconcile with the backend store (source of truth) after localStorage hydration.
	// Without a backend (plain Vite/browser), leave the local cache as the editable
	// source and suppress backend side effects.
	useEffect(() => {
		const loadBaseline = getSettingsStoreState().settings;
		let cancelled = false;
		const backendAvailable = hasSettingsBackend();
		if (!backendAvailable) {
			hasIpcLoadResolvedRef.current = true;
			setHydrationStatus("unavailable");
			return () => {
				cancelled = true;
			};
		}
		setHydrationStatus("loading");
		void waitForPendingNativeListeners()
			.then(() => settingsLoadSnapshotStrict())
			.then(({ revision, settings: loaded }) => {
				if (cancelled) {
					return;
				}
				if (
					settingsRevisionRef.current !== undefined &&
					revision < settingsRevisionRef.current
				) {
					// A newer broadcast landed while this snapshot was in flight.
					// Keep it authoritative and only finish the hydration gate.
					hasIpcLoadResolvedRef.current = true;
					markIpcLoadResolved();
					setHydrationStatus("ready");
					return;
				}
				const current = getSettingsStoreState().settings;
				const { merged, nextFromIpcLoad } = deriveIpcLoadUpdate(
					loaded,
					current,
					loadBaseline,
				);
				hasIpcLoadResolvedRef.current = true;
				fromIpcLoadRef.current = nextFromIpcLoad;
				lastSavedRef.current = loaded;
				settingsRevisionRef.current = revision;
				markIpcLoadResolved();
				setSettings(merged);
				setHydrationStatus("ready");
			})
			.catch((error: unknown) => {
				if (cancelled) {
					return;
				}
				const message = error instanceof Error ? error.message : String(error);
				console.error("[settings] failed to hydrate backend settings:", error);
				setHydrationStatus("error", message);
			});
		return () => {
			cancelled = true;
		};
		// `retryToken` re-runs hydration only after an explicit user retry or a
		// backend settings-changed event proves the settings service is responsive.
	}, [setHydrationStatus, setSettings, retryToken]);

	// Listen for settings changed from other windows (e.g. settings window → main window).
	// Validate through Zod schema to ensure defaults are filled for any missing fields.
	//
	// Per-section merge: if the user has unsaved changes in a top-level section
	// (current[section] differs from `lastSavedRef`), keep the local value;
	// otherwise accept the broadcast. Without this, another window's save —
	// which always broadcasts a full snapshot — would `setSettings(decoded)`
	// over the user's just-clicked toggle inside the 300ms debounce window
	// AND the subsequent `[settings, isLoaded]` cleanup would cancel the
	// pending save, silently dropping the change.
	useEffect(() => {
		const applyBroadcast = ({
			revision,
			settings: incoming,
		}: {
			revision: number;
			settings: AppSettings;
		}): void => {
			const hydration = useSettingsHydrationStore.getState();
			if (hydration.status === "error") {
				// The event is a reliable signal that the settings backend is alive.
				// Retry once per such system event instead of probing every two seconds.
				hydration.requestRetry();
			}
			if (
				settingsRevisionRef.current !== undefined &&
				revision < settingsRevisionRef.current
			) {
				return;
			}
			settingsRevisionRef.current = revision;
			const current = getSettingsStoreState().settings;
			const { decoded, diagnostics, merged, nextFromBroadcast } =
				deriveBroadcastUpdate(
					incoming,
					current,
					lastSavedRef.current,
					fromBroadcastRef.current,
				);
			// The broadcast IS the persisted disk state (the sender just wrote it).
			// Advance our baseline so a subsequent legitimate broadcast against an
			// already-cleanly-applied state isn't misclassified as "user-dirty".
			// Without this, applying broadcast A leaves lastSavedRef pointing at
			// the pre-A baseline (the save-effect's update path is skipped via
			// fromBroadcastRef so it never re-stamps lastSavedRef), so a later
			// broadcast B sees `current = A, lastSaved = pre-A` → divergence →
			// `keep local`, and B silently drops. This was the second-order cause
			// of the "switching never reaches the main window" symptom after the
			// secrets-walker fix.
			//
			// Audit #33: stamp the DECODED/normalized value the store actually
			// holds — not the RAW `incoming` payload. Stamping raw made every
			// section read perpetually dirty (raw JSON ≠ decoded JSON) and re-send
			// forever.
			lastSavedRef.current = decoded;
			fromBroadcastRef.current = nextFromBroadcast;
			// Audit #32: mark broadcast origin so the save effect doesn't restart
			// the user's debounce window on unrelated broadcast churn.
			broadcastOriginRef.current = true;
			surfaceDecodeDiagnostics(diagnostics);
			setSettings(merged);
		};
		return onSettingsChangedSnapshot(applyBroadcast);
	}, [setSettings]);

	// Audit #46: surface backend-emitted settings save errors. `onSettingsSaveError`
	// previously had no production subscriber, so a rejected async write was
	// silent. Warn the user; the change is kept dirty by the ack path
	// (`performScheduledSave` never advances `lastSavedRef` on a rejected save),
	// so it is re-diffed and re-sent on the next edit/flush. Deliberately do NOT
	// reset `lastSavedRef` to undefined here — that would re-send the ENTIRE tree
	// including any parse-defaulted section, healing recoverable corruption into
	// permanent data loss (audit #45).
	useEffect(
		() =>
			onSettingsSaveError((error) => {
				console.error("[settings] backend rejected settings save:", error);
				useSettingsHydrationStore.getState().pushWarning("save-failed", error);
			}),
		[],
	);

	// When server signals ready (recorder fully initialized), push all saved settings.
	// Gated on `hasIpcLoadResolvedRef.current` so we don't sync the stale Zustand-persist
	// localStorage cache before the canonical persisted store snapshot has arrived.
	// See shouldSyncOnConnect for the full rationale — short version: localStorage
	// hydration flips `isLoaded` to true synchronously with potentially-stale data;
	// without the IPC gate, the first sync after connect re-asserts the cache via
	// `sttSetParameter("model", stale)` and the server swaps to the wrong model.
	useEffect(() => {
		if (
			shouldSyncOnConnect(
				serverStatus,
				isLoaded,
				hasSyncedOnConnect.current,
				hasIpcLoadResolvedRef.current && hydrationStatus === "ready",
				// Audit #1: only the main window drives the connect-time full sync so
				// the burst isn't fanned out from every open window. Per-window LIVE
				// change syncing (the settings-change effect below) is untouched.
				isPrimarySyncWindow(currentWindowLabel()),
			)
		) {
			hasSyncedOnConnect.current = true;
			syncToServer(DEPS, latestSettingsRef.current);
		}
		// Reset flag when server is not running so settings are re-synced next time
		if (serverStatus === "idle") {
			hasSyncedOnConnect.current = false;
		}
	}, [serverStatus, isLoaded, hydrationStatus]);

	// Flush any pending debounced save on window close or unmount
	useEffect(() => {
		const flush = () =>
			flushPendingSave(debounceRef, latestSettingsRef, lastSavedRef);
		window.addEventListener("beforeunload", flush);
		return () => {
			window.removeEventListener("beforeunload", flush);
			flush();
		};
	}, []);

	// Sync settings changes to persisted store and STT server
	useEffect(() => {
		if (!isLoaded || hydrationStatus !== "ready") {
			return;
		}

		const prev = prevRef.current;
		prevRef.current = settings;
		// Read+clear the broadcast-origin flag up front so it is consumed even on
		// the early-return (pure-broadcast) path and can't leak onto the user's
		// NEXT change (which would wrongly preserve the debounce deadline).
		const isBroadcastOrigin = clearIfSetBool(broadcastOriginRef);

		if (
			advanceSkipRefs({
				loadedOnce: loadedOnceRef,
				fromBroadcast: fromBroadcastRef,
				fromIpcLoad: fromIpcLoadRef,
			})
		) {
			return;
		}

		// Sync changed parameters to STT server and system settings (immediate)
		syncToServer(DEPS, settings, prev);

		// Save to persisted store: flush immediately for recording mode changes
		// so the broadcast reaches other windows without delay.
		// Debounce everything else to avoid rapid writes from sliders.
		//
		// `runScheduledSave` advances `lastSavedRef` only on a CONFIRMED backend
		// ack (audit #46), reschedules a save the IPC-load guard suppressed
		// (audit #40), and warns + keeps the section dirty on failure. The merge
		// in `onSettingsChanged` uses `lastSavedRef` to decide which sections the
		// user has unsaved changes in.
		//
		// IPC-load guard: when the debounce fires, re-check whether we're
		// still inside the boot reconciliation window. If yes, the latest
		// settings might be a transient revert from a setSettings(loaded)
		// call that hasn't been re-corrected by adoptRuntime yet — saving
		// here would persist stale state to disk (the original 'switching
		// to tiny' death-spiral cause). useSyncActiveModel re-asserts the
		// runtime value after the window closes; a later settings change
		// will schedule a fresh save with the corrected value. The guard
		// uses the shared module-level timestamp set in settingsLoad.then.
		const immediate = isModeChanged(settings, prev);
		// Audit #37: capture the import generation at schedule time. If an import
		// (or any full-tree broadcast that trips `bumpImportGeneration`) lands
		// before this debounced save fires, abort — the import's own broadcast has
		// already reconciled the store + `lastSavedRef` and scheduled its own save,
		// so firing this pre-import snapshot could revert the freshly-imported
		// section.
		const importGenAtSchedule =
			useSettingsHydrationStore.getState().importGeneration;
		const runScheduledSave = () => {
			// Window consumed — the next user edit starts a fresh debounce window.
			saveDeadlineRef.current = null;
			if (
				useSettingsHydrationStore.getState().importGeneration !==
				importGenAtSchedule
			) {
				return;
			}
			void performScheduledSave(
				latestSettingsRef,
				lastSavedRef,
				async (patch, baseline) => {
					let ack = await settingsSaveAck(patch, settingsRevisionRef.current);
					if (!ack.applied) {
						// Another window committed first. Rebase only the fields that are
						// still dirty locally onto its authoritative snapshot, then retry
						// once against the returned revision. A second conflict remains
						// visibly dirty and is surfaced instead of being overwritten.
						const current = latestSettingsRef.current;
						const { merged: rebased } = mergeBroadcastPreservingUserDirty(
							ack.settings,
							current,
							baseline,
						);
						settingsRevisionRef.current = ack.revision;
						const retryPatch = collectChangedSections(rebased, ack.settings);
						if (!hasAnyKey(retryPatch)) {
							return ack.settings;
						}
						ack = await settingsSaveAck(retryPatch, ack.revision);
						if (!ack.applied) {
							settingsRevisionRef.current = ack.revision;
							throw new Error(
								"Settings changed concurrently twice; keeping the local edit for retry",
							);
						}
					}
					settingsRevisionRef.current = ack.revision;
					return ack.settings;
				},
				{
					// Audit #40: re-arm a save for after the guard window instead of
					// dropping a save that fired inside the IPC-load reconciliation.
					onGuardSuppressed: () => {
						const remaining =
							SAVE_IPC_LOAD_GUARD_MS - (Date.now() - recentIpcLoadAt());
						scheduleSave(
							settings,
							false,
							debounceRef,
							runScheduledSave,
							Math.max(remaining + 50, 50),
						);
					},
					onSaveError: () =>
						useSettingsHydrationStore.getState().pushWarning("save-failed"),
					// A confirmed write means the "will be retried" notice is resolved —
					// clear it instead of leaving a stale error on screen.
					onSaveSuccess: () =>
						useSettingsHydrationStore
							.getState()
							.clearWarningKind("save-failed"),
				},
			);
		};
		scheduleSave(
			settings,
			immediate,
			debounceRef,
			runScheduledSave,
			computeSaveDelay(isBroadcastOrigin, immediate, saveDeadlineRef),
		);

		return () => cancelPendingSave(debounceRef);
	}, [settings, isLoaded, hydrationStatus]);
}

/**
 * The current Tauri webview's label (e.g. "main", "settings", "model-picker"),
 * read straight from the runtime-injected internals — the same source
 * `getCurrentWindow().label` uses, but synchronous and dependency-free. Returns
 * null under plain Vite / happy-dom (no `__TAURI_INTERNALS__`), where a single
 * renderer means there's no fan-out to de-dupe.
 */
function currentWindowLabel(): string | null {
	if (typeof window === "undefined") {
		return null;
	}
	const internals = (
		window as Window & {
			__TAURI_INTERNALS__?: {
				metadata?: { currentWindow?: { label?: string } };
			};
		}
	).__TAURI_INTERNALS__;
	return internals?.metadata?.currentWindow?.label ?? null;
}

/** Local boolean read+clear (avoids importing `clearIfSet` semantics change). */
function clearIfSetBool(ref: { current: boolean }): boolean {
	if (!ref.current) {
		return false;
	}
	ref.current = false;
	return true;
}

/**
 * Debounce delay for a user save, preserving the ORIGINAL deadline across
 * broadcast-origin churn (audit #32). A user edit (re)starts the 300ms window;
 * a broadcast-origin re-render keeps the existing deadline (starting one if
 * none) so a burst of unrelated broadcasts can't defer the save indefinitely.
 */
function computeSaveDelay(
	isBroadcastOrigin: boolean,
	immediate: boolean,
	saveDeadlineRef: { current: number | null },
): number {
	const now = Date.now();
	if (immediate) {
		saveDeadlineRef.current = null;
		return 300;
	}
	if (isBroadcastOrigin) {
		if (saveDeadlineRef.current == null) {
			saveDeadlineRef.current = now + 300;
		}
	} else {
		saveDeadlineRef.current = now + 300;
	}
	return Math.max(0, saveDeadlineRef.current - now);
}

/**
 * Push user-visible warnings for any recovery the decoder had to perform
 * (audit #45 defaulted sections, audit #26 hotkey rewrites). A toast renderer
 * consuming `useSettingsHydrationStore.warnings` surfaces these.
 */
function surfaceDecodeDiagnostics(
	diagnostics: SettingsDecodeDiagnostics,
): void {
	const store = useSettingsHydrationStore.getState();
	if (diagnostics.defaultedSections.length > 0) {
		store.pushWarning(
			"defaulted-sections",
			diagnostics.defaultedSections.join(", "),
		);
	}
	if (diagnostics.hotkeyRewrites.length > 0) {
		store.pushWarning("hotkey-rewrite", diagnostics.hotkeyRewrites.join(", "));
	}
}

/** Cancel any pending debounced save (called from effect-cleanup). */
function cancelPendingSave(debounceRef: {
	current: ReturnType<typeof setTimeout> | null;
}): void {
	if (debounceRef.current) {
		clearTimeout(debounceRef.current);
		debounceRef.current = null;
	}
}

/**
 * Build a partial settings patch containing only the top-level sections that
 * differ from `lastSaved`. When `lastSaved` is undefined (first save in the
 * session), send everything so the canonical disk snapshot is established.
 */
export function sectionsDiffer(a: unknown, b: unknown): boolean {
	return !settingsSectionsEqual(a, b);
}

export function collectChangedSections(
	current: AppSettings,
	lastSaved: AppSettings,
): Partial<AppSettings> {
	const patch: Record<string, unknown> = {};
	for (const key of Object.keys(current) as Array<keyof AppSettings>) {
		if (sectionsDiffer(current[key], lastSaved[key])) {
			patch[key] = current[key];
		}
	}
	return patch as Partial<AppSettings>;
}

function diffAgainstLastSaved(
	current: AppSettings,
	lastSaved: AppSettings | undefined,
): Partial<AppSettings> {
	if (lastSaved) {
		// With a baseline the diff is trustworthy: it posts only the sections the
		// user actually changed (including a section legitimately back at its
		// defaults — e.g. toggling the one customized llm field off).
		return collectChangedSections(current, lastSaved);
	}
	// No baseline → this would dump the WHOLE tree. A pure-defaults tree here is
	// an unhydrated/empty-cache store, not user intent — posting it is how a
	// boot-time window reverted wakeWord to "alexa" / model to "tiny" (and then
	// re-posted forever). Send nothing; hydration will establish the baseline.
	// The backend enforces the same rule for full-tree dumps (`accept_section`,
	// finding #21).
	if (treeCarriesNoUserInfo(current)) {
		return {};
	}
	return current;
}

function hasAnyKey(obj: Partial<AppSettings>): boolean {
	return Object.keys(obj).length > 0;
}

function patchIncludesRecordingModeChange(
	patch: Partial<AppSettings>,
	lastSaved: AppSettings | undefined,
): boolean {
	const nextMode = patch.general?.recordingMode;
	return nextMode != null && nextMode !== lastSaved?.general?.recordingMode;
}

/**
 * Body of the debounced scheduleSave callback, extracted so the IPC-load
 * guard, the diff-vs-baseline check, and the lastSavedRef advance are
 * unit-testable without standing up the whole hook.
 *
 * - Suppresses saves inside the IPC-load reconciliation window (a transient
 *   revert from `setSettings(loaded)` would otherwise be persisted, the
 *   original 'switching to tiny' death-spiral cause).
 * - Only sends sections that differ from the last-saved baseline, so a
 *   stale-snapshot window can't clobber values another window just persisted.
 */
export interface ScheduledSaveHooks {
	onGuardSuppressed?: () => void;
	onSaveError?: (patch: Partial<AppSettings>, err: unknown) => void;
	/** Fired after a confirmed successful write (the baseline has advanced). */
	onSaveSuccess?: () => void;
}

/**
 * True while the IPC-load reconciliation guard should suppress a disk save (a
 * transient revert from `setSettings(loaded)` would otherwise be persisted).
 * Recording-mode changes bypass the guard because they are immediate user intent.
 */
function isIpcLoadGuardActive(
	patch: Partial<AppSettings>,
	lastSaved: AppSettings | undefined,
): boolean {
	return (
		Date.now() - recentIpcLoadAt() < SAVE_IPC_LOAD_GUARD_MS &&
		!patchIncludesRecordingModeChange(patch, lastSaved)
	);
}

export async function performScheduledSave(
	latestSettingsRef: { current: AppSettings },
	lastSavedRef: { current: AppSettings | undefined },
	saveSettings: (
		settings: Partial<AppSettings>,
		baseline: AppSettings | undefined,
	) => unknown | Promise<unknown> = (settings) =>
		settingsSaveAck(settings).then((ack) => ack.settings),
	hooks?: ScheduledSaveHooks,
): Promise<void> {
	const s = latestSettingsRef.current;
	const patch = diffAgainstLastSaved(s, lastSavedRef.current);
	if (!hasAnyKey(patch)) {
		return;
	}
	if (isIpcLoadGuardActive(patch, lastSavedRef.current)) {
		// Audit #40: don't silently drop the save — let the caller re-arm it for
		// after the guard window so the edit isn't lost.
		hooks?.onGuardSuppressed?.();
		return;
	}
	try {
		const saved = await saveSettings(patch, lastSavedRef.current);
		const savedSnapshot =
			saved !== null && typeof saved === "object"
				? (saved as AppSettings)
				: undefined;
		// Audit #46: advance the baseline ONLY on a confirmed successful write.
		// A rejected save leaves `lastSavedRef` untouched, so the section stays
		// dirty and is re-diffed (re-sent) on the next change/flush.
		lastSavedRef.current = savedSnapshot ?? s;
		hooks?.onSaveSuccess?.();
	} catch (err) {
		hooks?.onSaveError?.(patch, err);
	}
}

/**
 * Cancel any pending debounced save AND immediately flush the latest settings
 * to persisted store. Used on window close / unmount so a fast-close doesn't
 * lose changes that hadn't been written yet. Also advances
 * `lastSavedRef` so a later broadcast merge still sees the flushed state as
 * the saved baseline.
 *
 * Audit #35: flush the latest diff REGARDLESS of whether a debounce timer is
 * live — a save the IPC-load guard suppressed (or one re-armed but not yet
 * fired) leaves no timer, yet still holds an unpersisted edit. Still RESPECT
 * the IPC-load guard so a transient boot-time revert isn't persisted on close.
 * Uses the fire-and-forget `settingsSave` (not the ack variant): during
 * `beforeunload`/unmount there's no opportunity to await a backend response.
 * A missing `lastSavedRef` means backend hydration has not established a
 * canonical baseline yet. This is the normal React StrictMode probe-unmount
 * case; flushing the localStorage tree there would post every section and can
 * overwrite newer backend settings.
 */
function flushPendingSave(
	debounceRef: { current: ReturnType<typeof setTimeout> | null },
	latestSettingsRef: { current: AppSettings },
	lastSavedRef: { current: AppSettings | undefined },
): void {
	if (debounceRef.current) {
		clearTimeout(debounceRef.current);
		debounceRef.current = null;
	}
	if (!lastSavedRef.current) {
		return;
	}
	const latest = latestSettingsRef.current;
	const patch = diffAgainstLastSaved(latest, lastSavedRef.current);
	if (!hasAnyKey(patch)) {
		return;
	}
	if (isIpcLoadGuardActive(patch, lastSavedRef.current)) {
		return;
	}
	settingsSave(patch);
	lastSavedRef.current = latest;
}
