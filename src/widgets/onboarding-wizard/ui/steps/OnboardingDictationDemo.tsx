import { Mic01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	type ChangeEvent,
	type ReactNode,
	useEffect,
	useReducer,
	useRef,
} from "react";
import { useTranslations } from "use-intl";
import { commands } from "@/bindings";
import { useSettingsStore } from "@/entities/setting";
import {
	onFullSentence,
	onNoAudioDetected,
	onRealtimeText,
	onRecordingStart,
	onRecordingStop,
	onTranscriptionFailed,
} from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { formatKeyName } from "@/shared/lib/format-key-name";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { PulseDot } from "@/shared/ui/pulse-dot";

type RecordingMode = "ptt" | "toggle" | "listen" | "wakeword";

// Decorative separator glyph between keycaps — a visual symbol, not translatable
// copy (held in a const so `i18next/no-literal-string` doesn't flag it).
const KEY_SEPARATOR = "+";

interface DemoState {
	hint: string | null;
	interimText: string;
	isRecording: boolean;
	text: string;
}

type DemoAction =
	| { type: "clearText" }
	| { type: "clearTranscriptStatus" }
	| { type: "recordingStart" }
	| { type: "recordingStop" }
	| { type: "recordingHint"; hint: string }
	| { type: "setInterim"; text: string }
	| { type: "setText"; text: string }
	| { type: "userText"; text: string };

const INITIAL_DEMO_STATE: DemoState = {
	hint: null,
	interimText: "",
	isRecording: false,
	text: "",
};

function demoReducer(state: DemoState, action: DemoAction): DemoState {
	switch (action.type) {
		case "clearText":
			return { ...state, text: "", interimText: "", hint: null };
		case "clearTranscriptStatus":
			return { ...state, interimText: "", hint: null };
		case "recordingStart":
			return { text: "", interimText: "", hint: null, isRecording: true };
		case "recordingStop":
			return { ...state, isRecording: false };
		case "recordingHint":
			return { ...state, isRecording: false, hint: action.hint };
		case "setInterim":
			return { ...state, interimText: action.text };
		case "setText":
			return { ...state, text: action.text };
		case "userText":
			return { ...state, text: action.text, interimText: "", hint: null };
	}
}

/**
 * Live "try dictation" demo for the recording-mode step. By this point onboarding
 * has a configured model (local pick or cloud keys) and a passed mic test, so on
 * mount we ask the backend to light up the real dictation runtime
 * (`onboarding_enable_dictation`: lifts the model-free gate, loads + warms the
 * model, arms the global hotkey + paste pipeline). The user then focuses the text
 * area, presses their hotkey, and speaks. The normal paste path gets first chance
 * to insert into the focused field, with the `stt:*` final event acting as a
 * fallback if the paste target did not receive the text.
 */
export function OnboardingDictationDemo() {
	const t = useTranslations("onboarding");
	const pushToTalkKey = useSettingsStore(
		(s) => s.settings.hotkey?.pushToTalkKey ?? "",
	);
	const recordingMode = useSettingsStore(
		(s) => (s.settings.general?.recordingMode ?? "ptt") as RecordingMode,
	);
	const wakeWord = useSettingsStore((s) => s.settings.general?.wakeWord ?? "");

	const [{ text, interimText, isRecording, hint }, dispatch] = useReducer(
		demoReducer,
		INITIAL_DEMO_STATE,
	);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const textRef = useRef("");
	const pasteFallbackRef = useRef<number | null>(null);

	const updateText = (updater: (current: string) => string): void => {
		const next = updater(textRef.current);
		textRef.current = next;
		dispatch({ type: "setText", text: next });
	};

	const clearPasteFallback = (): void => {
		if (pasteFallbackRef.current !== null) {
			window.clearTimeout(pasteFallbackRef.current);
			pasteFallbackRef.current = null;
		}
	};

	const queueOrAppendTranscript = (sentence: string): void => {
		const focused = document.activeElement === textareaRef.current;
		if (!focused) {
			updateText((current) => appendTranscript(current, sentence));
			return;
		}
		const before = textRef.current;
		clearPasteFallback();
		pasteFallbackRef.current = window.setTimeout(() => {
			pasteFallbackRef.current = null;
			const current = textRef.current;
			if (
				countOccurrences(current, sentence) > countOccurrences(before, sentence)
			) {
				return;
			}
			updateText((latest) => appendTranscript(latest, sentence));
		}, 350);
	};

	const handleTextChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
		const next = event.currentTarget.value;
		textRef.current = next;
		dispatch({ type: "userText", text: next });
	};

	const clearDemoText = (): void => {
		clearPasteFallback();
		textRef.current = "";
		dispatch({ type: "clearText" });
		textareaRef.current?.focus();
	};

	// Light up the dictation runtime the first time the demo shows. Idempotent on
	// the backend; the ref guards repeat step mounts (re-entering the step).
	const enabledRef = useRef(false);
	useEffect(() => {
		if (enabledRef.current) {
			return;
		}
		enabledRef.current = true;
		void commands.onboardingEnableDictation();
	}, []);

	useEffect(
		() => () => {
			if (pasteFallbackRef.current !== null) {
				window.clearTimeout(pasteFallbackRef.current);
				pasteFallbackRef.current = null;
			}
		},
		[],
	);

	useEffect(() => {
		const unsubscribes = [
			onRealtimeText(({ text, isFinal }) => {
				if (!isFinal) {
					dispatch({ type: "setInterim", text });
				}
			}),
			onFullSentence((text) => {
				const trimmed = text.trim();
				dispatch({ type: "clearTranscriptStatus" });
				if (trimmed) {
					queueOrAppendTranscript(trimmed);
				}
			}),
			onRecordingStart(() => {
				// Each dictation starts fresh — wipe the previous result so the box
				// shows only the current attempt instead of accumulating forever.
				clearPasteFallback();
				textRef.current = "";
				dispatch({ type: "recordingStart" });
			}),
			onRecordingStop(() => dispatch({ type: "recordingStop" })),
			onNoAudioDetected(() => {
				dispatch({ type: "recordingHint", hint: t("demoNoSpeech") });
			}),
			onTranscriptionFailed((payload) => {
				dispatch({
					type: "recordingHint",
					hint: payload.message ?? t("demoFailed"),
				});
			}),
		];
		return () => {
			for (const off of unsubscribes) {
				off();
			}
		};
	}, [t]);

	// Keep the newest text in view when a long dictation overflows the capped box.
	useEffect(() => {
		const el = textareaRef.current;
		if (el) {
			el.scrollTop = el.scrollHeight;
		}
	}, [text]);

	const hasText = text.length > 0 || interimText.length > 0;
	const footerText = hint ?? (interimText || t("demoHelp"));

	return (
		<ElevatedSurface className="overflow-hidden">
			<div className="flex flex-col gap-3 px-4 py-3">
				<div className="flex items-start justify-between gap-3">
					<div className="flex min-w-0 items-start gap-3">
						<span
							aria-hidden
							className={cn(
								"mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md ring-1 transition-colors duration-200",
								isRecording
									? "bg-accent/15 text-accent ring-accent/30"
									: "bg-surface-2 text-foreground-muted ring-divider",
							)}
						>
							<HugeiconsIcon icon={Mic01Icon} size={15} />
						</span>
						<div className="min-w-0">
							<h2 className="font-semibold text-body text-foreground leading-snug">
								{t("demoTitle")}
							</h2>
							<DemoPrompt
								mode={recordingMode}
								pushToTalkKey={pushToTalkKey}
								wakeWord={wakeWord}
							/>
						</div>
					</div>
					{isRecording ? (
						<span className="inline-flex shrink-0 items-center gap-1.5 rounded-sm bg-accent/12 px-1.5 py-0.5 font-medium text-2xs text-accent uppercase tracking-wider ring-1 ring-accent/25">
							<PulseDot className="size-1.5" />
							{t("demoListening")}
						</span>
					) : null}
				</div>

				<textarea
					aria-label={t("demoTitle")}
					// `scrollbar-color` is overridden because the app hides scrollbars
					// app-wide (globals.css: `* { scrollbar-color: transparent }`, only
					// revealed mid-scroll). The capped demo box keeps a persistent thin
					// scrollbar so a filled box reads as scrollable instead of clipped.
					className="min-h-[4.5rem] max-h-[8.5rem] resize-none select-text overflow-y-auto overscroll-contain rounded-md bg-surface-2/70 px-3 py-2 text-body text-foreground leading-relaxed outline-none ring-1 ring-divider transition-[background-color,box-shadow] duration-150 [scrollbar-color:var(--color-foreground-dim)_transparent] [scrollbar-width:thin] placeholder:text-foreground-dim focus-visible:ring-2 focus-visible:ring-accent"
					dir="auto"
					onChange={handleTextChange}
					placeholder={t("demoPlaceholder")}
					ref={textareaRef}
					spellCheck
					value={text}
				/>

				<div className="flex items-center justify-between gap-2">
					<p className="text-body-sm text-foreground-muted leading-snug">
						{footerText}
					</p>
					{hasText ? (
						<button
							className="shrink-0 rounded-sm px-2 py-1 font-mono text-foreground-muted text-xs-tight uppercase tracking-[0.14em] outline-none transition-colors hover:bg-foreground/[0.06] hover:text-foreground-secondary focus-visible:ring-2 focus-visible:ring-accent"
							onClick={clearDemoText}
							type="button"
						>
							{t("demoClear")}
						</button>
					) : null}
				</div>
			</div>
		</ElevatedSurface>
	);
}

function appendTranscript(current: string, sentence: string): string {
	const base = current.trimEnd();
	return base ? `${base} ${sentence}` : sentence;
}

function countOccurrences(text: string, needle: string): number {
	if (!needle) {
		return 0;
	}
	let count = 0;
	let index = 0;
	while (true) {
		const found = text.indexOf(needle, index);
		if (found === -1) {
			return count;
		}
		count += 1;
		index = found + needle.length;
	}
}

interface DemoPromptProps {
	mode: RecordingMode;
	pushToTalkKey: string;
	wakeWord: string;
}

function DemoPrompt({ mode, pushToTalkKey, wakeWord }: DemoPromptProps) {
	const t = useTranslations("onboarding");
	if (mode === "listen") {
		return (
			<p className="mt-1 text-body-sm text-foreground-muted leading-snug">
				{t("demoPromptListen")}
			</p>
		);
	}
	if (mode === "wakeword") {
		return (
			<p className="mt-1 text-body-sm text-foreground-muted leading-snug">
				{t("demoPromptWakeword", { word: wakeWord })}
			</p>
		);
	}
	const keys = pushToTalkKey
		? pushToTalkKey.split("+").map((k) => formatKeyName(k))
		: [];
	return (
		<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
			{keys.length > 0 ? <Keycaps keys={keys} /> : null}
			<span className="text-body-sm text-foreground-muted leading-snug">
				{mode === "ptt" ? t("demoPromptPtt") : t("demoPromptToggle")}
			</span>
		</div>
	);
}

function Keycaps({ keys }: { keys: readonly string[] }) {
	return (
		<span className="inline-flex items-center gap-1.5">
			{keys.map((key, index) => (
				<span
					className="inline-flex items-center gap-1.5"
					key={`${key}-${index}`}
				>
					{index > 0 ? (
						<span aria-hidden className="text-foreground-dim">
							{KEY_SEPARATOR}
						</span>
					) : null}
					<Keycap>{key}</Keycap>
				</span>
			))}
		</span>
	);
}

function Keycap({ children }: { children: ReactNode }) {
	return (
		<kbd className="inline-flex h-5 items-center rounded-xs bg-surface-3 px-1.5 font-mono text-2xs text-foreground-secondary ring-1 ring-divider-strong">
			{children}
		</kbd>
	);
}
