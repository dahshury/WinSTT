import {
	AiVoiceGeneratorIcon,
	AudioWave01Icon,
	MagicWand01Icon,
	Tick02Icon,
	Upload01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, useState } from "react";
import { useTranslations } from "use-intl";
import { SettingField } from "@/entities/setting";
import type { TranslateFn } from "@/shared/i18n/translation-types";
import { cn } from "@/shared/lib/cn";
import { surfaceClasses, useSurface } from "@/shared/lib/surface";
import { AutoTextarea } from "@/shared/ui/auto-textarea";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import {
	type CreatableComboboxItem,
	PresetNavCombobox,
} from "@/shared/ui/creatable-combobox";
import { IconButton } from "@/shared/ui/icon-button";
import type { SelectOption } from "@/shared/ui/select";
import { Spinner } from "@/shared/ui/spinner";
import { TextField } from "@/shared/ui/text-field";
import { clipBaseName, unmetClipRequirement } from "../lib/clone-voice";
import { useClipDrop } from "../lib/use-clip-drop";
import {
	projectedClipSeconds,
	removeClipAt,
	type SavedVoice,
	type SavedVoiceClip,
	type SavedVoiceValue,
	savedVoiceMatches,
	useVoiceLibraryStore,
} from "../model/voice-library";
import { TtsPreviewButton } from "./TtsPreviewButton";
import { VoiceCapacityMeter, VoiceClipList } from "./VoiceClipList";

/** One glyph per stored half of the overloaded `voice` field, so a row reads as
 *  "a clip" or "a written description" before its name is parsed. */
function iconForVoiceKind(kind: SavedVoice["kind"]) {
	return kind === "clip" ? AudioWave01Icon : MagicWand01Icon;
}

/**
 * How a built-in voice id is written inside the shared picker.
 *
 * ONE combobox now offers two populations that are stored in different places —
 * the engine's own preset voices (a catalog id, written to `settings.tts.voice`)
 * and the user's saved voices (a library row id). They are separate namespaces,
 * so a preset called `default` and a library id could otherwise collide and the
 * field would apply the wrong one; the prefix makes selection unambiguously
 * routable to `onPresetChange` or to `apply`.
 */
const BUILT_IN_PREFIX = "builtin:";

/** Section values for the two populations. */
const VOICE_GROUP_BUILT_IN = "builtin";
const VOICE_GROUP_SAVED = "saved";

function isBuiltInVoiceId(id: string): boolean {
	return id.startsWith(BUILT_IN_PREFIX);
}

function builtInVoiceId(presetId: string): string {
	return `${BUILT_IN_PREFIX}${presetId}`;
}

function presetIdFromBuiltIn(id: string): string {
	return id.slice(BUILT_IN_PREFIX.length);
}

/** Cycle to the entry `offset` places away, wrapping. `startId` is the row the
 *  field is currently showing; when nothing is shown, stepping forward starts at
 *  the first entry and stepping back at the last. Pure so the wrap-around rule
 *  is unit-testable without a rendered combobox.
 *
 *  Takes plain ids rather than voices because the list it steps through spans
 *  BOTH populations now — the engine's built-in voices and the saved ones — and
 *  the arrows must walk everything the popup offers, in the order it offers it. */
export function stepVoiceId(
	ids: readonly string[],
	startId: string,
	offset: -1 | 1,
): string {
	if (ids.length < 2) {
		return "";
	}
	const current = ids.indexOf(startId);
	if (current < 0) {
		return (offset > 0 ? ids[0] : ids.at(-1)) ?? "";
	}
	return ids[(current + offset + ids.length) % ids.length] ?? "";
}

/**
 * The clips behind the voice currently in effect, best source first.
 *
 * Three sources, because the truth lives in a different place at each stage of a
 * voice's life:
 *  1. the backend's own report for this build — authoritative, and the only one
 *     that carries measured durations;
 *  2. the library row storing the same combined clip — the ONLY record that
 *     survives a restart, since `settings.tts.voice` is a single path by design;
 *  3. the combined path standing in for itself — a voice adopted before the
 *     library existed, or one never named. Listing it keeps the card honest
 *     (there IS audio) and keeps removal reachable.
 *
 * Exported for unit test; `VoiceField` is the only runtime caller.
 */
export function resolveVoiceClips(
	live: SavedVoiceValue,
	stored: SavedVoice | null,
): SavedVoiceClip[] {
	if (live.kind === "design" || live.value.trim().length === 0) {
		return [];
	}
	if (live.clips.length > 0) {
		return live.clips;
	}
	if (stored && stored.clips.length > 0) {
		return stored.clips;
	}
	return [
		{ name: clipBaseName(live.value), path: live.value, seconds: live.seconds },
	];
}

/** Everything the shared preview control needs to audition ONE voice id. Passed
 *  through rather than re-derived so playback state stays global — only the row
 *  matching `previewVoiceId` shows stop/spinner. */
export interface VoiceFieldPreview {
	activeRequestId: string | null;
	isLoading: boolean;
	isSpeaking: boolean;
	langForVoice: (voiceId: string) => string;
	onPreview: (voiceId: string, lang: string) => void;
	previewVoiceId: string | null;
}

/** Clip-side wiring. Absent on a voice-design row: a written prompt has no audio
 *  behind it, so that row gets the library combobox and nothing else. */
export interface VoiceFieldClip {
	/** Failure from the last build / transcribe attempt, already localized. */
	error: string | null;
	/** The model's reference budget in seconds (`maxRefClipSecs`). `0` = unknown. */
	maxSecs: number;
	/** This engine clones from clip + transcript (Spark), so the transcript is
	 *  part of the voice. */
	needsRefText: boolean;
	/** Browse for MORE audio; receives what the voice already holds so the picker
	 *  appends rather than replaces. */
	onBrowse: (existing: readonly string[]) => void;
	onPresetChange: (voiceId: string) => void;
	onRefTextChange: (next: string) => void;
	/** Re-state the voice's whole ordered clip list; the backend welds it into the
	 *  single combined file `settings.tts.voice` holds. */
	onSetClips: (paths: readonly string[]) => void;
	/** Audition the voice without leaving settings — the control the merged-away
	 *  voice dropdown used to carry in its trigger, kept here so a cloning engine
	 *  is not the one family that cannot hear its voice before using the hotkey. */
	preview: VoiceFieldPreview;
	/** The engine's built-in voices. Offered only while the voice has no audio,
	 *  since a clip overrides them. */
	presets: readonly SelectOption[];
	presetVoice: string;
	refText: string;
	/** This engine has NO unconditioned voice: without a clip (and, when
	 *  `needsRefText`, its transcript) synthesis ERRORS rather than falling back
	 *  to a preset. */
	requiresClip: boolean;
	/** The build ran past the cap and lost its tail. Stays true until the clips
	 *  change, because the user must not have to catch a toast to learn that. */
	trimmed: boolean;
}

export interface VoiceFieldProps {
	/** A build or an auto-transcription is running — the card locks. */
	busy: boolean;
	clip?: VoiceFieldClip | undefined;
	disabled?: boolean | undefined;
	/** The voice currently in effect, as it would be stored. Drives which row is
	 *  shown, whether that row is dirty, and what "create" would capture. */
	live: SavedVoiceValue;
	/** Restore a saved entry into the live settings. The caller owns the write
	 *  because the two halves land in different settings fields (`voice` and
	 *  `cloneRefText`). */
	onApply: (value: SavedVoiceValue) => void;
	/** Destroy a voice: unlist it, delete its stored audio, and clear the live
	 *  settings when it was the one in effect. `entry: null` = the live voice was
	 *  never named, so there is nothing to unlist. */
	onDiscard: (input: {
		entry: SavedVoice | null;
		paths: readonly string[];
	}) => void;
	/** Re-point a saved row at the live voice (the dirty row's Save action). The
	 *  caller owns the write because re-pointing the row strands the combined clip
	 *  it used to name, which has to be swept in the same breath. */
	onOverwrite: (id: string, value: SavedVoiceValue) => void;
	t: TranslateFn;
}

/**
 * THE voice control: one named voice, the clips it was cloned from, and their
 * transcript — a single row plus a card that is always open beneath it.
 *
 * This replaces three separate settings rows ("Saved voices", "Reference clip",
 * "Reference transcript") that were three views of ONE object. The unit the user
 * thinks in is the voice, so the unit the UI edits is the voice: naming it,
 * feeding it audio and correcting its transcript are all the same card, and
 * dropping its last clip is the same act as deleting it.
 *
 * The seam underneath is unchanged: `settings.tts.voice` still holds ONE path —
 * the COMBINED clip the backend welds the parts into — so no engine can tell a
 * multi-clip voice from a single-clip one. Multi-clip lives entirely here and in
 * the library.
 */
export function VoiceField({
	busy,
	clip,
	disabled = false,
	live,
	onApply,
	onDiscard,
	onOverwrite,
	t,
}: VoiceFieldProps) {
	const tCommon = useTranslations("common");
	const nameId = useId();
	const transcriptId = useId();
	const [draftName, setDraftName] = useState("");
	// Two different destructive confirmations, one pending slot: they can never
	// overlap (both are modal) and both end in the same `onDiscard`.
	const [pendingDelete, setPendingDelete] = useState<SavedVoice | null>(null);
	const [pendingLastClip, setPendingLastClip] = useState(false);

	const voices = useVoiceLibraryStore((s) => s.voices);
	const activeVoiceId = useVoiceLibraryStore((s) => s.activeVoiceId);
	const setActiveVoice = useVoiceLibraryStore((s) => s.setActiveVoice);
	const saveVoice = useVoiceLibraryStore((s) => s.saveVoice);
	const moveVoice = useVoiceLibraryStore((s) => s.moveVoice);
	const persistFailed = useVoiceLibraryStore((s) => s.persistFailed);

	// The card sits one step above the settings surface, like every other input
	// in this tab.
	const cardLevel = Math.min(useSurface() + 1, 8);

	// Only the half of the library the SELECTED engine can consume is offered.
	// The store is one flat list shared by both engine families, and the two kinds
	// are not interchangeable: restoring a `clip` while a voice-design model is
	// selected would hand the engine a `.wav` PATH as the voice DESCRIPTION, and
	// restoring a `design` prompt on a cloning model writes prose into a field the
	// engine tries to open as a file (it silently falls back to its bundled
	// voice, so the row looks applied but did nothing). Entries of the other kind
	// stay in storage for when that model is selected again.
	const visible = voices.filter((voice) => voice.kind === live.kind);
	const matched = visible.find((voice) => savedVoiceMatches(voice, live));
	const active = visible.find((voice) => voice.id === activeVoiceId) ?? null;
	const activeModified = active !== null && !savedVoiceMatches(active, live);
	// Keep the shown row and the dirty actions together: once the user edits the
	// applied voice the exact match disappears, and a blank field with Save/Reset
	// hanging off an invisible row is unreadable. Fall back to the active row.
	const shownId = matched?.id ?? (activeModified ? (active?.id ?? "") : "");
	// The row that stores this exact combined clip, whether or not it is the one
	// the combobox is showing — it is where the part list survives a restart.
	const stored =
		live.value.trim().length > 0
			? (visible.find((voice) => voice.value === live.value) ?? null)
			: null;
	const clips = resolveVoiceClips(live, stored);
	// Everything the library writes carries the RESOLVED clip list, never the
	// possibly-empty live one: saving a voice restored from a previous session
	// must not wipe the part history that made it rebuildable.
	const liveWithClips: SavedVoiceValue = { ...live, clips };
	const clipPaths = clips.map((entry) => entry.path);
	const hasAudio = clips.length > 0;

	// The engine's OWN voices, offered in the same picker as the saved ones.
	//
	// Suppressed entirely for a `requiresClip` engine (Audio8): its catalog row
	// carries one sentinel entry that is not a voice at all — selecting it is a
	// synthesis error — so a model that ships nothing must offer nothing rather
	// than a built-in section holding a single unusable row.
	const builtIns =
		clip && !clip.requiresClip
			? clip.presets.map((preset) => ({
					id: builtInVoiceId(preset.id),
					label: preset.label,
					icon: AiVoiceGeneratorIcon,
					group: VOICE_GROUP_BUILT_IN,
					// Supplied by the model, not the user: there is no order to save.
					reorderable: false,
				}))
			: [];
	// With no clip the engine speaks in one of its own voices, so THAT is what the
	// field is showing — `live.value` holds a preset id in that state, not a path.
	const usingBuiltIn = live.kind === "clip" && !hasAudio && builtIns.length > 0;

	// Naming an empty voice would save a row that restores nothing, so the name
	// affordances stay inert until there is something worth capturing. For a clip
	// voice that means real AUDIO, not merely a non-empty `voice` field: with no
	// clip that field holds the engine's preset id, and naming it would save a
	// library row that restores one of the model's own voices under a second name.
	const canCreate =
		live.kind === "design" ? live.value.trim().length > 0 : hasAudio;
	// Inert only when there is BOTH nothing to pick and nothing to name. The
	// library is creatable-on-type, so an empty list is NOT on its own a reason to
	// disable: that is exactly the state in which the user saves their first
	// voice, and locking the field would make the feature unreachable.
	const inert = visible.length === 0 && builtIns.length === 0 && !canCreate;
	// The in-card name box and its confirm button lock together — a build in
	// flight is about to replace the very clips a name would capture.
	const nameInert = !canCreate || busy || disabled;

	const addClips = (paths: readonly string[]): void => {
		// A drop that lands mid-build would start a second weld against a clip list
		// the first one is about to replace. The browse button is `disabled` for the
		// same reason; a drop target cannot be, so it checks here.
		if (busy || disabled) {
			return;
		}
		clip?.onSetClips([...clipPaths, ...paths]);
	};
	const drop = useClipDrop({ onPick: addClips, t });
	// `useClipDrop`'s error is sticky by design — it has to survive the re-render
	// the drop itself causes — so something has to retire it, and nothing did. A
	// refusal shown under a voice that has since BUILT successfully, or under a
	// DIFFERENT voice the user then selected, is a lie about the voice on screen;
	// both of those are exactly a change of the value in effect. Adjusted during
	// render (React's own "reset state when a prop changes" pattern) rather than in
	// an effect, so the stale text never paints even once.
	const voiceScope = `${live.kind}:${live.value}`;
	const [dropErrorScope, setDropErrorScope] = useState(voiceScope);
	if (dropErrorScope !== voiceScope) {
		setDropErrorScope(voiceScope);
		drop.resetError();
	}

	const apply = (id: string): void => {
		// Looked up in the VISIBLE subset, so no code path (select, revert, ‹ ›)
		// can reach a row of the other kind.
		const entry = visible.find((voice) => voice.id === id);
		if (!entry) {
			return;
		}
		onApply({
			clips: entry.clips,
			kind: entry.kind,
			maxSecs: entry.maxSecs,
			value: entry.value,
			refText: entry.refText,
			seconds: entry.seconds,
		});
		setActiveVoice(id);
	};

	const createVoice = (name: string): void => {
		const trimmed = name.trim();
		if (trimmed && canCreate) {
			saveVoice(trimmed, liveWithClips);
			setDraftName("");
		}
	};

	const handleRemoveClip = (index: number): void => {
		// A voice needs audio, so dropping its only clip IS deleting the voice —
		// the user's explicit rule, and the reason this asks first.
		if (clips.length <= 1) {
			setPendingLastClip(true);
			return;
		}
		clip?.onSetClips(removeClipAt(clips, index).map((entry) => entry.path));
	};

	/** Every stored file `entry` owns: its parts AND the combined clip welded from
	 *  them. Both must leave the disk — until this shipped, neither ever did.
	 *
	 *  A `design` voice owns no audio at all: its `value` is prose, and handing
	 *  that to a delete-clips call would ask the backend to unlink a sentence. */
	const filesOf = (entry: SavedVoice | null): string[] => {
		if ((entry?.kind ?? live.kind) === "design") {
			return [];
		}
		return entry
			? [...entry.clips.map((c) => c.path), entry.value]
			: [...clipPaths, live.value];
	};

	// ONE list, two populations, marked apart by section AND by glyph: the voices
	// the model ships, and the voices the user made. Before this they lived in two
	// separate controls — a library combobox above the card and a preset dropdown
	// inside it that appeared only while the voice had no audio — so on a cloning
	// engine the built-in voice became unreachable the moment a clip existed.
	const savedItems: CreatableComboboxItem[] = visible.map((voice) => ({
		id: voice.id,
		label: voice.name,
		icon: iconForVoiceKind(voice.kind),
		group: VOICE_GROUP_SAVED,
		deletable: true,
		modified: activeModified && voice.id === shownId,
	}));
	const items: CreatableComboboxItem[] = [...builtIns, ...savedItems];
	// Sections only exist once there are two populations to tell apart. A
	// voice-design row (and a clone-only engine) has just the saved list, and a
	// lone "My voices" header over it would be chrome explaining nothing.
	const groups =
		builtIns.length > 0
			? [
					{ label: t("voiceGroupBuiltIn"), value: VOICE_GROUP_BUILT_IN },
					{ label: t("voiceGroupSaved"), value: VOICE_GROUP_SAVED },
				]
			: undefined;
	const selectedId = usingBuiltIn
		? builtInVoiceId(clip?.presetVoice ?? "")
		: shownId;

	/** Route a selection to whichever population owns it. */
	const selectVoice = (id: string): void => {
		if (isBuiltInVoiceId(id)) {
			// Writes the preset id straight into `settings.tts.voice`, which is what
			// drops the reference clip: one field, and the engine reads whatever is
			// in it.
			clip?.onPresetChange(presetIdFromBuiltIn(id));
			setActiveVoice(null);
			return;
		}
		apply(id);
	};

	// What a preview would actually speak: the clip the engine clones from, or the
	// preset standing in for it while there is no audio. Empty means there is
	// nothing to audition yet (an engine with no built-in voice, before its first
	// clip), so no control is offered rather than one that can only error.
	const previewTarget = clip
		? live.value.trim() || clip.presetVoice.trim()
		: "";

	const message = clip ? (clip.error ?? (drop.dropError || null)) : null;
	const unmet = clip
		? unmetClipRequirement({
				hasClip: hasAudio,
				needsRefText: clip.needsRefText,
				refText: clip.refText,
				requiresClip: clip.requiresClip,
			})
		: null;
	// The failure/requirement line, as ONE persistent live region rather than a
	// notice mounted per state — see the region itself for why.
	//
	// A real failure suppresses the "this engine still owes you a clip/transcript"
	// warning so the two never stack: the user has done nothing wrong in the
	// second case, and stacking them reads as two problems where there is one.
	const notice: {
		testId: string | undefined;
		text: string;
		tone: "error" | "warning";
	} | null = message
		? { testId: undefined, text: message, tone: "error" }
		: unmet
			? {
					testId: "clone-clip-required-warning",
					text:
						unmet === "clip"
							? t("cloneClipRequired")
							: t("cloneClipRequiredRefText"),
					tone: "warning",
				}
			: null;
	// The trim report is a separate FACT, not an alternative to the line above — a
	// build can both trim and then fail — so it keeps its own region instead of
	// taking turns in one.
	const trimNotice =
		clip?.trimmed && clip.maxSecs > 0
			? t("cloneClipTrimmed", { seconds: clip.maxSecs })
			: "";

	return (
		<div className="flex flex-col">
			<SettingField
				{...(inert ? { caption: t("voiceLibraryInertCaption") } : {})}
				// The card below is part of this row, so the row's own bottom padding
				// would open a gap the divider hairline doesn't explain.
				{...(clip ? { className: "pb-0" } : {})}
				error={
					persistFailed === null ? undefined : t("voiceLibraryPersistFailed")
				}
				hideReset
				label={t("voiceFieldLabel")}
				layout="row"
				tooltip={t("voiceFieldTooltip")}
			>
				{/* The audition control sits beside the name, where the voice dropdown
				    it replaced used to carry it in its trigger. The pair keeps the
				    `w-52` every other control in this tab occupies, so the button is
				    taken out of the combobox's width rather than added to the row's. */}
				<div className="flex w-52 min-w-0 items-center gap-1">
					<PresetNavCombobox
						className="min-w-0 flex-1"
						disabled={disabled || inert}
						groups={groups}
						items={items}
						labels={{
							create: (name) => t("voiceLibraryCreate", { name }),
							delete: t("voiceLibraryDelete"),
							empty: t("voiceLibraryEmpty"),
							group: t("voiceLibraryNav"),
							next: t("voiceLibraryNext"),
							placeholder: t("voiceLibraryPlaceholder"),
							previous: t("voiceLibraryPrevious"),
							reorder: (item) => t("voiceLibraryReorder", { name: item.label }),
							reset: t("voiceLibraryResetAction"),
							save: t("voiceLibrarySaveAction"),
						}}
						onCreate={canCreate ? createVoice : undefined}
						// Deleting a voice destroys audio on disk, so it asks first — and
						// then really deletes, instead of leaving a row behind offering to
						// restore a clip that is gone.
						onDelete={(id) =>
							setPendingDelete(visible.find((voice) => voice.id === id) ?? null)
						}
						onReorder={moveVoice}
						onReset={apply}
						onSave={(id) => onOverwrite(id, liveWithClips)}
						onSelect={selectVoice}
						onStep={(offset) => {
							const nextId = stepVoiceId(
								items.map((item) => item.id),
								selectedId,
								offset,
							);
							if (nextId) {
								selectVoice(nextId);
							}
						}}
						value={selectedId}
					/>
					{clip && previewTarget ? (
						<TtsPreviewButton
							activeRequestId={clip.preview.activeRequestId}
							compact
							isLoading={clip.preview.isLoading}
							isSpeaking={clip.preview.isSpeaking}
							langForVoice={clip.preview.langForVoice}
							previewVoice={clip.preview.onPreview}
							previewVoiceId={clip.preview.previewVoiceId}
							t={t}
							targetVoiceId={previewTarget}
						/>
					) : null}
				</div>
			</SettingField>
			{clip ? (
				// ALWAYS OPEN — a grouped region belonging to the row above, not a
				// disclosure: there is nothing to click to reveal it, and nothing about
				// the selected voice is ever hidden behind a twisty.
				<div
					aria-label={t("voiceFieldLabel")}
					className={cn(
						"mb-3.5 flex flex-col gap-2.5 rounded-lg px-2.5 py-2.5 ring-1 ring-divider-strong ring-inset transition-[box-shadow] duration-200 ease-out",
						surfaceClasses(cardLevel),
						// Drag feedback stays grayscale — the card edge brightens to a
						// neutral ring. No accent, no dashed outline.
						drop.dragOver && "ring-foreground/30",
					)}
					data-testid="voice-card"
					onDragLeave={drop.handlers.onDragLeave}
					onDragOver={drop.handlers.onDragOver}
					onDrop={drop.handlers.onDrop}
					role="group"
				>
					{hasAudio ? (
						<>
							<VoiceCapacityMeter
								clipCount={clips.length}
								maxSecs={clip.maxSecs}
								t={t}
								// The GAP-INCLUSIVE total: the backend's cap applies to the
								// parts plus the silence welded between them, so a meter fed
								// the bare sum promises room the weld will not honour.
								usedSecs={projectedClipSeconds(clips)}
							/>
							<VoiceClipList
								busy={busy}
								clips={clips}
								onRemove={handleRemoveClip}
								t={t}
							/>
						</>
					) : (
						<div className="flex flex-col gap-0.5">
							<p className="font-medium text-body text-foreground">
								{t("voiceEmptyTitle")}
							</p>
							<p className="text-2xs text-foreground-muted leading-relaxed">
								{t("voiceEmptyBody")}
							</p>
						</div>
					)}
					{/* ONE affordance for both gestures: the surrounding card is the drop
					    target and this button is its click half, so "drop audio here, or
					    browse" is literally the same control.

					    Deliberately UNLABELLED: the accessible name falls back to the
					    button's own text, which is the label the user reads. An
					    `aria-label` here shared no word with that text — a WCAG 2.5.3
					    Label-in-Name failure, so "drop audio here" was not a phrase voice
					    control could act on — and it stayed frozen at "Add clip" while the
					    visible text swapped to "Preparing audio…". Falling back keeps the
					    two in step by construction. */}
					<button
						className="flex w-full min-w-0 cursor-pointer items-center gap-2 border-none bg-transparent p-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1 disabled:cursor-not-allowed"
						disabled={busy || disabled}
						onClick={() => clip.onBrowse(clipPaths)}
						type="button"
					>
						{busy ? (
							<Spinner className="size-4 shrink-0 border" />
						) : (
							<HugeiconsIcon
								aria-hidden="true"
								className="size-4 shrink-0 text-foreground-muted"
								icon={Upload01Icon}
							/>
						)}
						<span className="min-w-0 flex-1 text-body-sm text-foreground-muted">
							{busy ? t("voiceBuilding") : t("voiceDropClips")}
						</span>
					</button>
					{/* TWO PERSISTENT live regions, never conditionally mounted.
					    A live region is only announced when its CONTENTS change while it
					    is already in the accessibility tree — mounting a fresh element
					    that arrives with its text already in it announces nothing, which
					    is what these notices used to do. So the elements are permanent and
					    the text takes turns inside them.

					    `sr-only` while empty rather than unmounted: it is
					    position-absolute, so an empty region is out of flow and adds no
					    gap to the card, while still being present for the swap.

					    Both are `status` (polite). A single element cannot flip reliably
					    between polite and assertive at the same moment its text changes,
					    and this card is the surface the user is already looking at. */}
					<p
						className={cn(
							"text-2xs text-warning leading-relaxed",
							trimNotice ? "" : "sr-only",
						)}
						data-testid="voice-trim-notice"
						role="status"
					>
						{trimNotice}
					</p>
					<p
						className={cn(
							"text-2xs leading-relaxed",
							notice?.tone === "error" ? "text-error" : "text-warning",
							notice ? "" : "sr-only",
						)}
						// The unmet-requirement warning keeps its own hook so a test can
						// still assert it is NOT the notice being shown.
						data-testid={notice?.testId ?? "voice-notice"}
						role="status"
					>
						{notice?.text ?? ""}
					</p>
					{/* The engine's built-in voices used to live HERE, in a second dropdown
					    that only appeared while the voice had no audio. They are rows in
					    the picker above now — one control for "which voice", whether that
					    voice ships with the model or was cloned — so a built-in stays
					    reachable after a clip exists, and this card is only ever about the
					    clips. */}
					{/* Name + audio in the SAME card: creating a voice is one act, so the
					    name never lives a row away from the clips it belongs to. It
					    disappears once this audio is in the library — from then on the
					    combobox owns the name, and a merely EDITED voice (a corrected
					    transcript) offers Save/Reset there rather than a second name
					    box. */}
					{stored ? null : (
						<div className="flex flex-col gap-1">
							<label
								className="font-medium text-2xs text-foreground-muted"
								htmlFor={nameId}
							>
								{t("voiceNamePlaceholder")}
							</label>
							{/* Three ways to commit, because this is the primary path through
							    the card and an Enter-only field silently threw the name away
							    for everyone who typed it and clicked elsewhere. Blur is the
							    one that catches that; the button is the one that is VISIBLE,
							    so the gesture doesn't have to be guessed at.

							    Escape abandons: it empties the draft, and the blur that
							    follows therefore has nothing left to commit. Deliberately not
							    `preventDefault`ed — whatever Escape means to the surrounding
							    settings surface still applies. */}
							<div className="flex min-w-0 items-center gap-1">
								<TextField
									className="min-w-0 flex-1"
									dir="auto"
									disabled={nameInert}
									id={nameId}
									onBlur={() => createVoice(draftName)}
									onChange={(e) => setDraftName(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											e.preventDefault();
											createVoice(draftName);
											return;
										}
										if (e.key === "Escape") {
											setDraftName("");
										}
									}}
									placeholder={t("voiceNamePlaceholder")}
									value={draftName}
								/>
								<IconButton
									aria-label={t("voiceLibraryCreate", {
										name: draftName.trim(),
									})}
									disabled={nameInert || draftName.trim().length === 0}
									icon={<HugeiconsIcon icon={Tick02Icon} size={14} />}
									onClick={() => createVoice(draftName)}
								/>
							</div>
						</div>
					)}
					{clip.needsRefText && hasAudio ? (
						<div className="flex flex-col gap-1">
							<label
								className="font-medium text-2xs text-foreground-muted"
								htmlFor={transcriptId}
							>
								{t("voiceTranscriptLabel")}
							</label>
							{/* The shared auto-growing textarea: the transcript is one or two
							    sentences for a short clip and a paragraph for a welded one,
							    and a fixed box (or a resize grip the user has to drag) makes
							    the card wrong at both ends. */}
							<AutoTextarea
								disabled={busy || disabled}
								id={transcriptId}
								maxRows={8}
								minRows={2}
								onChange={(e) => clip.onRefTextChange(e.target.value)}
								placeholder={
									busy ? t("cloneRefTranscribing") : t("cloneRefPlaceholder")
								}
								value={clip.refText}
							/>
							<p className="text-2xs text-foreground-muted leading-relaxed">
								{t("cloneRefHint")}
							</p>
						</div>
					) : null}
				</div>
			) : null}
			{/* NAMED, both halves. A library of voices is a list of names, and the
			    delete affordance is reached from a popup row — so a confirmation that
			    only says "this voice" asks the user to trust that the click landed on
			    the row they meant, while destroying audio that cannot be recovered. */}
			<ConfirmDialog
				cancelLabel={tCommon("cancel")}
				confirmLabel={tCommon("delete")}
				description={t("voiceDeleteConfirmBody", {
					name: pendingDelete?.name ?? "",
				})}
				onConfirm={() => {
					if (pendingDelete) {
						onDiscard({
							entry: pendingDelete,
							paths: filesOf(pendingDelete),
						});
					}
				}}
				onOpenChange={(open) => {
					if (!open) {
						setPendingDelete(null);
					}
				}}
				open={pendingDelete !== null}
				title={t("voiceDeleteConfirmTitle", {
					name: pendingDelete?.name ?? "",
				})}
			/>
			<ConfirmDialog
				cancelLabel={tCommon("cancel")}
				confirmLabel={tCommon("delete")}
				description={t("voiceLastClipBody")}
				onConfirm={() =>
					// `stored` and not `matched`: the row that OWNS this audio is the one
					// holding the same combined path, even when the combobox is showing a
					// dirty sibling. `null` simply means the voice was never named.
					onDiscard({ entry: stored, paths: filesOf(stored) })
				}
				onOpenChange={(open) => {
					if (!open) {
						setPendingLastClip(false);
					}
				}}
				open={pendingLastClip}
				title={t("voiceLastClipTitle")}
			/>
		</div>
	);
}
