import { AiCloud01Icon, CpuIcon, LockIcon, VolumeHighIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "use-intl";
import {
	DEFAULT_SETTINGS,
	SettingResetButton,
	SettingSection,
	useSettingsStore,
	useSettingsTabStore,
} from "@/entities/setting";
import {
	type TtsVoiceCatalog,
	ttsCancel,
	ttsCloudPreview,
	ttsInstallCancel,
	ttsSpeak,
} from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import type { SelectOptionGroup } from "@/shared/ui/searchable-select";
import type { SelectOption } from "@/shared/ui/select";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { type UseCloudTtsVoices, useCloudTtsVoices } from "../model/use-cloud-tts-voices";
import { useTtsDownloadProgress } from "../model/use-tts-download-progress";
import { useTtsInstallGate } from "../model/use-tts-install-gate";
import { useTtsPlayback } from "../model/use-tts-playback";
import { useTtsVoiceCatalog } from "../model/use-tts-voice-catalog";
import { CloudTtsControls } from "./CloudTtsControls";
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

// Shown when the ElevenLabs character quota is spent (free OR paid) — Cloud is
// locked until it resets / the plan upgrades. Plain const (not an i18n key) to
// avoid touching the 20 locale files the cleanup sweep is editing.
const OUT_OF_CREDITS_NOTE =
	"Out of ElevenLabs credits — cloud text-to-speech is paused until your quota resets or you upgrade.";

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

interface CloudGate {
	/** Cloud source is selectable (key verified AND voices available/loading). */
	cloudAllowed: boolean;
	/** Verified key that authenticated but can't list voices — drives the notice. */
	noVoiceAccess: boolean;
}

// Derive the cloud-source gate from the live voice-catalog probe. A verified
// ElevenLabs key proves authentication (dictation / cloud STT work), but cloud
// TTS additionally needs the `voices_read` scope. An in-flight fetch is treated
// as optimistically allowed (most keys grant the scope, so the switch shouldn't
// flicker to local while we confirm); we lock only once the catalog resolves
// empty, surfacing the server's permission message via `noVoiceAccess`. Pulled
// out of the component to keep it under the complexity budget.
function deriveCloudGate(elevenVerified: boolean, cloud: UseCloudTtsVoices): CloudGate {
	if (!elevenVerified) {
		return { cloudAllowed: false, noVoiceAccess: false };
	}
	// Out of ElevenLabs credits (free OR paid) → cloud is unusable regardless of
	// voices, so lock the whole source. The reason is surfaced by the caller.
	if (cloud.creditsExhausted) {
		return { cloudAllowed: false, noVoiceAccess: false };
	}
	if (cloud.isLoading) {
		return { cloudAllowed: true, noVoiceAccess: false };
	}
	const hasVoices = cloud.voices.length > 0;
	return { cloudAllowed: hasVoices, noVoiceAccess: !hasVoices && cloud.error !== null };
}

// Tooltip footer for the locked Cloud switch: prefer the out-of-credits note,
// then the server's voice/permission error, else the generic "add a key" hint.
// Extracted to keep `TtsModelSection` under the complexity budget.
function cloudLockFooterText(
	elevenVerified: boolean,
	cloud: UseCloudTtsVoices,
	fallbackHint: string
): string {
	if (cloud.creditsExhausted) {
		return OUT_OF_CREDITS_NOTE;
	}
	if (elevenVerified && cloud.error) {
		return cloud.error;
	}
	return fallbackHint;
}

export function TtsModelSection(_props: TtsModelSectionProps = {}) {
	const t = useTranslations("tts");
	const tIntegrations = useTranslations("integrations");
	const tts = useSettingsStore((s) => s.settings.tts);
	const update = useSettingsStore((s) => s.updateTtsSettings);
	const integrations = useSettingsStore((s) => s.settings.integrations);
	const goToIntegrations = useSettingsTabStore((s) => s.setActiveTab);

	// Cloud is only selectable once the ElevenLabs key is present AND the last
	// probe verified it. A persisted `source: "cloud"` without a verified key
	// falls back to local — same posture as the STT model source area, so a
	// removed/invalidated key can never strand TTS on an unreachable provider.
	const elevenVerified =
		integrations.elevenlabs.apiKey.trim().length > 0 && integrations.elevenlabs.verified === true;
	// Probe the live voice catalog whenever the key is VERIFIED — even in local
	// mode — so we know before the user picks Cloud whether the key actually
	// grants the `voices_read` scope that cloud TTS needs. A verified key only
	// proves authentication (so dictation / cloud STT work); voice access is a
	// separate ElevenLabs permission, so that gate lives HERE, not in credential
	// verification (which intentionally accepts a working-but-scoped key).
	const cloud = useCloudTtsVoices(elevenVerified);
	// Cloud gating (allowed / no-voice-access) is derived in a module helper so
	// this component stays under the complexity budget — see `deriveCloudGate`.
	const { cloudAllowed, noVoiceAccess } = deriveCloudGate(elevenVerified, cloud);
	const effectiveSource = tts?.source === "cloud" && cloudAllowed ? "cloud" : "local";
	const isCloud = effectiveSource === "cloud";

	// Confirm-before-download gate (state + handlers live in the model
	// hook — see use-tts-install-gate). `handleLocalEnabledToggle` only flips
	// the store's `enabled` flag after the user accepts the dialog — it is the
	// LOCAL path; cloud has nothing to download (see `handleEnabledToggle`).
	const {
		confirmOpen,
		estimate,
		probing,
		installPhase,
		installError,
		handleEnabledToggle: handleLocalEnabledToggle,
		handleInstallConfirm,
		handleInstallCancel,
		closeConfirm,
		retryInstall,
	} = useTtsInstallGate();

	const enabled = tts?.enabled ?? false;
	const voice = tts?.voice ?? "af_heart";
	const speed = tts?.speed ?? DEFAULT_SETTINGS.tts.speed;

	const catalog = useTtsVoiceCatalog(enabled, voice, update);
	const { playback, isLoading, isSpeaking, previewVoiceId, setPreviewVoiceId, errorReason } =
		useTtsPlayback();

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

	// Cloud voice preview plays the voice's FREE pre-generated sample
	// (`previewUrl`) instead of a paid synthesis — browsing voices costs no
	// ElevenLabs credits. Falls back to a (paid) synthesis preview only for a
	// voice with no sample URL. Mirrors `previewVoice`'s cancel-then-mark so the
	// play/stop affordance behaves identically.
	const previewCloudVoice = (nextVoiceId: string, previewLang: string): void => {
		const previewUrl = cloud.voices.find((v) => v.id === nextVoiceId)?.previewUrl;
		if (previewUrl) {
			ttsCancel();
			setPreviewVoiceId(nextVoiceId);
			ttsCloudPreview({ previewUrl });
			return;
		}
		// No free sample clip: a usable voice can fall back to a (paid) synthesis
		// preview, but a locked premium voice must NOT — that would 402.
		if (!cloud.lockedVoiceIds.has(nextVoiceId)) {
			previewVoice(nextVoiceId, previewLang);
		}
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
	// The install gate (and its lock) only applies to LOCAL Kokoro — cloud has
	// nothing to download. In cloud mode the controls stay live and the toggle
	// never opens a dialog.
	const installing = !isCloud && (installPhase !== null || downloadProgress.active);
	const handleCancelInstall = (): void => {
		ttsInstallCancel();
		// Cancel means "discard, I don't want this anymore" — flip the
		// toggle back off so the section returns to its pre-enable state
		// rather than sitting on `enabled: true` with no engine.
		update({ enabled: false });
	};

	// Cloud bypasses the confirm-before-download gate entirely — flip `enabled`
	// straight away. Local routes through the gate so the Kokoro install dialog
	// can intercept the off→on edge.
	const handleEnabledToggle = (next: boolean): void => {
		if (isCloud) {
			update({ enabled: next });
			return;
		}
		handleLocalEnabledToggle(next);
	};

	const handleSourceChange = (next: "local" | "cloud"): void => {
		update({ source: next });
	};

	// Local ⇄ Cloud segmented switch — mirrors the STT model `SourceArea`.
	// Cloud is locked (lock badge + tooltip → Integrations) for two reasons:
	//   • no verified key             → the generic "add a key" hint
	//   • verified key, no voices_read → the server's precise permission message
	//     (cloud.error), so the user learns the key works for dictation but lacks
	//     the voice scope. Both badge-clicks deep-link to Integrations.
	const cloudLockFooter = cloudLockFooterText(
		elevenVerified,
		cloud,
		tIntegrations("cloudDisabledHint")
	);
	const sourceOpts: SwitcherOption<"local" | "cloud">[] = [
		{ value: "local", label: tIntegrations("sourceLocal"), icon: CpuIcon },
		{
			value: "cloud",
			label: tIntegrations("sourceCloud"),
			icon: AiCloud01Icon,
			disabled: !cloudAllowed,
			...(cloudAllowed
				? {}
				: {
						badgeIcon: LockIcon,
						badgeTooltip: tIntegrations("sourceTooltip"),
						badgeTooltipFooter: cloudLockFooter,
						onBadgeClick: () => goToIntegrations("integrations"),
					}),
		},
	];

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
						<FormControl
							label={tIntegrations("sourceLabel")}
							labelTrailing={
								<SettingResetButton
									isDefault={effectiveSource === DEFAULT_SETTINGS.tts.source}
									onReset={() => handleSourceChange(DEFAULT_SETTINGS.tts.source)}
								/>
							}
							layout="row"
							tooltip={tIntegrations("sourceTooltip")}
						>
							<ElevatedSurface className="w-52">
								<Switcher
									fullWidth
									onChange={handleSourceChange}
									options={sourceOpts}
									value={effectiveSource}
								/>
							</ElevatedSurface>
						</FormControl>
						{noVoiceAccess ? (
							<p className="px-1 pt-2 text-2xs text-foreground-muted leading-relaxed">
								{cloud.error}
							</p>
						) : null}
						{elevenVerified && cloud.creditsExhausted ? (
							<p className="px-1 pt-2 text-2xs text-warning leading-relaxed">
								{OUT_OF_CREDITS_NOTE}
							</p>
						) : null}
						{isCloud ? (
							<CloudTtsControls
								activeRequestId={playback.requestId}
								error={cloud.error}
								groups={cloud.groups}
								isLoading={isLoading}
								isLoadingVoices={cloud.isLoading}
								isSpeaking={isSpeaking}
								previewVoice={previewCloudVoice}
								previewVoiceId={previewVoiceId}
								t={t}
							/>
						) : (
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
						)}
					</div>
					{isCloud ? null : (
						<TtsInstallBanner
							downloadProgress={downloadProgress}
							errorReason={errorReason}
							installError={installError}
							onCancelInstall={handleCancelInstall}
							onRetry={retryInstall}
							t={t}
						/>
					)}
				</div>
			</SettingSection>
			{isCloud ? null : (
				<TtsInstallDialog
					estimate={estimate}
					onCancel={handleInstallCancel}
					onClose={closeConfirm}
					onConfirm={handleInstallConfirm}
					open={confirmOpen && !probing}
				/>
			)}
		</>
	);
}
