import { DEFAULT_SETTINGS } from "@/entities/setting";
import type { TtsVoiceCatalog } from "@/shared/api/ipc-client";
import {
	SUPERTONIC_TTS_MODEL_ID,
	ttsSpeedRange,
} from "@/shared/config/tts-speed";
import type { SelectOptionGroup } from "@/shared/ui/searchable-select";
import type { SelectOption } from "@/shared/ui/select";
import { regionBadge, stripRegionSuffix } from "./voice-demo-text";

export const SUPERTONIC_MODEL_ID = SUPERTONIC_TTS_MODEL_ID;
export const SUPERTONIC_DEFAULT_LANG = "en";
// Slider bounds come from the shared per-model speed source (mirrored by the
// `supertonic.rs` clamp). Supertonic caps the speed-UP at its officially
// supported 1.5× — past that the diffusion vocoder truncates words instead of
// speaking faster — while the slow end stays wide (0.4) since stretching is fine.
const SUPERTONIC_SPEED_RANGE = ttsSpeedRange(SUPERTONIC_MODEL_ID);
export const SUPERTONIC_SPEED_MIN = SUPERTONIC_SPEED_RANGE.min;
export const SUPERTONIC_SPEED_MAX = SUPERTONIC_SPEED_RANGE.max;

// Group the 54 voices by country (their language/locale) so the picker reads
// like the STT model selector — one sticky header per country, voices nested
// under it. Group order follows the catalog's own language ordering; voices
// whose language isn't listed there sort last, then alphabetically by code.
export function buildVoiceGroups(
	catalog: TtsVoiceCatalog,
): SelectOptionGroup[] {
	const order = new Map(catalog.languages.map((l, i) => [l.code, i]));
	const labelFor = new Map(catalog.languages.map((l) => [l.code, l.label]));
	const byLang = new Map<string, SelectOption[]>();
	for (const voice of catalog.voices) {
		const opts = byLang.get(voice.language) ?? [];
		opts.push({
			id: voice.id,
			label: stripRegionSuffix(voice.label),
			badge: regionBadge(voice.language),
		});
		byLang.set(voice.language, opts);
	}
	const LAST = Number.MAX_SAFE_INTEGER;
	return [...byLang.entries()]
		.toSorted(([a], [b]) => {
			const ai = order.get(a) ?? LAST;
			const bi = order.get(b) ?? LAST;
			return ai === bi ? a.localeCompare(b) : ai - bi;
		})
		.map<SelectOptionGroup>(([code, opts]) => ({
			value: code,
			label: labelFor.get(code) ?? code,
			badge: regionBadge(code),
			options: opts.toSorted((x, y) => x.label.localeCompare(y.label)),
		}));
}

export function buildStyleVoiceGroups(
	catalog: TtsVoiceCatalog,
): SelectOptionGroup[] {
	return [
		{
			value: "supertonic-style",
			label: "Voice styles",
			options: catalog.voices.map((voice) => ({
				id: voice.id,
				label: voice.label,
				badge: voice.gender === "male" ? "M" : "F",
			})),
		},
	];
}

export function buildLanguageGroups(
	catalog: TtsVoiceCatalog,
	label: string,
): SelectOptionGroup[] {
	return [
		{
			value: "supertonic-language",
			label,
			options: catalog.languages.map((language) => ({
				id: language.code,
				label: language.label,
				badge: regionBadge(language.code),
			})),
		},
	];
}

export function resolveSupertonicLanguage(
	lang: string,
	catalog: TtsVoiceCatalog,
): string {
	const available = new Set(catalog.languages.map((language) => language.code));
	const normalized = lang.trim().toLowerCase().replaceAll("_", "-");
	if (available.has(normalized)) {
		return normalized;
	}
	const prefix = normalized.split("-")[0] ?? "";
	if (available.has(prefix)) {
		return prefix;
	}
	return available.has(SUPERTONIC_DEFAULT_LANG)
		? SUPERTONIC_DEFAULT_LANG
		: (catalog.languages[0]?.code ?? SUPERTONIC_DEFAULT_LANG);
}

export function clampSupertonicSpeed(speed: number): number {
	if (!Number.isFinite(speed)) {
		return DEFAULT_SETTINGS.tts.speed;
	}
	return Math.min(SUPERTONIC_SPEED_MAX, Math.max(SUPERTONIC_SPEED_MIN, speed));
}

// A cloning engine no longer selects its voice through this dropdown: the
// reference clips live in the voice card (`VoiceField`), which also hosts the
// engine's preset voices. `buildCloningVoiceGroups` / `TTS_CLONE_ADD`
// were removed with it — a sentinel option that opened a file dialog is not a
// voice, and hiding the upload inside a select made drag-and-drop impossible.
