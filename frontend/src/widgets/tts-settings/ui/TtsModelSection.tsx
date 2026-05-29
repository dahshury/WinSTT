import { VolumeHighIcon } from "@hugeicons/core-free-icons";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { DEFAULT_SETTINGS, SettingSection, useSettingsStore } from "@/entities/setting";
import {
	listTtsVoices,
	onTtsFailed,
	onTtsPlaybackEnded,
	onTtsPlaybackStarted,
	onTtsStarted,
	type TtsVoiceCatalog,
	ttsCancel,
	ttsInstallCancel,
	ttsSpeak,
} from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import type { SelectOptionGroup } from "@/shared/ui/searchable-select";
import type { SelectOption } from "@/shared/ui/select";
import { useTtsDownloadProgress } from "../model/use-tts-download-progress";
import { useTtsInstallGate } from "../model/use-tts-install-gate";
import { TtsControls } from "./TtsControls";
import { TtsInstallBanner } from "./TtsInstallBanner";
import { TtsInstallDialog } from "./TtsInstallDialog";

export interface TtsModelSectionProps {
	/** Reserved for future composition — currently the section pulls all state
	 * from the settings store and IPC client itself. */
	className?: string;
}

// Sample sentence read aloud by the "Test voice" button. Static so the speed/
// voice change is the only audible variable.
const TEST_SAMPLE_FALLBACK = "The quick brown fox jumps over the lazy dog.";

// Voice ids encode language as a short prefix ("af_heart" → "a" → "en-us").
// When the catalog response provides an explicit `language` field we use that;
// this fallback only fires if the field is missing.
function deriveLanguage(voiceId: string): string {
	const prefix = voiceId.slice(0, 1).toLowerCase();
	switch (prefix) {
		case "a":
			return "en-us";
		case "b":
			return "en-gb";
		case "e":
			return "es";
		case "f":
			return "fr-fr";
		case "h":
			return "hi";
		case "i":
			return "it";
		case "j":
			return "ja";
		case "p":
			return "pt-br";
		case "z":
			return "zh";
		default:
			return "en-us";
	}
}

// Short country/region code shown as the group-header badge and on the
// selected voice in the (closed) trigger. Falls back to the language code so
// an unknown future locale still gets *a* badge.
const REGION_BADGE: Record<string, string> = {
	"en-us": "US",
	"en-gb": "UK",
	ja: "JP",
	cmn: "ZH",
	es: "ES",
	fr: "FR",
	hi: "HI",
	it: "IT",
	"pt-br": "BR",
};

function regionBadge(language: string): string {
	return REGION_BADGE[language] ?? language.split("-")[0]?.toUpperCase() ?? language.toUpperCase();
}

// Catalog labels already suffix the country ("Heart (US)"); under a country
// header that suffix is redundant, so strip a trailing parenthetical for the
// row text. The badge keeps the country legible in the closed trigger.
const TRAILING_PAREN_RE = /\s*\([^)]*\)\s*$/;

function stripRegionSuffix(label: string): string {
	return label.replace(TRAILING_PAREN_RE, "").trim() || label;
}

// Group the 54 voices by country (their language/locale) so the picker reads
// like the STT model selector — one sticky header per country, voices nested
// under it. Group order follows the catalog's own language ordering; voices
// whose language isn't listed there sort last, then alphabetically by code.
function buildVoiceGroups(catalog: TtsVoiceCatalog): SelectOptionGroup[] {
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
		.sort(([a], [b]) => {
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

export function TtsModelSection(_props: TtsModelSectionProps = {}) {
	const t = useTranslations("tts");
	const tts = useSettingsStore((s) => s.settings.tts);
	const update = useSettingsStore((s) => s.updateTtsSettings);

	const [catalog, setCatalog] = useState<TtsVoiceCatalog>({ voices: [], languages: [] });

	// The play/loading/stop affordance tracks *audible* playback via events
	// the main process broadcasts to every window — so it works even though
	// the audio queue lives in a different window (the settings window has
	// none). Lifecycle: `onTtsStarted` → loading (synthesis ~1s);
	// `onTtsPlaybackStarted` → speaking (audio actually playing);
	// `onTtsPlaybackEnded` → idle (buffered audio fully played out, not the
	// much-earlier `tts_complete`).
	const [playback, setPlayback] = useState<{ requestId: string | null; playing: boolean }>({
		requestId: null,
		playing: false,
	});
	const [errorReason, setErrorReason] = useState<string | null>(null);
	// Which voice the active preview belongs to — drives the per-row and
	// in-trigger play/stop/loading affordance. Set optimistically on click
	// (the request id isn't known until `onTtsStarted`) and cleared whenever
	// playback returns to idle — that clear happens INLINE in the playback
	// terminal handlers below so we never need a `playback.requestId === null`
	// reflex effect.
	const [previewVoiceId, setPreviewVoiceId] = useState<string | null>(null);
	// Confirm-before-download gate (state + handlers live in the model
	// hook — see use-tts-install-gate). `handleEnabledToggle` only flips
	// the store's `enabled` flag after the user accepts the dialog.
	const {
		confirmOpen,
		estimate,
		probing,
		installPhase,
		installError,
		handleEnabledToggle,
		handleInstallConfirm,
		handleInstallCancel,
		closeConfirm,
		retryInstall,
	} = useTtsInstallGate();

	const enabled = tts?.enabled ?? false;
	const voice = tts?.voice ?? "af_heart";
	const speed = tts?.speed ?? DEFAULT_SETTINGS.tts.speed;

	// Latest-value refs for the on-enable catalog fetch. We only want to run
	// the fetch when `enabled` flips, but the .then() callback needs the
	// freshest `voice` / `update` to apply the stale-voice fallback. Reading
	// them through a ref keeps the effect's dependency array down to
	// `[enabled]` without tripping exhaustive-deps. Refs are written in an
	// effect (NOT during render) to comply with React's no-side-effects-in-
	// render rule.
	const voiceRef = useRef(voice);
	const updateRef = useRef(update);
	useEffect(() => {
		voiceRef.current = voice;
		updateRef.current = update;
	});

	// Fetch the voice catalog whenever the section becomes enabled. The IPC
	// layer caches the result on the main side, so re-enabling is cheap.
	//
	// Guard: TTS must always resolve to a voice the catalog actually offers.
	// The schema default ("af_heart") covers the common case, but a stale
	// saved voice (catalog change, corrupted settings) would otherwise leave
	// the dropdown in an empty-selection state and crash synth at request
	// time. Folded INTO the same .then() so we don't need a second effect
	// that reacts to `catalog.voices` (which would be a no-event-handler
	// finding for "react to a fetch result with a setState").
	useEffect(() => {
		if (!enabled) {
			return;
		}
		let cancelled = false;
		listTtsVoices().then((result) => {
			if (cancelled) {
				return;
			}
			setCatalog(result);
			if (result.voices.length === 0) {
				return;
			}
			const currentVoice = voiceRef.current;
			const valid = result.voices.some((v) => v.id === currentVoice);
			if (valid) {
				return;
			}
			const first = result.voices[0];
			if (first) {
				updateRef.current({ voice: first.id, lang: first.language });
			}
		});
		return () => {
			cancelled = true;
		};
	}, [enabled]);

	useEffect(
		() =>
			onTtsStarted(({ requestId }) => {
				setPlayback({ requestId, playing: false });
				setErrorReason(null);
			}),
		[]
	);
	useEffect(
		() =>
			onTtsPlaybackStarted(({ requestId }) => {
				// Synthesis gap is over, audio is now playing. Exact-match so
				// a stale start from a superseded preview can't promote the
				// wrong request.
				setPlayback((p) => (p.requestId === requestId ? { requestId, playing: true } : p));
			}),
		[]
	);
	useEffect(
		() =>
			onTtsPlaybackEnded(({ requestId }) => {
				// Exact-match only. `onTtsStarted` always delivers the real id
				// before audio plays, so we never need a wildcard reset — and
				// a stale empty-id "ended" (from the cancel that precedes
				// every preview) must NOT clear the freshly-started request.
				setPlayback((p) => {
					if (p.requestId !== requestId) {
						return p;
					}
					// Playback truly ended for the active preview — also clear
					// the per-row affordance inline so we never need a reflex
					// effect on `playback.requestId === null`.
					setPreviewVoiceId(null);
					return { requestId: null, playing: false };
				});
			}),
		[]
	);
	useEffect(
		() =>
			onTtsFailed(({ requestId, reason }) => {
				setPlayback((p) => {
					if (p.requestId !== requestId) {
						return p;
					}
					setPreviewVoiceId(null);
					return { requestId: null, playing: false };
				});
				setErrorReason(reason);
			}),
		[]
	);

	const downloadProgress = useTtsDownloadProgress(installPhase);
	const voiceGroups = buildVoiceGroups(catalog);

	const langForVoice = (voiceId: string): string =>
		catalog.voices.find((v) => v.id === voiceId)?.language ?? deriveLanguage(voiceId);

	// Speak a short sample in the given voice. Cancels any in-flight
	// playback first so rapid voice switching always previews the latest
	// pick (the renderer queue drops chunks whose request_id doesn't match
	// the active one, so an un-cancelled prior preview would otherwise
	// swallow the new one).
	const previewVoice = (nextVoiceId: string, previewLang: string): void => {
		ttsCancel();
		setPreviewVoiceId(nextVoiceId);
		ttsSpeak({
			text: t("testVoiceSample") || TEST_SAMPLE_FALLBACK,
			voice: nextVoiceId,
			lang: previewLang,
			speed,
		});
	};

	const handleVoiceChange = (nextVoice: string): void => {
		// Each voice belongs to one language — derive it so the user doesn't
		// have to keep two pickers in sync. Prefer the catalog field when
		// present; fall back to the prefix heuristic for offline mode.
		const meta = catalog.voices.find((v) => v.id === nextVoice);
		const nextLang = meta?.language ?? deriveLanguage(nextVoice);
		update({ voice: nextVoice, lang: nextLang });
		// Picking a voice in the dropdown immediately previews it — the
		// preview lives in the selector itself, not a separate button.
		previewVoice(nextVoice, nextLang);
	};

	const handleSpeedChange = (next: number): void => {
		update({ speed: next });
	};

	const handleSpeedReset = (): void => {
		update({ speed: DEFAULT_SETTINGS.tts.speed });
	};

	const isLoading = playback.requestId !== null && !playback.playing;
	const isSpeaking = playback.requestId !== null && playback.playing;
	const voicePlaceholder = catalog.voices.length === 0 ? t("noVoicesYet") : t("voiceCaption");

	// While the on-demand install is downloading OR sitting paused, every
	// settings control below the section header is locked. Two reasons:
	//   1. Voice / speed changes can't take effect until the
	//      engine is loaded — letting the user fiddle here pretends to
	//      change something it doesn't, then surprises them once the
	//      install finishes and the new settings retroactively apply.
	//   2. Server-side, swap_parameter on a half-initialized synthesizer
	//      races the warm-up executor. The pause/resume/cancel buttons
	//      in the install banner are the only legitimate interactions
	//      during this window.
	// `installPhase` covers the WHOLE install (engine → model → ready),
	// including the gaps between asset downloads (extraction, ORT session
	// init) where no progress events fire. `downloadProgress.active` is a
	// belt-and-suspenders backup for any window where bytes are streaming
	// before the next status ping arrives.
	const installing = installPhase !== null || downloadProgress.active;
	const handleCancelInstall = (): void => {
		ttsInstallCancel();
		// Cancel means "discard, I don't want this anymore" — flip the
		// toggle back off so the section returns to its pre-enable state
		// rather than sitting on `enabled: true` with no engine.
		update({ enabled: false });
	};

	return (
		<>
			<SettingSection
				description={t("description")}
				icon={VolumeHighIcon}
				onToggle={handleEnabledToggle}
				title={t("title")}
				toggleDisabled={installing}
				toggled={enabled}
			>
				<div className="flex flex-col divide-y divide-surface-1">
					<div
						className={cn(
							"flex flex-col divide-y divide-surface-1 transition-opacity duration-200 ease-out",
							installing && "pointer-events-none opacity-40"
						)}
					>
						<TtsControls
							activeRequestId={playback.requestId}
							isLoading={isLoading}
							isSpeaking={isSpeaking}
							langForVoice={langForVoice}
							onSpeedChange={handleSpeedChange}
							onSpeedReset={handleSpeedReset}
							onVoiceChange={handleVoiceChange}
							previewVoice={previewVoice}
							previewVoiceId={previewVoiceId}
							speed={speed}
							t={t}
							voice={voice}
							voiceGroups={voiceGroups}
							voicePlaceholder={voicePlaceholder}
						/>
					</div>
					<TtsInstallBanner
						downloadProgress={downloadProgress}
						errorReason={errorReason}
						installError={installError}
						onCancelInstall={handleCancelInstall}
						onRetry={retryInstall}
						t={t}
					/>
				</div>
			</SettingSection>
			<TtsInstallDialog
				estimate={estimate}
				onCancel={handleInstallCancel}
				onClose={closeConfirm}
				onConfirm={handleInstallConfirm}
				open={confirmOpen && !probing}
			/>
		</>
	);
}
