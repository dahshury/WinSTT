import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { commands } from "@/bindings";
import {
	DEFAULT_SETTINGS,
	useSettingsStore,
	useSettingsTabStore,
} from "@/entities/setting";
import {
	useTtsCatalogStore,
	useTtsModelStateStore,
	useTtsSwapStore,
} from "@/entities/tts-catalog";
import {
	defaultVoiceForTtsModel,
	resolveTtsModelSelectionPatch,
	useTtsModelDownloads,
	useTtsModelPickerStore,
} from "@/features/tts-model-picker";
import { openModelPickerAtRect } from "@/shared/api/model-picker-window";
import {
	dialogOpenFiles,
	onTtsUnloadStatus,
	ttsCancel,
	ttsCloudPreview,
	ttsInstallCancel,
	ttsOpenRouterPreview,
	ttsSpeak,
} from "@/shared/api/ipc-client";
import type { SwitcherOption } from "@/shared/ui/switcher";
import {
	AiCloud01Icon,
	AiComputerIcon,
	LockIcon,
} from "@hugeicons/core-free-icons";
import { cloudLockFooterText, deriveCloudGate } from "../lib/cloud-gate";
import {
	CLONE_CLIP_EXTENSIONS,
	isAuthoredVoice,
	isCloneClipPath,
	MAX_VOICE_CLIPS,
	needsReferenceTranscript,
} from "../lib/clone-voice";
import { deriveInlineTagsGate } from "../lib/inline-tags-gate";
import { isPostProcessingReady } from "../lib/post-processing-gate";
import { demoSentenceForLang, deriveLanguage } from "../lib/voice-demo-text";
import {
	buildLanguageGroups,
	buildStyleVoiceGroups,
	buildVoiceGroups,
	clampSupertonicSpeed,
	resolveSupertonicLanguage,
	SUPERTONIC_MODEL_ID,
} from "../lib/voice-groups";
import {
	referencedClipPaths,
	type SavedVoice,
	type SavedVoiceClip,
	type SavedVoiceValue,
	supersededClipPaths,
	useVoiceLibraryStore,
	voiceNeedsRebuild,
} from "./voice-library";
import { useCloudTtsVoices } from "./use-cloud-tts-voices";
import { useTtsDownloadProgress } from "./use-tts-download-progress";
import {
	buildTtsEnablePatch,
	isTtsModelCached,
	pickCachedTtsModel,
	useTtsInstallGate,
} from "./use-tts-install-gate";
import { useTtsEnabledReconciler } from "./use-tts-enabled-reconciler";
import { useTtsPlayback } from "./use-tts-playback";
import { useTtsVoiceCatalog } from "./use-tts-voice-catalog";

/**
 * Unlink the files a successful weld left behind.
 *
 * Every clip added to or removed from a voice produces a NEW combined WAV under a
 * new content-addressed name, and a removed part stops being named at all — so
 * without this the managed folder grew on every single edit, and only DELETING a
 * whole voice ever swept anything.
 *
 * The library is read at call time and the voice's post-rebuild state is added to
 * it, because both still have a claim: two voices genuinely can share a part file
 * (stored names are content-addressed), and the live voice may have no library row
 * at all. Fire-and-forget, like the discard path: the command is total (it skips
 * what it cannot confine and treats an already-missing file as success), so there
 * is nothing to recover from and nothing worth blocking the UI on.
 */
function sweepSupersededClips(
	previous: readonly string[],
	next: SavedVoiceValue,
): void {
	const paths = supersededClipPaths({
		previous,
		retained: [...useVoiceLibraryStore.getState().voices, next],
	});
	if (paths.length > 0) {
		void commands.ttsDeleteReferenceClips(paths);
	}
}

/**
 * Owns the full TTS-model-section state machine — source/install/preview/enable
 * derivation plus every handler — leaving `TtsModelSection.tsx` as pure JSX
 * composition (mirrors how `model-settings` splits its `use-*` hooks). The
 * return shape is intentionally flat: the JSX reads it field-by-field.
 */
export function useTtsModelSection() {
	const t = useTranslations("tts");
	const tIntegrations = useTranslations("integrations");
	const tts = useSettingsStore((s) => s.settings.tts);
	const update = useSettingsStore((s) => s.updateTtsSettings);
	const integrations = useSettingsStore((s) => s.settings.integrations);
	const openrouterKey = useSettingsStore(
		(s) => s.settings.llm.openrouterApiKey,
	);
	const llmDictation = useSettingsStore((s) => s.settings.llm.dictation);
	const goToIntegrations = useSettingsTabStore((s) => s.setActiveTab);

	const elevenVerified =
		integrations.elevenlabs.apiKey.trim().length > 0 &&
		integrations.elevenlabs.verified === true;
	const cloud = useCloudTtsVoices(elevenVerified);
	const { cloudAllowed: elevenCloudAllowed, noVoiceAccess } = deriveCloudGate(
		elevenVerified,
		cloud,
	);
	const openrouterConfigured = openrouterKey.trim().length > 0;
	// Gate for every LLM-assisted voice affordance in this tab. There is no
	// master post-processing switch — the feature runs iff its own `enabled` is
	// true AND a model is configured.
	const postProcessingReady = isPostProcessingReady({
		dictation: llmDictation,
		openrouterApiKey: openrouterKey,
	});
	const cloudAllowed = elevenCloudAllowed || openrouterConfigured;
	const effectiveSource: "local" | "cloud" =
		tts?.source === "cloud" && cloudAllowed ? "cloud" : "local";
	const isCloud = effectiveSource === "cloud";

	const {
		installPhase,
		installError,
		handleEnabledToggle: handleLocalEnabledToggle,
		markWarmupPending,
		retryInstall,
	} = useTtsInstallGate();

	const enabled = tts?.enabled ?? false;
	const model = tts?.model ?? DEFAULT_SETTINGS.tts.model;
	const voice = tts?.voice ?? "af_heart";
	const lang = tts?.lang ?? DEFAULT_SETTINGS.tts.lang;
	const speed = tts?.speed ?? DEFAULT_SETTINGS.tts.speed;
	const hotkey = tts?.hotkey ?? "";

	const ttsModels = useTtsCatalogStore((s) => s.models);
	const ttsStatesById = useTtsModelStateStore((s) => s.statesById);
	const ttsStatesLoaded = useTtsModelStateStore((s) => s.isLoaded);
	const {
		getSnapshot: getTtsDownloadSnapshot,
		onDownloadAction: onTtsDownloadAction,
	} = useTtsModelDownloads();
	const currentTtsQuant = ttsStatesById[model]?.effectiveQuantization ?? "";
	const selectedModelInfo = useTtsCatalogStore((s) => s.getModel(model));
	const voiceDefault = defaultVoiceForTtsModel(selectedModelInfo, model);
	const selectedLocalModelCached = isTtsModelCached(ttsStatesById[model]);
	const cachedLocalModel = ttsStatesLoaded
		? pickCachedTtsModel(ttsModels, ttsStatesById)
		: null;
	const isCloningModel = (selectedModelInfo?.cloning ?? "none") !== "none";
	// Cloning models that need the reference-clip TRANSCRIPT (Spark) — the UI collects it
	// (auto-transcribed with the selected STT model into an editable field).
	const needsRefText =
		selectedModelInfo?.cloning === "zero_shot_audio_transcript";
	// Rows with NO unconditioned voice (Audio8): synthesis errors until a clip —
	// and its transcript — exist, so the clone field warns instead of implying the
	// model is ready. Read from the catalog rather than derived: `numVoices === 1`
	// is a sentinel shared with rows that DO ship a bundled voice (OmniVoice,
	// Chatterbox), so deriving it would warn on models that work fine.
	const requiresReferenceClip =
		selectedModelInfo?.requiresReferenceClip === true;
	// Voice-design models (Qwen3-TTS-VoiceDesign) don't pick from a voice bank —
	// the voice is *described* by a free-text prompt stored (overloaded) in
	// `settings.tts.voice`, exactly like cloning overloads it with a ref-audio
	// path. An empty prompt is the valid default (the model's built-in voice).
	const isVoiceDesignModel = selectedModelInfo?.voiceDesign === true;
	// Character budget for that prompt. Comes from the catalog row so the number
	// is decided once, in `catalog.rs`, and never re-typed in the UI. `0` on any
	// non-voice-design row (and on servers predating the field) = "no cap known".
	const voiceDesignMaxChars = selectedModelInfo?.voiceDesignMaxChars ?? 0;
	// A row that takes a style instruction ALONGSIDE its voice, rather than instead
	// of it (OmniVoice's `<|instruct_start|>` span). These rows clone, so the prompt
	// editor is an EXTRA field over `tts.voiceInstruct` and does not displace the
	// clone control the way `voiceDesign` displaces the voice dropdown.
	const isVoiceInstructModel = selectedModelInfo?.voiceInstruct === true;
	const voiceInstruct = tts?.voiceInstruct ?? "";
	// Longest reference clip this engine accepts, straight from its catalog row —
	// the backend trims to exactly this number, so quoting anything else in the UI
	// would be a second, drifting definition of the cap. `0` = the server didn't
	// say, so no cap is quoted at all.
	const maxRefClipSecs = selectedModelInfo?.maxRefClipSecs ?? 0;
	// Inline paralinguistic tags: the read-aloud text is annotated by the
	// post-processing LLM before synthesis. The vocabulary AND the delimiters are
	// catalog facts (`tags` / `tagSyntax`), so the row only exists for the engines
	// that actually ship one — and it needs the same post-processing pipeline as
	// the voice-design generator, hence the shared gate rather than a second
	// derivation of it.
	const inlineTagsGate = deriveInlineTagsGate({
		cloud: isCloud,
		model: selectedModelInfo,
		postProcessingReady,
	});
	const inlineTagsEnabled = tts?.inlineTags ?? DEFAULT_SETTINGS.tts.inlineTags;
	// A cloning model's `voice` legitimately holds a clip PATH, which is never in
	// the engine's voice catalog. Tell the catalog hook to leave it alone so its
	// stale-voice self-heal can't wipe the clip on the next refetch. A leftover
	// preset id from a previous model (`af_heart`) is NOT a path and is still
	// healed to a real preset.
	const voiceIsClipPath = isCloningModel && isCloneClipPath(voice);
	// The heal must skip the voice-design prompt for the same reason. Its catalog
	// row DOES return a voice (a single entry whose id is the empty string), so
	// without this the authored prompt is "healed" to `""` on every remount.
	const voiceIsAuthored = isAuthoredVoice({
		isCloningModel,
		isVoiceDesignModel,
		voice,
	});
	const catalog = useTtsVoiceCatalog(
		enabled,
		model,
		voice,
		update,
		voiceIsAuthored,
	);
	const isSupertonicModel =
		selectedModelInfo?.engine === "supertonic" || model === SUPERTONIC_MODEL_ID;
	const supertonicLanguage = isSupertonicModel
		? resolveSupertonicLanguage(lang, catalog)
		: lang;
	const effectiveSpeed = isSupertonicModel
		? clampSupertonicSpeed(speed)
		: speed;

	// Reconcile a hydrated-but-stale `enabled: true` — extracted hook so the
	// verify-before-punish behavior (the TTS toggle on→off→on flicker fix) is
	// unit-testable against the real stores.
	useTtsEnabledReconciler({
		cloudAllowed,
		enabled,
		installPhase,
		isCloud,
		model,
		models: ttsModels,
		statesById: ttsStatesById,
		statesLoaded: ttsStatesLoaded,
		update,
	});

	// Truthful "freeing memory" state: the backend emits `tts:unload-status`
	// around the actual session drop (settings disable / cloud switch), and the
	// toggle stays LOCKED until the drop confirms — instead of pretending the
	// memory was freed the instant it flipped. Safety-bounded — the drop is fast.
	const [unloadingLocalModel, setUnloadingLocalModel] = useState(false);
	// Cloning reference-clip state. The clip PATH is persisted (overloaded into
	// `settings.tts.voice`) and `cloneRefText` alongside it; everything here is
	// the transient feedback that path can't carry — busy, the last failure, and
	// what the backend reported about the clip it just stored.
	const [cloneBusy, setCloneBusy] = useState(false);
	const [cloneError, setCloneError] = useState<string | null>(null);
	// Keyed by clip path so the report is never attributed to a different clip:
	// selecting a saved voice or clearing the clip drops it automatically.
	const [clipReport, setClipReport] = useState<{
		/** The cap the backend ACTUALLY applied, so the trim notice quotes the
		 *  number that did the cutting rather than a second copy of it. `0` for a
		 *  clip restored from the library, which was never re-trimmed. */
		maxSecs: number;
		/** The individual sources welded into `path`, in ingest order — what the
		 *  card lists, and what a rebuild re-submits after one is dropped. A
		 *  single-clip voice has exactly one part whose path IS `path`. */
		parts: SavedVoiceClip[];
		path: string;
		seconds: number;
		trimmed: boolean;
	} | null>(null);
	const cloneRefText = tts?.cloneRefText ?? "";
	const handleCloneRefTextChange = (nextText: string): void => {
		update({ cloneRefText: nextText });
	};
	useEffect(
		() =>
			onTtsUnloadStatus(({ inProgress }) => setUnloadingLocalModel(inProgress)),
		[],
	);
	useEffect(() => {
		if (!unloadingLocalModel) {
			return;
		}
		const id = window.setTimeout(() => setUnloadingLocalModel(false), 15_000);
		return () => window.clearTimeout(id);
	}, [unloadingLocalModel]);

	const handleModelChange = (nextModel: string, quant?: string): void => {
		const modelChanged = nextModel !== model;
		const quantChanged = quant !== undefined && quant !== currentTtsQuant;
		if (!(modelChanged || quantChanged)) {
			return;
		}
		// Optimistically open the swap indicator on the trigger BEFORE persisting so
		// the transition shows immediately; the backend confirms/clears it via
		// `tts:install-status`. Only while a LOCAL engine is actually wanted — a
		// cloud voice or a disabled feature triggers no engine rebuild.
		if (enabled && !isCloud) {
			useTtsSwapStore.getState().begin({
				fromModelId: model,
				toModelId: nextModel,
				fromQuant: quantChanged ? currentTtsQuant : null,
				toQuant: quantChanged ? (quant ?? null) : null,
			});
		}
		if (modelChanged) {
			update(resolveTtsModelSelectionPatch(nextModel, ttsModels, speed, quant));
		} else if (quant !== undefined) {
			update({ quantization: quant });
		}
	};

	const {
		playback,
		isLoading,
		isSpeaking,
		previewVoiceId,
		setPreviewVoiceId,
		errorReason,
	} = useTtsPlayback();

	const downloadProgress = useTtsDownloadProgress(installPhase);
	const voiceGroups = isSupertonicModel
		? buildStyleVoiceGroups(catalog)
		: buildVoiceGroups(catalog);
	// A cloning engine's own voices ("default", or Spark's female/male) — offered
	// as a flat list beside the clip card, since the clip overrides them.
	const clonePresetOptions = catalog.voices.map((v) => ({
		id: v.id,
		label: v.label,
	}));
	const languageGroups = isSupertonicModel
		? buildLanguageGroups(catalog, t("language"))
		: undefined;

	const langForVoice = (voiceId: string): string =>
		isSupertonicModel
			? supertonicLanguage
			: (catalog.voices.find((v) => v.id === voiceId)?.language ??
				deriveLanguage(voiceId));

	const previewVoice = (nextVoiceId: string, previewLang: string): void => {
		ttsCancel();
		setPreviewVoiceId(nextVoiceId);
		ttsSpeak({
			text: demoSentenceForLang(previewLang, t("testVoiceSample")),
			voice: nextVoiceId,
			lang: previewLang,
			speed: effectiveSpeed,
		});
	};

	const previewCloudVoice = (
		nextVoiceId: string,
		previewLang: string,
	): void => {
		const previewUrl = cloud.voices.find(
			(v) => v.id === nextVoiceId,
		)?.previewUrl;
		if (previewUrl) {
			ttsCancel();
			setPreviewVoiceId(nextVoiceId);
			ttsCloudPreview({ previewUrl });
			return;
		}
		if (!cloud.lockedVoiceIds.has(nextVoiceId)) {
			previewVoice(nextVoiceId, previewLang);
		}
	};

	const previewOpenRouterVoice = (modelId: string, voiceId: string): void => {
		ttsCancel();
		setPreviewVoiceId(`openrouter:${modelId}:${voiceId}`);
		ttsOpenRouterPreview({
			model: modelId,
			voice: voiceId,
			speed: tts?.cloud?.speed ?? DEFAULT_SETTINGS.tts.cloud.speed,
		});
	};

	// ── Cloning reference clips ───────────────────────────────────────────
	// ONE commit path shared by the drop target, the browse button and the
	// per-clip remove: every edit re-states the voice's whole ordered clip list
	// and the backend welds it into a single combined file. Removing a clip is
	// therefore a rebuild from the survivors, not a subtraction — a combined WAV
	// cannot be un-concatenated.
	//
	// The renderer never persists the user's original files: the backend decodes
	// whatever containers it was handed, resamples, TRIMS to the model's cap, and
	// writes normalized WAVs under app data — the combined path is what goes into
	// settings, so the voice survives the sources being moved or deleted.
	//
	// The clip path the transcript effect below has already run for, so one
	// failure cannot become a retry loop.
	const transcribedClipRef = useRef("");
	const rebuildReferenceClips = async (
		paths: readonly string[],
	): Promise<void> => {
		setCloneError(null);
		// Refused before decoding a dozen files the backend is going to reject
		// anyway. THE single choke point for the part count: every edit (drop,
		// browse, removal) funnels through here.
		if (paths.length > MAX_VOICE_CLIPS) {
			setCloneError(t("voiceTooManyClips", { count: MAX_VOICE_CLIPS }));
			return;
		}
		// Everything the voice owns RIGHT NOW — its combined clip and its parts.
		// Read before the weld, because the weld is what makes some of it garbage:
		// a new combined file supersedes the old one, and a part dropped from the
		// list stops being named by anything.
		const superseded = [...referencedClipPaths([liveSavedVoice])];
		setCloneBusy(true);
		try {
			const built = await commands.ttsBuildReference([...paths]);
			if (built.status === "error") {
				setCloneError(built.error);
				return;
			}
			const { maxSecs, parts, seconds, storedPath, trimmed } = built.data;
			const clips: SavedVoiceClip[] = parts.map((part) => ({
				name: part.name,
				path: part.storedPath,
				seconds: part.seconds,
			}));
			setClipReport({
				maxSecs,
				parts: clips,
				path: storedPath,
				seconds,
				trimmed,
			});
			sweepSupersededClips(superseded, {
				clips,
				kind: "clip",
				maxSecs,
				refText: "",
				seconds,
				value: storedPath,
			});
			// New audio ⇒ the previous transcript described a different clip, so it
			// is dropped and re-derived by the effect below (for the engines that
			// need one). Re-arming the ref also lets re-picking the SAME file retry
			// a transcription that failed last time — and covers the rebuild that
			// lands on the same combined path after a no-op edit.
			transcribedClipRef.current = "";
			update({ voice: storedPath, cloneRefText: "" });
		} catch {
			// The invoke itself rejected (no native runtime, or the command panicked)
			// — there is no backend prose to quote, so the field says the one honest
			// thing it knows.
			setCloneError(t("voiceBuildFailed"));
		} finally {
			setCloneBusy(false);
		}
	};

	// The reference transcript is a property of the CLIP, not of the gesture that
	// adopted it. A clip can also arrive from a model switch (dropped under a
	// clip-only cloner, then Spark is selected) or from a library entry saved
	// under an engine that needed no transcript — both would otherwise leave Spark
	// cloning against an EMPTY reference transcript, which is exactly the
	// text/semantic-token misalignment the transcript exists to prevent.
	//
	// The STORED clip is transcribed, never the user's original file: the text
	// must describe exactly the audio the engine will hear, and the stored clip is
	// the trimmed, normalized one.
	useEffect(() => {
		if (
			!needsReferenceTranscript({
				busy: cloneBusy,
				cloneRefText,
				needsRefText,
				ttsEnabled: enabled,
				voice,
			})
		) {
			return;
		}
		// One attempt per clip: a failed transcription (or a field the user then
		// cleared by hand) must not spin in a retry loop.
		if (transcribedClipRef.current === voice) {
			return;
		}
		transcribedClipRef.current = voice;
		const clipPath = voice;
		setCloneBusy(true);
		void (async () => {
			try {
				const transcript = await commands.ttsTranscribeReference(clipPath);
				// The clip may have been replaced while the STT model ran; a
				// transcript of the previous clip is worse than none at all.
				if (useSettingsStore.getState().settings.tts.voice !== clipPath) {
					return;
				}
				if (transcript.status === "error") {
					// The clip itself is fine — keep it and let the user type the
					// transcript rather than throwing the accepted audio away.
					setCloneError(transcript.error);
					return;
				}
				update({ cloneRefText: transcript.data.trim() });
			} finally {
				setCloneBusy(false);
			}
		})();
	}, [cloneBusy, cloneRefText, enabled, needsRefText, update, voice]);

	/** Commit an explicit clip list (drop target, or a removal's survivors). */
	const handleSetReferenceClips = (paths: readonly string[]): void => {
		void rebuildReferenceClips(paths);
	};

	/** Browse for more audio and APPEND it — a voice grows by adding clips, so
	 *  the caller hands over what it already has and the picker extends it. */
	const handleBrowseReferenceClips = (existing: readonly string[]): void => {
		void (async () => {
			const picked = await dialogOpenFiles([
				{ name: "Audio", extensions: [...CLONE_CLIP_EXTENSIONS] },
			]);
			if (picked.length === 0) {
				return;
			}
			await rebuildReferenceClips([...existing, ...picked]);
		})();
	};

	/** Drop the voice's audio and fall back to the engine's own first preset
	 *  voice (or, on a voice-design row, to its built-in voice). */
	const clearLiveVoice = (): void => {
		setCloneError(null);
		setClipReport(null);
		update(
			isVoiceDesignModel
				? { voice: "" }
				: { voice: catalog.voices[0]?.id ?? "", cloneRefText: "" },
		);
	};

	const handleVoiceChange = (nextVoice: string): void => {
		if (isCloningModel) {
			setClipReport(null);
			update({ voice: nextVoice });
			return;
		}
		if (isSupertonicModel) {
			update({ voice: nextVoice, lang: supertonicLanguage });
			previewVoice(nextVoice, supertonicLanguage);
			return;
		}
		const meta = catalog.voices.find((v) => v.id === nextVoice);
		const nextLang = meta?.language ?? deriveLanguage(nextVoice);
		update({ voice: nextVoice, lang: nextLang });
		previewVoice(nextVoice, nextLang);
	};

	// Voice-design prompt is stored (overloaded) in `voice`. Empty is allowed and
	// is the default (the model's built-in voice) — never coerce or reject it.
	const handleVoiceDesignPromptChange = (nextPrompt: string): void => {
		update({ voice: nextPrompt });
	};

	// The instruct is NOT the voice: rows carrying one (OmniVoice) also clone, so
	// `voice` already holds the reference-clip path and the instruction needs its
	// own field. Same editor component, different backing setting.
	const handleVoiceInstructChange = (nextInstruct: string): void => {
		update({ voiceInstruct: nextInstruct });
	};

	// ── Saved-voice library ───────────────────────────────────────────────
	const savedVoices = useVoiceLibraryStore((s) => s.voices);
	// What the library would capture right now. Only the CLIP path counts as a
	// clip: the report's seconds ride along when they describe this exact clip,
	// so a name saved today still shows its duration tomorrow.
	const clipReportMatches = clipReport?.path === voice;
	const referenceClip = {
		path: voiceIsClipPath ? voice : "",
		seconds: clipReportMatches ? clipReport.seconds : 0,
		trimmed: clipReportMatches && clipReport.trimmed,
	};
	// Prefer the cap the backend reported for THIS clip; fall back to the catalog
	// row (which is where that number came from) for the empty-state hint.
	const effectiveMaxRefSecs =
		(clipReportMatches ? clipReport.maxSecs : 0) || maxRefClipSecs;
	// The parts behind the live clip: the backend's report for this exact path when
	// there is one, and otherwise the library row that stores the same combined
	// clip — the only place the real part list survives a restart, since
	// `settings.tts.voice` is a single path by design.
	//
	// The row lookup is not a guess and not a duplicate of `VoiceField`'s: the
	// parts are what a voice can be RE-WELDED from, and re-welding is how one
	// upload serves models with different reference budgets. Without it a voice
	// restored on launch would be stuck at whatever length it was last built for.
	const storedLiveVoice =
		referenceClip.path.length > 0
			? (savedVoices.find(
					(entry) =>
						entry.kind === "clip" && entry.value === referenceClip.path,
				) ?? null)
			: null;
	const liveClips: SavedVoiceClip[] = clipReportMatches
		? clipReport.parts
		: (storedLiveVoice?.clips ?? []);
	// Which budget the live combined clip was welded under. `0` = unknown, which
	// asks for one rebuild rather than assuming the clip suits this model.
	const liveMaxSecs = clipReportMatches
		? clipReport.maxSecs
		: (storedLiveVoice?.maxSecs ?? 0);
	const liveSavedVoice: SavedVoiceValue = isVoiceDesignModel
		? {
				clips: [],
				kind: "design",
				maxSecs: 0,
				value: voice,
				refText: "",
				seconds: 0,
			}
		: {
				clips: liveClips,
				kind: "clip",
				maxSecs: liveMaxSecs,
				value: referenceClip.path,
				refText: needsRefText ? cloneRefText : "",
				seconds: referenceClip.seconds,
			};

	/**
	 * Delete a voice for good: its stored clips leave the disk, its library row
	 * (if it has one) leaves the list, and the live settings are cleared when the
	 * voice being deleted is the one currently in effect.
	 *
	 * Until this existed nothing ever removed a reference clip — the managed
	 * folder only grew, and deleting the clip left the library row behind
	 * offering to restore audio that was gone.
	 *
	 * `entry` is `null` when the live voice was never named, which is exactly the
	 * "removed the last clip of an unsaved voice" case: there is nothing to
	 * unlist, and the live settings are unconditionally what is being discarded.
	 *
	 * Only the files NOTHING else still names are unlinked. Stored clip names are
	 * content-addressed, so two voices built from the same take share one managed
	 * file (and a single-part voice's combined clip IS that part) — deleting the
	 * first voice must not pull the audio out from under the second.
	 */
	const discardVoice = (input: {
		entry: SavedVoice | null;
		/** Every stored file the voice owns — its parts AND its combined clip. */
		paths: readonly string[];
	}): void => {
		// Unlist FIRST, so the survivor scan below cannot count the row being
		// deleted as a reason to keep its own files alive.
		if (input.entry) {
			useVoiceLibraryStore.getState().removeVoice(input.entry.id);
		}
		// Read the live value at call time: the row being deleted may not be the one
		// in effect, and a stale render-scope copy would clear the wrong voice.
		const liveValue = useSettingsStore.getState().settings.tts.voice;
		const discardingLive =
			input.entry === null || input.entry.value === liveValue;
		const retained = referencedClipPaths(
			useVoiceLibraryStore.getState().voices,
		);
		if (!discardingLive) {
			// The voice still in effect keeps its audio even when the deleted row
			// listed the same parts — it may not even have a library row yet (a clip
			// added to a restored voice moves the live value off that row).
			for (const path of referencedClipPaths([liveSavedVoice])) {
				retained.add(path);
			}
		}
		const paths = input.paths
			.map((path) => path.trim())
			.filter((path) => path.length > 0 && !retained.has(path));
		if (paths.length > 0) {
			// Fire-and-forget: the record is going away either way, and the command
			// is deliberately total (it skips what it cannot confine and treats an
			// already-missing file as success), so there is nothing to recover from.
			void commands.ttsDeleteReferenceClips([...new Set(paths)]);
		}
		if (discardingLive) {
			clearLiveVoice();
		}
	};

	/** Adopt a voice's cached combined clip as-is. */
	const adoptVoiceAsStored = (entry: SavedVoiceValue): void => {
		setClipReport(
			entry.value
				? {
						maxSecs: entry.maxSecs,
						parts: entry.clips,
						path: entry.value,
						seconds: entry.seconds,
						trimmed: false,
					}
				: null,
		);
		update({ voice: entry.value, cloneRefText: entry.refText });
	};

	/**
	 * Re-weld a voice's stored parts for the SELECTED model's reference budget.
	 *
	 * This is what makes one upload serve every cloning engine. The parts live on
	 * disk at the widest budget; only the combined clip is model-specific, and the
	 * engines' budgets differ six-fold (OmniVoice 5 s, everything else 30 s). So a
	 * voice cloned under Chatterbox is offered under OmniVoice too — it is simply
	 * welded again from audio that is already there, instead of the user being
	 * asked for the same recordings a second time.
	 *
	 * The library row is updated in place with the clip that now exists, so the
	 * voice does not read as "modified" purely because a different model is
	 * selected — nothing about what the user authored has changed.
	 *
	 * A failed re-weld falls back to the cached clip rather than leaving the voice
	 * unselectable: audio trimmed for the wrong budget still speaks, and the error
	 * is surfaced on the card.
	 */
	const reweldVoiceForModel = async (entry: SavedVoiceValue): Promise<void> => {
		// The cached combined clip this re-weld replaces. Its PARTS are the build's
		// own input and come back in the report, so they are never candidates; only
		// the old cap-keyed combination can be left stranded.
		const superseded = [...referencedClipPaths([entry])];
		setCloneBusy(true);
		try {
			const built = await commands.ttsBuildReference(
				entry.clips.map((part) => part.path),
			);
			if (built.status === "error") {
				setCloneError(built.error);
				adoptVoiceAsStored(entry);
				return;
			}
			const { maxSecs, parts, seconds, storedPath, trimmed } = built.data;
			const clips: SavedVoiceClip[] = parts.map((part) => ({
				name: part.name,
				path: part.storedPath,
				seconds: part.seconds,
			}));
			setClipReport({
				maxSecs,
				parts: clips,
				path: storedPath,
				seconds,
				trimmed,
			});
			update({ voice: storedPath, cloneRefText: entry.refText });
			// Read at call time: the re-weld is async and the row may have been
			// renamed, reordered or deleted while the backend worked.
			const library = useVoiceLibraryStore.getState();
			const row = library.voices.find(
				(saved) => saved.kind === "clip" && saved.value === entry.value,
			);
			const next: SavedVoiceValue = {
				clips,
				kind: "clip",
				maxSecs,
				refText: entry.refText,
				seconds,
				value: storedPath,
			};
			if (row) {
				library.updateVoice(row.id, next);
			}
			// AFTER the row is re-pointed, never before: while it still names the old
			// combined clip, that clip is legitimately referenced and must survive.
			sweepSupersededClips(superseded, next);
		} catch {
			setCloneError(t("voiceBuildFailed"));
			adoptVoiceAsStored(entry);
		} finally {
			setCloneBusy(false);
		}
	};

	/** Restore a named voice into the live settings. The saved `seconds` and
	 *  `clips` are re-adopted as a report so the card keeps showing the voice's
	 *  duration and its parts; neither is re-derived, which would mean decoding
	 *  the audio again — unless this model's reference budget differs from the one
	 *  the clip was welded for, in which case re-welding is exactly the point. */
	const applySavedVoice = (entry: SavedVoiceValue): void => {
		setCloneError(null);
		// The live voice is about to be replaced, so whatever it owned that no saved
		// row — nor the entry being adopted — still names is now garbage. The common
		// case is an UNSAVED rebuild: its combined clip was only ever referenced by
		// the live settings, and reverting is precisely the act that abandons it.
		// A live voice that does have a row keeps everything, because the row names it.
		const superseded = [...referencedClipPaths([liveSavedVoice])];
		if (entry.kind === "design") {
			setClipReport(null);
			update({ voice: entry.value });
			sweepSupersededClips(superseded, entry);
			return;
		}
		if (voiceNeedsRebuild(entry, maxRefClipSecs)) {
			// Re-welding does its own, more precise sweep once the new clip exists.
			void reweldVoiceForModel(entry);
			return;
		}
		adoptVoiceAsStored(entry);
		sweepSupersededClips(superseded, entry);
	};

	/**
	 * Overwrite a saved row with the live voice (the dirty row's Save action).
	 *
	 * That row was the only thing still keeping its previous combined clip alive —
	 * a rebuild deliberately leaves the old file alone precisely BECAUSE the row
	 * still names it — so re-pointing the row is what finally strands it. Without
	 * this the folder gained one orphaned WAV per edit of a saved voice.
	 *
	 * Sweep AFTER the write, never before: while the row still names the old clip
	 * it is legitimately referenced and must survive.
	 */
	const overwriteSavedVoice = (id: string, next: SavedVoiceValue): void => {
		const library = useVoiceLibraryStore.getState();
		const superseded = [
			...referencedClipPaths(library.voices.filter((saved) => saved.id === id)),
		];
		library.updateVoice(id, next);
		sweepSupersededClips(superseded, next);
	};

	// A model switch changes the reference budget under a voice that is already in
	// effect — nobody re-picked it, so nothing above runs. Without this, selecting
	// OmniVoice while a 30 s voice is live hands its refinement step six times the
	// reference frames it was measured for, and switching back leaves the 30 s
	// engine cloning from the five seconds OmniVoice cut it down to.
	//
	// Guarded on (model, clip) so a re-weld cannot re-trigger itself: the rebuild
	// changes `voice`, which re-runs this effect against a clip that now matches.
	const reweldGuardRef = useRef("");
	useEffect(() => {
		if (!(isCloningModel && voiceIsClipPath) || cloneBusy) {
			return;
		}
		if (!voiceNeedsRebuild(liveSavedVoice, maxRefClipSecs)) {
			return;
		}
		const guard = `${model}|${voice}|${maxRefClipSecs}`;
		if (reweldGuardRef.current === guard) {
			return;
		}
		reweldGuardRef.current = guard;
		void reweldVoiceForModel(liveSavedVoice);
	}, [
		cloneBusy,
		isCloningModel,
		liveSavedVoice,
		maxRefClipSecs,
		model,
		voice,
		voiceIsClipPath,
	]);

	// "A Batman-like voice" → a real voice-design instruct, via the configured
	// post-processing LLM. Handed to the dialog ONLY when that pipeline can
	// actually run (`llm.dictation.enabled` + a configured model, exactly the
	// backend's `post_processing_ready`), so the affordance is never a button
	// that exists only to report it can't work. The backend already clips the
	// answer to the model's budget; the field clamps again defensively.
	const generateVoiceDesignPrompt = async (
		description: string,
	): Promise<string> => {
		const res = await commands.generateVoiceDesignPrompt(description);
		if (res.status === "error") {
			throw new Error(res.error);
		}
		return res.data;
	};

	const handleInlineTagsChange = (next: boolean): void => {
		update({ inlineTags: next });
	};

	const handleLanguageChange = (nextLang: string): void => {
		update({ lang: nextLang });
	};

	const handleSpeedChange = (next: number): void => {
		update({ speed: isSupertonicModel ? clampSupertonicSpeed(next) : next });
	};

	const handleSpeedReset = (): void => {
		update({ speed: DEFAULT_SETTINGS.tts.speed });
	};

	const voicePlaceholder =
		catalog.voices.length === 0
			? t("noVoicesYet")
			: isSupertonicModel
				? "10 style voices; choose the speech language separately."
				: t("voiceCaption");

	const installing =
		!isCloud && (installPhase !== null || downloadProgress.active);

	const handleCancelInstall = (): void => {
		ttsInstallCancel();
		update({ enabled: false });
	};

	const handleEnabledToggle = (next: boolean): void => {
		if (!next) {
			if (isCloud) {
				update({ enabled: false });
				return;
			}
			// Lock in the same click (mirror of `markWarmupPending` on the enable
			// edge): the backend's `tts:unload-status` ping only lands after an
			// IPC round-trip, and until it did the toggle sat interactive and then
			// flashed disabled for the tail of the drop — the turn-OFF flicker.
			// The `inProgress: false` ping (or the 15 s safety bound) releases it.
			// Strictly `source !== "cloud"` — the backend's unload edge keys off
			// the PERSISTED source, so a cloud-source-but-cloud-locked state
			// (frontend-effective local) emits no unload pings at all.
			if (tts?.source !== "cloud") {
				setUnloadingLocalModel(true);
			}
			handleLocalEnabledToggle(false);
			return;
		}
		if (isCloud) {
			update(buildTtsEnablePatch(hotkey, DEFAULT_SETTINGS.tts.hotkey));
			return;
		}
		if (selectedLocalModelCached || !cloudAllowed) {
			handleLocalEnabledToggle(true);
			return;
		}
		if (cachedLocalModel) {
			update({
				...buildTtsEnablePatch(hotkey, DEFAULT_SETTINGS.tts.hotkey),
				model: cachedLocalModel,
			});
			// Same immediate lock as the gate's cached-enable path: this commit
			// starts a local warm-up too, and the toggle must not sit ON and
			// interactive while the first install-status ping is in flight.
			markWarmupPending();
			return;
		}
		if (ttsStatesLoaded) {
			update({
				...buildTtsEnablePatch(hotkey, DEFAULT_SETTINGS.tts.hotkey),
				source: "cloud",
			});
			return;
		}
		handleLocalEnabledToggle(true);
	};

	const handleSourceChange = (next: "local" | "cloud"): void => {
		if (next === "cloud" || !enabled || !cloudAllowed) {
			update({ source: next });
			return;
		}
		if (selectedLocalModelCached) {
			update({ source: "local" });
			return;
		}
		if (cachedLocalModel) {
			update({ source: "local", model: cachedLocalModel });
			return;
		}
		useTtsModelPickerStore.getState().openFor(true, "local");
	};

	const cloudLockFooter = cloudLockFooterText(
		elevenVerified,
		cloud,
		tIntegrations("cloudDisabledHint"),
	);
	const sourceOpts: SwitcherOption<"local" | "cloud">[] = [
		{
			value: "local",
			label: tIntegrations("sourceLocal"),
			icon: AiComputerIcon,
		},
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

	return {
		t,
		tIntegrations,
		cloud,
		noVoiceAccess,
		elevenVerified,
		elevenCloudAllowed,
		openrouterConfigured,
		effectiveSource,
		isCloud,
		installError,
		retryInstall,
		enabled,
		model,
		voice,
		voiceDefault,
		supertonicLanguage,
		effectiveSpeed,
		ttsModels,
		ttsStatesById,
		currentTtsQuant,
		getTtsDownloadSnapshot,
		onTtsDownloadAction,
		openDetachedTtsPicker: (rect: DOMRect) =>
			openModelPickerAtRect(rect, { pickerKind: "tts" }),
		isSupertonicModel,
		isCloningModel,
		isVoiceDesignModel,
		voiceDesignMaxChars,
		maxRefClipSecs: effectiveMaxRefSecs,
		referenceClip,
		clonePresetOptions,
		liveSavedVoice,
		applySavedVoice,
		overwriteSavedVoice,
		handleSetReferenceClips,
		handleBrowseReferenceClips,
		discardVoice,
		// `undefined` — not a disabled handler — when post-processing can't run, so
		// the dialog omits the AI affordance entirely rather than rendering it dead.
		generateVoiceDesignPrompt: postProcessingReady
			? generateVoiceDesignPrompt
			: undefined,
		playback,
		isLoading,
		isSpeaking,
		previewVoiceId,
		errorReason,
		downloadProgress,
		voiceGroups,
		languageGroups,
		langForVoice,
		previewVoice,
		previewCloudVoice,
		previewOpenRouterVoice,
		handleModelChange,
		handleVoiceChange,
		handleVoiceDesignPromptChange,
		isVoiceInstructModel,
		voiceInstruct,
		handleVoiceInstructChange,
		// `undefined` — not a disabled row — for every engine without a tag
		// vocabulary, so the tab shows no dead capability the model can't perform.
		inlineTags: inlineTagsGate.supported
			? {
					blockedBy: inlineTagsGate.blockedBy,
					enabled: inlineTagsEnabled,
					onChange: handleInlineTagsChange,
					tagList: inlineTagsGate.tagList,
				}
			: undefined,
		needsRefText,
		requiresReferenceClip,
		cloneRefText,
		cloneBusy,
		cloneError,
		handleCloneRefTextChange,
		handleLanguageChange,
		handleSpeedChange,
		handleSpeedReset,
		voicePlaceholder,
		installing,
		unloadingLocalModel,
		handleCancelInstall,
		handleEnabledToggle,
		handleSourceChange,
		sourceOpts,
	};
}
