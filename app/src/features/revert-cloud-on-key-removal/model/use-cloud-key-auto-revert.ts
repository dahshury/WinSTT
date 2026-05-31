import { useEffect, useRef } from "react";
import { providerOf } from "@/entities/cloud-stt-provider";
import { useCatalogStore, useModelStateStore, useModelSwapStore } from "@/entities/model-catalog";
import { useSettingsStore } from "@/entities/setting";
import { sttReloadModel } from "@/shared/api/ipc-client";
import {
	affectedProviders,
	type ClearableProvider,
	detectClearedKeys,
	type KeySnapshot,
	planHasWork,
	planReverts,
	type RevertPlan,
	resolveLocalSttTarget,
} from "./cloud-revert-decision";
import { useRevertNoticeStore } from "./revert-notice-store";

/** Debounce after the last key/surface change before evaluating a revert.
 *  The key fields persist on every keystroke, so without this a key being
 *  replaced (cleared then retyped) would momentarily look "removed" and wrongly
 *  revert. Long enough to outlast a paste/retype, short enough to feel
 *  immediate. */
const REVERT_DEBOUNCE_MS = 600;

/**
 * Swap the main STT slot from a now-keyless cloud model back to a local one.
 * Reuses the swap primitives the picker uses (`applyMainSwap` + `maybeHotReload`
 * in `use-model-swap-controller.ts`): open the in-flight chip, write the
 * `{ model, backend }` pair, then fire the server reload. A bare settings write
 * would NOT reload the server — `sync-actions.ts` deliberately skips
 * `model.model`, leaving the reload to `sttReloadModel`.
 */
function revertSttToLocal(currentCloudModel: string): void {
	const { models } = useCatalogStore.getState();
	const { statesById } = useModelStateStore.getState();
	const target = resolveLocalSttTarget(models, statesById);
	useModelSwapStore.getState().beginSwap("main", currentCloudModel, target.model);
	useSettingsStore.getState().updateModelSettings({ model: target.model, backend: target.backend });
	sttReloadModel("main", target.model);
}

/** Apply every surface revert the plan calls for. */
function applyPlan(plan: RevertPlan, currentModel: string): void {
	const store = useSettingsStore.getState();
	if (plan.stt) {
		revertSttToLocal(currentModel);
	}
	if (plan.llmDictation) {
		store.updateLlmDictation({ provider: "ollama", enabled: false });
	}
	if (plan.llmTransforms) {
		store.updateLlmTransforms({ provider: "ollama", enabled: false });
	}
	if (plan.ttsCloud) {
		store.updateTtsSettings({ source: "local" });
	}
}

/** Surface one toast per provider that actually had a surface reverted. */
function notify(providers: ReadonlySet<ClearableProvider>): void {
	const push = useRevertNoticeStore.getState().push;
	for (const provider of providers) {
		push(provider);
	}
}

/**
 * Evaluate the settled key snapshot and apply any revert. Split out of the
 * effect so the debounce timer body stays readable.
 *
 * Two passes:
 *   1. Transition-driven (a key just went non-empty → empty): revert the
 *      affected surfaces AND surface a toast — this is the user's explicit
 *      "I removed the key" action.
 *   2. Steady-state safety net: a persisted/imported cloud STT model whose
 *      provider has no key is unusable but produces no transition. Repair it
 *      silently (no toast) so the app never boots into a dead cloud model.
 */
function evaluateRevert(
	prevKeys: KeySnapshot,
	next: KeySnapshot,
	surfaces: {
		dictationProvider: string;
		model: string;
		transformsProvider: string;
		ttsSource: string;
	}
): void {
	const plan = planReverts(detectClearedKeys(prevKeys, next), surfaces);
	if (planHasWork(plan)) {
		applyPlan(plan, surfaces.model);
		notify(affectedProviders(plan, surfaces.model));
		return;
	}
	const activeProvider = providerOf(surfaces.model);
	if (activeProvider !== null && next[activeProvider].trim() === "") {
		revertSttToLocal(surfaces.model);
	}
}

/**
 * Watch the three cloud API keys and, when one is removed (non-empty → empty)
 * while a surface is actively using that provider, revert that surface to its
 * local engine: cloud STT model → smallest local model, LLM dictation/transforms
 * on OpenRouter → Ollama + disabled, cloud TTS → local Kokoro.
 *
 * Mounted ONCE in the **settings window** (`SettingsPage`) — the only window
 * where keys are edited. Running the revert in the same window as the edit is
 * load-bearing: the OpenRouter key and the LLM provider/enabled flags share the
 * top-level `llm` settings section, and the cross-window `settings:changed`
 * merge (`mergeBroadcastPreservingUserDirty`) keeps the editing window's
 * user-dirty `llm` section — so a revert issued from another window would be
 * rejected. A same-window store write has no such race and the panel reflects it
 * immediately. STT/TTS reverts touch a different section than their key, so they
 * were unaffected, but co-locating all three keeps the model consistent.
 *
 * `debounceMs` is injectable for tests; production uses the default.
 */
export function useCloudKeyAutoRevert(debounceMs: number = REVERT_DEBOUNCE_MS): void {
	const openaiKey = useSettingsStore((s) => s.settings.integrations.openai.apiKey);
	const elevenlabsKey = useSettingsStore((s) => s.settings.integrations.elevenlabs.apiKey);
	const openrouterKey = useSettingsStore((s) => s.settings.llm.openrouterApiKey);
	const model = useSettingsStore((s) => s.settings.model?.model ?? "");
	const dictationProvider = useSettingsStore((s) => s.settings.llm.dictation.provider);
	const transformsProvider = useSettingsStore((s) => s.settings.llm.transforms.provider);
	const ttsSource = useSettingsStore((s) => s.settings.tts.source);

	// Seeded with the boot values so the first settle sees no transition.
	const prevKeysRef = useRef<KeySnapshot>({
		openai: openaiKey,
		elevenlabs: elevenlabsKey,
		openrouter: openrouterKey,
	});
	const timerRef = useRef<number | null>(null);

	useEffect(() => {
		// Restart the debounce on every change so only the SETTLED value is acted
		// on (a clear-then-retype never reaches the timer body while empty).
		if (timerRef.current !== null) {
			window.clearTimeout(timerRef.current);
		}
		timerRef.current = window.setTimeout(() => {
			timerRef.current = null;
			// Closed-over values are the latest: any change reset this timer with a
			// fresh closure, so when it fires nothing newer is pending.
			const next: KeySnapshot = {
				openai: openaiKey,
				elevenlabs: elevenlabsKey,
				openrouter: openrouterKey,
			};
			const prev = prevKeysRef.current;
			prevKeysRef.current = next;
			evaluateRevert(prev, next, { model, dictationProvider, transformsProvider, ttsSource });
		}, debounceMs);
		return () => {
			if (timerRef.current !== null) {
				window.clearTimeout(timerRef.current);
			}
		};
	}, [
		openaiKey,
		elevenlabsKey,
		openrouterKey,
		model,
		dictationProvider,
		transformsProvider,
		ttsSource,
		debounceMs,
	]);
}
