import { useEffect, useRef, useState } from "react";
import { DEFAULT_SETTINGS, useSettingsStore } from "@/entities/setting";
import {
	type CloudTtsVoice,
	type CloudTtsVoiceCatalog,
	ttsCloudListVoices,
	ttsCloudSubscription,
} from "@/shared/api/ipc-client";
import type { SelectOptionGroup } from "@/shared/ui/searchable-select";
import type { SelectOption } from "@/shared/ui/select";

export interface UseCloudTtsVoices {
	/** True when the ElevenLabs character quota is spent (free OR paid) → cloud
	 *  TTS is disabled entirely until the monthly reset / a plan upgrade. */
	creditsExhausted: boolean;
	/** Classified, human-readable failure reason, or null when the fetch was fine. */
	error: string | null;
	/** Voices grouped by language for the SearchableSelect (one sticky header per language). */
	groups: SelectOptionGroup[];
	/** True while the live `/v2/voices` fetch is in flight. */
	isLoading: boolean;
	/** Voice ids locked to a paid plan — SHOWN and previewable, but not
	 *  selectable (a "Premium" badge links to upgrade). Locked unless the plan is
	 *  a CONFIRMED paid tier: free AND unknown (key lacks user-read scope) both
	 *  lock, so premium voices are always marked until we can prove access. */
	lockedVoiceIds: ReadonlySet<string>;
	/** Full live catalog — premium voices are shown (and previewable), just locked. */
	voices: CloudTtsVoice[];
}

// Only ElevenLabs' shipped "premade" voices are usable on every tier. Anything
// else — the account's own cloned / professional / generated voices (or any new
// category) — needs a paid plan and 402s on synthesis otherwise, so treat every
// non-premade voice as premium. Matches the user-facing "default voices vs
// everything else" split. `mapVoice` defaults a missing category to "premade",
// so a voice with no category stays free (not wrongly locked).
function needsSubscription(voice: CloudTtsVoice): boolean {
	return voice.category !== "premade";
}

// ElevenLabs voices whose `language` field is null/empty (the multilingual
// presets) collapse under one "Other" group so the picker never renders an
// empty/blank header — mirrors the local catalog's region grouping.
const OTHER_GROUP = "Other";

// Short uppercase badge shown on the group header and the closed trigger. The
// language field is an ISO-ish code ("en", "pt-br"); we surface the region/
// language segment uppercased, falling back to the whole code.
function languageBadge(language: string): string {
	if (language === OTHER_GROUP) {
		return "—";
	}
	return language.split("-").at(-1)?.toUpperCase() ?? language.toUpperCase();
}

// Group the live ElevenLabs voices by `language`, fallback bucket "Other" for
// voices that don't report one. Mirrors `buildVoiceGroups` for the local
// catalog: one sticky header per language, voices sorted alphabetically under
// it, and the groups themselves sorted by language code.
function buildCloudVoiceGroups(
	voices: readonly CloudTtsVoice[],
	lockedIds: ReadonlySet<string>
): SelectOptionGroup[] {
	const byLang = new Map<string, SelectOption[]>();
	for (const voice of voices) {
		const lang = voice.language?.trim() ? voice.language : OTHER_GROUP;
		const opts = byLang.get(lang) ?? [];
		// `disabled` is what makes a premium voice un-selectable at the picker
		// level (no select-then-revert); its preview button still works.
		opts.push({
			id: voice.id,
			label: voice.name,
			badge: languageBadge(lang),
			disabled: lockedIds.has(voice.id),
		});
		byLang.set(lang, opts);
	}
	return [...byLang.entries()]
		.sort(([a], [b]) => {
			// "Other" always sorts last so the named languages lead.
			if (a === OTHER_GROUP) {
				return b === OTHER_GROUP ? 0 : 1;
			}
			if (b === OTHER_GROUP) {
				return -1;
			}
			return a.localeCompare(b);
		})
		.map<SelectOptionGroup>(([code, opts]) => ({
			value: code,
			label: code,
			badge: languageBadge(code),
			options: opts.toSorted((x, y) => x.label.localeCompare(y.label)),
		}));
}

/**
 * Fetches the live ElevenLabs voice catalog when cloud TTS is the active
 * source AND the key is verified. The IPC layer caches the result on the main
 * side so re-enabling cloud is cheap. Disabled (local source or unverified
 * key) means no fetch — the returned state stays empty.
 *
 * Mirrors `TtsModelSection`'s local stale-voice fallback: whenever the
 * persisted `tts.cloud.voice` isn't one of the fetched voices, the first voice
 * is auto-selected so synthesis always targets a voice the account offers.
 * Latest-value refs keep the effect's dep array at `[enabled]` without tripping
 * exhaustive-deps (the `.then()` callback reads the freshest voice/update).
 */
export function useCloudTtsVoices(enabled: boolean): UseCloudTtsVoices {
	// `tts.cloud` is `.prefault({})` so it's always present after parse, but the
	// selector type still admits `undefined` (pre-hydration); fall back to the
	// schema default so the spread always carries every required field.
	const cloud = useSettingsStore((s) => s.settings.tts?.cloud ?? DEFAULT_SETTINGS.tts.cloud);
	const cloudVoice = cloud.voice;
	const update = useSettingsStore((s) => s.updateTtsSettings);

	const [catalog, setCatalog] = useState<CloudTtsVoiceCatalog>({ voices: [], error: null });
	// ElevenLabs plan name (null = unknown / not yet fetched, or the key lacks
	// user-read scope). A "free" tier hides cloned/professional voices.
	const [tier, setTier] = useState<string | null>(null);
	// Monthly character quota spent (free OR paid) → cloud TTS disabled entirely.
	const [creditsExhausted, setCreditsExhausted] = useState(false);
	// Seed from `enabled` so a key that's already verified at mount starts in the
	// loading state — the caller treats "loading" as optimistically cloud-capable,
	// which avoids a one-frame Cloud→Local flip before the catalog fetch resolves.
	const [isLoading, setIsLoading] = useState(enabled);

	// Latest-value refs for the on-enable fetch. We only want the fetch to run
	// when `enabled` flips, but the `.then()` callback needs the freshest
	// `voice` / `cloud` / `update` to apply the stale-voice fallback. Reading
	// them through a ref keeps the dependency array down to `[enabled]`. Refs
	// are written in an effect (NOT during render) to comply with React's
	// no-side-effects-in-render rule.
	const voiceRef = useRef(cloudVoice);
	const cloudRef = useRef(cloud);
	const updateRef = useRef(update);
	useEffect(() => {
		voiceRef.current = cloudVoice;
		cloudRef.current = cloud;
		updateRef.current = update;
	});

	// Fetch the voice catalog whenever cloud becomes active + verified. Folded
	// the stale-voice fallback INTO the same `.then()` so we don't need a second
	// effect reacting to `catalog.voices` (which would be a no-event-handler
	// "react to a fetch result with a setState" finding).
	useEffect(() => {
		if (!enabled) {
			return;
		}
		let cancelled = false;
		setIsLoading(true);
		Promise.all([ttsCloudListVoices(), ttsCloudSubscription()])
			.then(([result, subscription]) => {
				if (cancelled) {
					return;
				}
				setCatalog(result);
				setTier(subscription.tier);
				setCreditsExhausted(subscription.creditsExhausted);
				// Steer the stale-voice fallback to a usable voice unless the plan is a
				// CONFIRMED paid tier (free OR unknown both avoid premium voices).
				const paid = subscription.tier !== null && subscription.tier !== "free";
				const usable = paid ? result.voices : result.voices.filter((v) => !needsSubscription(v));
				if (usable.length === 0) {
					return;
				}
				const currentVoice = voiceRef.current;
				if (usable.some((v) => v.id === currentVoice)) {
					return;
				}
				const first = usable[0];
				if (first) {
					updateRef.current({ cloud: { ...cloudRef.current, voice: first.id } });
				}
			})
			.finally(() => {
				if (!cancelled) {
					setIsLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [enabled]);

	// Lock premium voices unless the plan is a CONFIRMED paid tier. Free OR
	// unknown (key lacks user-read scope → tier null) both lock, so a premium
	// voice is always badged + unselectable until we can prove the plan covers it
	// — only a known paid tier unlocks. Selection is blocked at the picker via
	// `option.disabled`; the preview still works.
	const hasPaidPlan = tier !== null && tier !== "free";
	const lockedVoiceIds: ReadonlySet<string> = new Set(
		hasPaidPlan ? [] : catalog.voices.filter(needsSubscription).map((v) => v.id)
	);

	return {
		voices: catalog.voices,
		groups: buildCloudVoiceGroups(catalog.voices, lockedVoiceIds),
		isLoading,
		lockedVoiceIds,
		creditsExhausted,
		error: catalog.error,
	};
}
