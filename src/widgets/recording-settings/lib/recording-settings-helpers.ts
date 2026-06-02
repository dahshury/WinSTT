import {
	AudioWave02Icon,
	EarIcon,
	ToggleOnIcon,
	TouchInteraction01Icon,
	VoiceIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { useTranslations } from "use-intl";
import type { useSettingsStore } from "@/entities/setting";
import type { SelectOption, SelectOptionGroup } from "@/shared/ui/select";

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

type WakeWordEngine = "porcupine" | "openwakeword" | "composite";

const PORCUPINE_KEYWORD_SET: ReadonlySet<string> = new Set<string>(PORCUPINE_FREE_KEYWORDS);
const OPENWAKEWORD_KEYWORD_SET: ReadonlySet<string> = new Set<string>(OPENWAKEWORD_KEYWORDS);

function classifyEngine(inPorc: boolean, inOww: boolean): WakeWordEngine {
	const key = `${inPorc ? "1" : "0"}${inOww ? "1" : "0"}` as "00" | "01" | "10" | "11";
	const table: Record<"00" | "01" | "10" | "11", WakeWordEngine> = {
		"00": "porcupine",
		"01": "openwakeword",
		"10": "porcupine",
		"11": "composite",
	};
	return table[key];
}

function engineForKeyword(word: string): WakeWordEngine {
	return classifyEngine(PORCUPINE_KEYWORD_SET.has(word), OPENWAKEWORD_KEYWORD_SET.has(word));
}

function formatWakeWordLabel(word: string): string {
	return word.replace(/_/g, " ");
}

function buildUnifiedWakeWordList(): readonly string[] {
	const all = new Set<string>([...PORCUPINE_FREE_KEYWORDS, ...OPENWAKEWORD_KEYWORDS]);
	const sortKey = (w: string): number => {
		const engine = engineForKeyword(w);
		if (engine === "composite") {
			return 0;
		}
		if (engine === "porcupine") {
			return 1;
		}
		return 2;
	};
	return [...all].toSorted((a, b) => sortKey(a) - sortKey(b) || a.localeCompare(b));
}

const ALL_WAKE_WORDS = buildUnifiedWakeWordList();
export const DEFAULT_WAKE_WORD = "alexa";

function engineBadge(engine: WakeWordEngine): string {
	if (engine === "composite") {
		return "2x";
	}
	if (engine === "openwakeword") {
		return "OWW";
	}
	return "PVP";
}

// Section order for the grouped wake-word picker — composite keywords first
// (they run on both engines), then the single-engine sets, matching the old
// flat sort. Human-readable headers carry the engine; the engine *badge*
// (2x / PVP / OWW) rides on the header so the per-row badge is dropped (each
// row just shows the keyword + a wave icon).
const WAKE_WORD_ENGINE_ORDER: readonly WakeWordEngine[] = [
	"composite",
	"porcupine",
	"openwakeword",
];

const WAKE_WORD_ENGINE_LABEL: Record<WakeWordEngine, string> = {
	composite: "Composite",
	openwakeword: "openWakeWord",
	porcupine: "Porcupine",
};

export function buildWakeWordGroups(): SelectOptionGroup[] {
	const byEngine = new Map<WakeWordEngine, SelectOption[]>();
	for (const word of ALL_WAKE_WORDS) {
		const engine = engineForKeyword(word);
		const list = byEngine.get(engine) ?? [];
		list.push({ id: word, label: formatWakeWordLabel(word), icon: AudioWave02Icon });
		byEngine.set(engine, list);
	}
	return WAKE_WORD_ENGINE_ORDER.flatMap((engine) => {
		const options = byEngine.get(engine);
		return options && options.length > 0
			? [
					{
						value: engine,
						label: WAKE_WORD_ENGINE_LABEL[engine],
						badge: engineBadge(engine),
						options,
					},
				]
			: [];
	});
}

function isKnownWakeWord(word: string | undefined): word is string {
	return word !== undefined && ALL_WAKE_WORDS.includes(word);
}

function reconcileWakeWord(currentWord: string | undefined): string {
	return isKnownWakeWord(currentWord) ? currentWord : DEFAULT_WAKE_WORD;
}

function wakeWordPatch(
	currentWakeWord: string | undefined,
	reconciled: string
): Partial<GeneralSettings> {
	return reconciled === currentWakeWord
		? { recordingMode: "wakeword" }
		: { recordingMode: "wakeword", wakeWord: reconciled };
}

export function recordingModePatch(
	value: "ptt" | "toggle" | "listen" | "wakeword",
	currentWakeWord: string | undefined
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
