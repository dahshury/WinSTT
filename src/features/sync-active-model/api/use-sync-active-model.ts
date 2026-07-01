import { useEffect, useRef } from "react";
import { providerOf } from "@/entities/cloud-stt-provider";
import { useConnectionStore } from "@/entities/connection";
import {
	type ModelInfo,
	useCatalogStore,
	useModelSwapStore,
} from "@/entities/model-catalog";
import { type ModelPatch, useSettingsStore } from "@/entities/setting";
import {
	type ModelSwapKind,
	onModelSwapCompleted,
} from "@/shared/api/ipc-client";
import type { TranscriberBackend } from "@/shared/api/schema.zod";
import { recentIpcLoadAt } from "@/shared/lib/ipc-load-timing";
import { recentSwapFailedAt } from "@/shared/lib/swap-failure-timing";

// Cloud transcribers (``provider:model``) aren't catalog entries, so they carry
// no backend; the server routes them by the ``provider:`` prefix. The typed
// ``ModelPatch`` still requires a backend whenever ``model`` is set, so persist
// a benign valid value (mirrors ``CLOUD_MODEL_BACKEND`` in apply-swap.ts).
const CLOUD_MODEL_BACKEND: TranscriberBackend = "onnx_asr";

// How long after an IPC settingsLoad we consider a settings.model transition
// as "load-induced" (not a user pick). Crash + state-revert investigation
// showed the death-spiral pattern: localStorage hydrates with stale model,
// runtime adoption fixes it, settingsLoad's setSettings(loaded) reverts the
// renderer back to the disk value, which fires this hook's beginSwap with a
// "wrong" destination — activeMain gets stuck on the stale value and the
// shouldAdoptRuntimeModel branch is blocked from re-correcting because
// activeMain != null. 500 ms covers the worst-case window from settingsLoad
// resolution through every dependent effect re-render under StrictMode
// double-mount; longer than typical user-pick reaction time so no real
// user action gets skipped.
const IPC_LOAD_GUARD_WINDOW_MS = 500;

// How long after a `model_swap_failed` we treat the next settings.model
// transition as a failure-induced ROLLBACK (revert to the previous model)
// rather than a user pick. The rollback flips settings B → A while
// runtimeInfo.model can still be the stale B, which would otherwise make the
// transition guard fire `beginSwap("main", B, A)` — a reversed, never-
// completing "switch to the already-loaded model" that strands the chip on
// "B → A" forever (the user-reported "first click spins backwards" bug). No
// real reload is in flight for a rollback, so the implicit beginSwap must be
// skipped. Same generous window as the IPC-load guard — covers the failure →
// restore → runtime_info → rollback-setSettings re-render chain.
const SWAP_FAILURE_GUARD_WINDOW_MS = 500;

/**
 * Reconcile the locally-persisted ``settings.model.model`` with the server's
 * actually-loaded model name.
 *
 * On startup, the server may fall back to a different model than the one
 * persisted in the renderer's settings (e.g. the user's chosen model is
 * corrupted on disk and can't be refetched). The server signals this via:
 *
 *   1. ``runtime_info.model`` on ``server_ready`` — the truth about what's
 *      actually loaded.
 *   2. ``model_swap_failed`` — fires the existing :file:`SwapFailureToast`
 *      so the user sees a clear "swap failed" notification.
 *
 * This hook drives the first half: when the server's runtime snapshot
 * disagrees with our local setting, push the server's choice into settings.
 * That:
 *
 *   - flips the picker to the actually-active model so the user isn't
 *     looking at a lie,
 *   - persists the fallback to persisted store so the next launch starts
 *     where this one ended up (matching the server-side persist),
 *   - keeps the in-window UI in sync between restarts.
 *
 * Fires on a fresh ``runtime_info`` push from the server **and** on
 * ``settings.model`` changes — the latter so that an async
 * ``settingsLoad()`` in ``useSyncSettings`` (which replaces the whole
 * settings object from persisted store after the renderer mounts) can't
 * silently revert a reconciliation that already happened. Without
 * ``settingsModel`` in deps, the race is: runtime_info arrives → we write
 * "tiny" → settingsLoad resolves later → setSettings overwrites with the
 * stored "nemo-canary-1b-v2" → nothing in our deps changed → picker stays
 * on canary even though the server is running tiny.
 *
 * Regression guard: when the user picks a new model in the picker, the
 * picker first writes ``settings.model`` and then ``beginSwap`` sets
 * ``activeMain``. Both are synchronous, so by the time this effect
 * runs both stores have already committed and the ``activeMain !== null``
 * check below short-circuits — preventing the revert-to-lagging-runtime
 * regression that earlier versions of this hook hit. ``activeMain`` is
 * intentionally read via ``getState()`` (not subscribed) so its
 * ``true → false`` transition on ``model_swap_completed`` does NOT
 * re-fire the effect against still-stale ``runtimeModel``.
 */
/** True when the server is the authoritative reporter of model state. */
function serverIsAuthoritative(
	isLoaded: boolean,
	serverStatus: string,
	runtimeModel: string | null,
): runtimeModel is string {
	return isLoaded && serverStatus === "running" && runtimeModel !== null;
}

/** True when no main swap is in flight and runtime differs from settings. */
function reconciliationWouldChangeSettings(
	runtimeModel: string,
	settingsModel: string | null,
	activeMain: string | null,
): boolean {
	return activeMain === null && runtimeModel !== settingsModel;
}

/**
 * True only when the renderer should adopt the server's runtime-reported
 * model. Composed from two narrow predicates so each stays low-CC and the
 * rule is reusable in tests.
 *
 * Reads ``activeMain`` from the swap store via getState() rather than a
 * subscription so the cleared-on-completion transition does NOT re-fire
 * the effect against a still-stale ``runtimeModel`` push.
 */
function shouldAdoptRuntimeModel(
	isLoaded: boolean,
	serverStatus: string,
	runtimeModel: string | null,
	settingsModel: string | null,
	activeMain: string | null,
): runtimeModel is string {
	if (!serverIsAuthoritative(isLoaded, serverStatus, runtimeModel)) {
		return false;
	}
	return reconciliationWouldChangeSettings(
		runtimeModel,
		settingsModel,
		activeMain,
	);
}

export interface ImplicitSwapInputs {
	/** Timestamps from the two timing guards (``recentIpcLoadAt`` /
	 *  ``recentSwapFailedAt``). */
	lastIpcLoadAt: number;
	lastSwapFailedAt: number;
	/** ``Date.now()`` at decision time. */
	now: number;
	/** ``settings.model`` observed on the previous effect run (the ``from`` leg).
	 *  ``undefined`` on the very first run — no transition to interpret yet. */
	previousModel: string | null | undefined;
	/** Server's actually-loaded model. A transition whose target already
	 *  equals this isn't a real swap. */
	runtimeModel: string | null;
	/** Current ``settings.model`` (the candidate ``to`` leg). */
	settingsModel: string | null;
}

/**
 * Whether a ``settings.model`` transition should be treated as a *real* user
 * swap and open the in-flight chip via ``beginSwap``. Pure so it can be unit
 * tested without standing up the render + IPC machinery.
 *
 * Suppressed when the transition is:
 *   - the first observation (no ``from`` yet),
 *   - a no-op (``from === to``),
 *   - load-induced (a ``settingsLoad`` revert — see ipc-load-timing),
 *   - rollback-induced (a ``model_swap_failed`` revert — see
 *     swap-failure-timing; this is the fix for the reversed "B → A" chip that
 *     spun forever after a failed first swap),
 *   - or a transition to the already-loaded runtime model (not a swap).
 */
export function shouldOpenImplicitSwap(inputs: ImplicitSwapInputs): boolean {
	const { previousModel, settingsModel, runtimeModel, now } = inputs;
	if (
		previousModel === undefined ||
		previousModel === settingsModel ||
		!settingsModel
	) {
		return false;
	}
	if (now - inputs.lastIpcLoadAt < IPC_LOAD_GUARD_WINDOW_MS) {
		return false;
	}
	if (now - inputs.lastSwapFailedAt < SWAP_FAILURE_GUARD_WINDOW_MS) {
		return false;
	}
	return settingsModel !== runtimeModel;
}

/**
 * Build the ``ModelPatch`` that adopts a just-completed swap's model into
 * settings, or ``null`` when nothing should change.
 *
 * This is the fix for the "all surfaces stuck on the previous model after a
 * detached-picker swap" bug. The detached picker window commits the pick on
 * its OWN stores and closes the instant the swap starts — so its debounced
 * ``settings:changed`` broadcast is raced/lost and the other windows never
 * learn the new ``settings.model``. They DO receive the global
 * ``model-swap-completed`` event (``app.emit`` reaches every window) which
 * carries the authoritative loaded model ``name`` — but the runtime-info
 * reconciler below can't act on it: it reads ``activeMain`` via ``getState()``
 * (not a dependency) precisely so it never re-fires on the ``true → false``
 * clear transition, so the adoption that should flip the picker to the new
 * model never runs. Driving the adoption straight off the completion event
 * makes every window converge on the loaded model deterministically.
 *
 * - No-op when the slot already shows ``name`` (the initiating window).
 * - No-op for an empty ``name`` (e.g. a realtime clear — handled by the
 *   normal broadcast path; we never write a bare ``{ model }`` couple).
 * - Main picks resolve their paired ``backend`` from the catalog (cloud ids
 *   have no entry → the benign cloud backend); a genuinely-unknown local id
 *   yields ``null`` rather than an inconsistent ``{ model }``-without-backend.
 */
export function resolveSwapCompletedPatch(
	kind: ModelSwapKind,
	name: string,
	settingsModel: string | null,
	settingsRealtimeModel: string | null,
	catalogModels: readonly ModelInfo[],
): ModelPatch | null {
	if (!name) {
		return null;
	}
	if (kind === "realtime") {
		return name === settingsRealtimeModel ? null : { realtimeModel: name };
	}
	if (name === settingsModel) {
		return null;
	}
	const catalogEntry = catalogModels.find((m) => m.id === name);
	if (catalogEntry?.backend) {
		return {
			model: name,
			backend: catalogEntry.backend as TranscriberBackend,
		};
	}
	if (providerOf(name) !== null) {
		return { model: name, backend: CLOUD_MODEL_BACKEND };
	}
	return null;
}

/**
 * Side-effecting half of the completion adoption: read the live settings +
 * catalog stores, compute the patch via {@link resolveSwapCompletedPatch}, and
 * commit it. Split out from the subscription so it can be unit-tested directly
 * (no renderer/IPC machinery) and so the effect stays a one-line forwarder.
 */
export function adoptCompletedSwap(kind: ModelSwapKind, name: string): void {
	const store = useSettingsStore.getState();
	const patch = resolveSwapCompletedPatch(
		kind,
		name,
		store.settings.model?.model ?? null,
		store.settings.model?.realtimeModel ?? null,
		useCatalogStore.getState().models,
	);
	if (patch !== null) {
		store.updateModelSettings(patch);
	}
}

export function useSyncActiveModel(): void {
	const serverStatus = useConnectionStore((s) => s.serverStatus);
	const runtimeModel = useConnectionStore((s) => s.runtimeInfo?.model ?? null);
	const isLoaded = useSettingsStore((s) => s.isLoaded);
	const settingsModel = useSettingsStore(
		(s) => s.settings.model?.model ?? null,
	);
	const updateModelSettings = useSettingsStore((s) => s.updateModelSettings);

	// Tracks the previously-observed settings.model so we can distinguish
	// "initial mount value" from "subsequent change". `undefined` is the
	// sentinel for "first observation" — only after the first effect run
	// is the ref populated, so a same-launch settings.model change can be
	// detected as such.
	const prevSettingsModelRef = useRef<string | null | undefined>(undefined);

	useEffect(() => {
		// Cross-window swap-pending guard. When the user picks a new model in
		// ANOTHER window (e.g. the detached settings panel), this window
		// receives the change via the `settings:changed` broadcast — but the
		// local `useModelSwapStore.activeMain` is null (`beginSwap` was only
		// called synchronously in the source window's swap controller, see
		// `use-model-swap-controller.ts::applyMainSwap`). Without the branch
		// below, the next render sees `settings.model != runtime.model` and
		// `activeMain == null`, trips `shouldAdoptRuntimeModel`, and reverts
		// the picker back to whatever the server is still loading. The
		// visible symptom is the "main-window picker stays on the old model
		// after a settings pick" desync (user reported on a canary pick).
		//
		// We treat any cross-render change to `settings.model` (after the
		// first observation) as an implicit `beginSwap` on this window's
		// swap store. The server will subsequently emit `model_swap_started`
		// (which the module-level listener in model-swap-store.ts pins via
		// `setActive`) and finally `model_swap_completed` (which clears it).
		// Initial mount — where the ref is still `undefined` — is
		// intentionally NOT treated as a swap; the reconciliation below
		// handles the cold-boot fallback case the original comment block
		// documents.
		const previousModel = prevSettingsModelRef.current;
		const activeMain = useModelSwapStore.getState().activeMain;
		if (
			shouldOpenImplicitSwap({
				previousModel,
				settingsModel,
				runtimeModel,
				now: Date.now(),
				lastIpcLoadAt: recentIpcLoadAt(),
				lastSwapFailedAt: recentSwapFailedAt(),
			})
		) {
			useModelSwapStore
				.getState()
				.beginSwap("main", previousModel ?? "", settingsModel ?? "");
		}
		prevSettingsModelRef.current = settingsModel;

		if (
			shouldAdoptRuntimeModel(
				isLoaded,
				serverStatus,
				runtimeModel,
				settingsModel,
				activeMain,
			)
		) {
			// Look up the runtime model in the catalog so we can also patch
			// `model.backend` to match. Without this, adoptRuntime only fixes
			// `model.model` and leaves `model.backend` at whatever stale
			// localStorage / schema-default value the renderer hydrated with
			// (typically "faster_whisper"). The next disk save then writes
			// {model: canary, backend: faster_whisper} — and the NEXT
			// server spawn reads back that wrong pairing, passing
			// `--backend faster_whisper` for a model whose native engine is
			// onnx_asr. Server tolerates the mismatch but the picker shows
			// confusing inconsistencies and any backend-conditional code
			// downstream (quantization eligibility, fp16 promotion, …)
			// reads the wrong answer.
			const catalogEntry = useCatalogStore
				.getState()
				.models.find((m) => m.id === runtimeModel);
			if (catalogEntry?.backend) {
				updateModelSettings({
					model: runtimeModel,
					backend: catalogEntry.backend as TranscriberBackend,
				});
			}
			// If we can't resolve the runtime model in the catalog we deliberately
			// SKIP the adoption — patching `{ model }` without a paired backend is
			// the exact drift the typed ``ModelPatch`` now forbids. The picker's
			// fallback effect will pick a valid model once the catalog refreshes.
		}
	}, [
		isLoaded,
		serverStatus,
		runtimeModel,
		settingsModel,
		updateModelSettings,
	]);

	// Authoritative post-swap adoption. ``model-swap-completed`` is broadcast to
	// EVERY window with the loaded model ``name``; adopt it into settings so all
	// surfaces (footer chip, settings trigger, detached picker) converge on the
	// new model even when the initiating detached picker closed before its
	// ``settings:changed`` broadcast landed. ``adoptCompletedSwap`` reads stores
	// via ``getState()`` so the subscription is install-once (no stale-closure
	// deps). See ``resolveSwapCompletedPatch`` for the full rationale.
	useEffect(
		() =>
			onModelSwapCompleted(({ kind, name }) => adoptCompletedSwap(kind, name)),
		[],
	);
}
