import {
	EarIcon,
	ToggleOnIcon,
	TouchInteraction01Icon,
	VoiceIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { useTranslations } from "use-intl";
import type { useSettingsStore } from "@/entities/setting";
import type { CreatableComboboxItem } from "@/shared/ui/creatable-combobox";

// ── Local copies of the recording-mode + wake-word helpers ──
// These mirror src/widgets/general-settings/lib/general-settings-panel-test-helpers.ts.
// FSD forbids importing from another widget's slice, so the subset this panel
// needs (recording-mode options, wake-word grouping, recording-mode patch,
// wake-word sensitivity slider mapping) is copied verbatim here.

type GeneralT = ReturnType<typeof useTranslations<"general">>;
type GeneralSettings = NonNullable<
	ReturnType<typeof useSettingsStore.getState>["settings"]["general"]
>;

export function buildRecordingModeOptions(t: GeneralT): readonly {
	value: "ptt" | "toggle" | "listen" | "wakeword";
	label: string;
	icon: IconSvgElement;
	preview: "ptt" | "toggle" | "listen" | "wakeword";
}[] {
	// No per-option `color` — the recording-mode switcher uses the standard
	// muted surface theme (like every other Switcher: visualizer type, overlay
	// mode, aura shape). The four distinct icons (touch / toggle / ear / voice)
	// carry the per-mode differentiation instead of a bright accent fill.
	return [
		{
			value: "ptt",
			label: t("pushToTalk"),
			icon: TouchInteraction01Icon,
			preview: "ptt",
		},
		{
			value: "toggle",
			label: t("toggle"),
			icon: ToggleOnIcon,
			preview: "toggle",
		},
		{
			value: "listen",
			label: t("listen"),
			icon: EarIcon,
			preview: "listen",
		},
		{
			value: "wakeword",
			label: t("wakeWord"),
			icon: VoiceIcon,
			preview: "wakeword",
		},
	] as const;
}

const PORCUPINE_FREE_KEYWORDS = [
	"alexa",
	"americano",
	"blueberry",
	"bumblebee",
	"computer",
	"grapefruit",
	"grasshopper",
	"hey google",
	"hey siri",
	"jarvis",
	"ok google",
	"pico clock",
	"picovoice",
	"porcupine",
	"terminator",
] as const;

const OPENWAKEWORD_KEYWORDS = [
	"alexa",
	"hey_jarvis",
	"hey_mycroft",
	"hey_rhasspy",
	"timer",
	"weather",
] as const;

type WakeWordEngine = "porcupine" | "sherpa";

const PORCUPINE_KEYWORD_SET: ReadonlySet<string> = new Set<string>(
	PORCUPINE_FREE_KEYWORDS,
);
function engineForKeyword(word: string): WakeWordEngine {
	return PORCUPINE_KEYWORD_SET.has(word) ? "porcupine" : "sherpa";
}

function formatWakeWordLabel(word: string): string {
	return word.replace(/_/g, " ");
}

function buildUnifiedWakeWordList(): readonly string[] {
	const all = new Set<string>([
		...PORCUPINE_FREE_KEYWORDS,
		...OPENWAKEWORD_KEYWORDS,
	]);
	const sortKey = (w: string): number => {
		const engine = engineForKeyword(w);
		if (engine === "porcupine") {
			return 0;
		}
		return 1;
	};
	return [...all].toSorted(
		(a, b) => sortKey(a) - sortKey(b) || a.localeCompare(b),
	);
}

const ALL_WAKE_WORDS = buildUnifiedWakeWordList();
const CUSTOM_WAKE_WORD_PREFIX = "custom:";
const DEFAULT_WAKE_WORD = "alexa";

function isKnownWakeWord(word: string | undefined): word is string {
	return word !== undefined && ALL_WAKE_WORDS.includes(word);
}

export function normalizeWakeWordPhrase(value: string): string {
	return value
		.replace(/[_\s]+/g, " ")
		.trim()
		.toLowerCase();
}

export function presetIdForWakePhrase(value: string): string | undefined {
	const normalized = normalizeWakeWordPhrase(value);
	return ALL_WAKE_WORDS.find(
		(word) => word === normalized || formatWakeWordLabel(word) === normalized,
	);
}

function customWakeWordItemId(phrase: string): string {
	return `${CUSTOM_WAKE_WORD_PREFIX}${phrase}`;
}

export function wakeWordFromItemId(id: string): string {
	return id.startsWith(CUSTOM_WAKE_WORD_PREFIX)
		? id.slice(CUSTOM_WAKE_WORD_PREFIX.length)
		: id;
}

export function wakeWordValueToItemId(value: string | undefined): string {
	const word = reconcileWakeWord(value);
	return isKnownWakeWord(word) ? word : customWakeWordItemId(word);
}

export function reconcileCustomWakeWords(
	currentWakeWord: string | undefined,
	customWakeWords: readonly string[] = [],
): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of [...customWakeWords, currentWakeWord ?? ""]) {
		const phrase = normalizeWakeWordPhrase(raw);
		if (!phrase || presetIdForWakePhrase(phrase) || seen.has(phrase)) {
			continue;
		}
		seen.add(phrase);
		out.push(phrase);
	}
	return out;
}

export function buildWakeWordItems(
	customWakeWords: readonly string[],
	currentWakeWord: string | undefined,
): CreatableComboboxItem[] {
	const presets = ALL_WAKE_WORDS.map((word) => ({
		id: word,
		label: formatWakeWordLabel(word),
		meta: engineForKeyword(word) === "sherpa" ? "lower accuracy" : undefined,
	}));
	const custom = reconcileCustomWakeWords(currentWakeWord, customWakeWords).map(
		(phrase) => ({
			id: customWakeWordItemId(phrase),
			label: phrase,
			meta: "lower accuracy",
			deletable: true,
		}),
	);
	return [...presets, ...custom];
}

export function isLowerAccuracyWakeWord(value: string | undefined): boolean {
	const preset = presetIdForWakePhrase(value ?? "");
	return preset ? engineForKeyword(preset) === "sherpa" : true;
}

function reconcileWakeWord(currentWord: string | undefined): string {
	const raw = currentWord ?? "";
	const preset = presetIdForWakePhrase(raw);
	if (preset) {
		return preset;
	}
	const custom = normalizeWakeWordPhrase(raw);
	return custom.length > 0 ? custom : DEFAULT_WAKE_WORD;
}

function wakeWordPatch(
	currentWakeWord: string | undefined,
	reconciled: string,
): Partial<GeneralSettings> {
	return reconciled === currentWakeWord
		? { recordingMode: "wakeword" }
		: { recordingMode: "wakeword", wakeWord: reconciled };
}

export function recordingModePatch(
	value: "ptt" | "toggle" | "listen" | "wakeword",
	currentWakeWord: string | undefined,
): Partial<GeneralSettings> {
	return value === "wakeword"
		? wakeWordPatch(currentWakeWord, reconcileWakeWord(currentWakeWord))
		: { recordingMode: value };
}

export const SENSITIVITY_STEPS = 20;

export function sensitivityFromIndex(idx: number): number {
	return Math.round((idx / SENSITIVITY_STEPS) * 100) / 100;
}

export function sensitivityToIndex(value: number): number {
	return Math.round(value * SENSITIVITY_STEPS);
}
