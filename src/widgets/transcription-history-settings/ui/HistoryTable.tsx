import { Button as BaseButton } from "@base-ui/react/button";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import {
  AiBrain02Icon,
  Clock01Icon,
  Copy01Icon,
  CopyCheckIcon,
  CpuIcon,
  DashboardSpeed02Icon,
  Delete02Icon,
  FlashIcon,
  HourglassIcon,
  PauseIcon,
  PlayIcon,
  StopWatchIcon,
  TextFontIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Fragment,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslations } from "use-intl";
import { VList } from "virtua";
import { useSettingsStore } from "@/entities/setting";
import {
  alignTranscriptionHistoryAudio,
  clipboardWriteText,
  deleteTranscriptionHistoryEntry,
  loadTranscriptionHistoryAudio,
  type WordTiming,
} from "@/shared/api/ipc-client";
import { Z_INDEX } from "@/shared/config/z-index";
import { cn } from "@/shared/lib/cn";
import {
  makerFromModelId,
  resolveProviderIcon,
} from "@/shared/lib/provider-icons";
import {
  SurfaceProvider,
  surfaceBg,
  surfaceClasses,
  surfaceHoverBg,
  useSurface,
} from "@/shared/lib/surface";
import { useLongPress } from "@/shared/lib/use-long-press";
import { ButtonGroup } from "@/shared/ui/button-group";
import { Spinner } from "@/shared/ui/spinner";
import { Tooltip } from "@/shared/ui/tooltip";
import {
  formatDuration,
  formatProcessingDuration,
  formatTokensPerSecond,
  formatWpm,
  wordsPerMinute,
} from "../lib/word-stats";
import {
  buildTranscriptDiff,
  type TranscriptDiffResult,
} from "../lib/transcript-diff";
import type { TranscriptionHistoryEntry } from "../model/history-store";

interface HistoryTableProps {
  emptyLabel?: string;
  entries: TranscriptionHistoryEntry[];
  onDeleteEntry?: (id: string) => void;
  showAudioStats?: boolean;
}

// Initial size estimate only — virtua re-measures every mounted row, so rows
// whose transcripts wrap to several lines self-correct. A short transcript card
// (body + recessed meta shelf) plus its inter-card padding lands around here.
const ROW_HEIGHT_HINT_PX = 120;
const COPY_FEEDBACK_MS = 1600;
// Cap the visible body so the table doesn't crowd out the rest of the panel;
// anything beyond this scrolls. Generous so the transcription list reads as a
// roomy, dedicated scroll region rather than a cramped box; the body
// deliberately omits `overscroll-contain` so reaching either end chains the
// wheel to the page's ScrollArea instead of trapping the scroll.
const MAX_BODY_HEIGHT_PX = 560;
// Below this row count, render directly (cheaper than VList's bookkeeping);
// at/above it, virtualize so the mounted-row count stays bounded.
const VIRTUALIZE_THRESHOLD = 50;

function formatTimestamp(ms: number): string {
  // Abbreviated on purpose — the year is dropped and the hour is non-padded so
  // the whole meta strip fits one line in the ~500px-wide settings panel.
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

interface HistoryRowProps {
  copyLabel: string;
  entry: TranscriptionHistoryEntry;
}

function copyEntryText(text: string): void {
  // The Web Clipboard API works directly from the renderer (localhost is a
  // secure context) and bypasses the encrypted IPC round-trip whose errors
  // `invokeSecureOrDefault` would swallow. Fall back to IPC if it's missing
  // or refuses (e.g. no user gesture, focus lost).
  const webClipboard = globalThis.navigator?.clipboard;
  if (webClipboard?.writeText) {
    webClipboard.writeText(text).catch(() => {
      clipboardWriteText(text).catch(() => undefined);
    });
    return;
  }
  clipboardWriteText(text).catch(() => undefined);
}

/**
 * Switch the underlying audio sink for an HTMLAudioElement. `setSinkId` is
 * gated on a "speaker-selection" permission that the reference grants by default
 * for the file-loaded renderer, but the call still fails on devices that
 * don't exist or aren't reachable — swallow that case (the play silently
 * falls back to the system default rather than throwing inside the JSX).
 */
async function routeAudioToSink(
  el: HTMLAudioElement,
  deviceId: string,
): Promise<void> {
  if (!deviceId) {
    return;
  }
  const setSinkId = (
    el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
  ).setSinkId;
  if (!setSinkId) {
    return;
  }
  try {
    await setSinkId.call(el, deviceId);
  } catch {
    // device unavailable — system default takes over
  }
}

interface PlaybackState {
  activeIndex: number;
  loading: boolean;
  playing: boolean;
  toggle: () => void;
  words: WordTiming[] | null;
}

/**
 * Binary-search the last word whose start time has been reached, so silences
 * and gaps keep the prior word lit. Returns -1 before the first word.
 */
function findActiveWordIndex(words: WordTiming[], t: number): number {
  let lo = 0;
  let hi = words.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const word = words[mid];
    if (word && word.start <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * Owns a row's `<audio>` element. On first play it lazily fetches both the WAV
 * and the per-word timestamps, then tracks playback position with a rAF loop —
 * the word-highlight sweep doubles as the progress indicator. No-ops when the
 * entry has no recording; called unconditionally per row (Rules of Hooks).
 */
function useHistoryPlayback(
  entryId: string,
  hasAudio: boolean,
  outputDeviceId: string,
): PlaybackState {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [words, setWords] = useState<WordTiming[] | null>(null);
  const [currentTime, setCurrentTime] = useState(0);

  useEffect(
    () => () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
      audioRef.current?.pause();
      audioRef.current = null;
    },
    [],
  );

  const stopTicking = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const tick = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
    rafRef.current = requestAnimationFrame(tick);
  };

  const beginPlayback = async () => {
    if (!audioRef.current) {
      setLoading(true);
      // Fetch WAV bytes + word timings together on first play.
      const [dataUri, timings] = await Promise.all([
        loadTranscriptionHistoryAudio(entryId),
        alignTranscriptionHistoryAudio(entryId),
      ]);
      setLoading(false);
      if (!dataUri) {
        return;
      }
      if (timings.length > 0) {
        setWords(timings);
      }
      const el = new Audio(dataUri);
      el.onended = () => {
        setPlaying(false);
        setCurrentTime(0);
        stopTicking();
      };
      audioRef.current = el;
    }
    await routeAudioToSink(audioRef.current, outputDeviceId);
    try {
      await audioRef.current.play();
    } catch (err) {
      // Don't leave the button stuck in a fake "playing" state if the
      // element can't start (decode/CSP/device) — surface it and bail.
      console.error("[history] playback failed", err);
      setPlaying(false);
      return;
    }
    setPlaying(true);
    stopTicking();
    rafRef.current = requestAnimationFrame(tick);
  };

  const toggle = () => {
    if (!hasAudio) {
      return;
    }
    if (playing && audioRef.current) {
      audioRef.current.pause();
      setPlaying(false);
      stopTicking();
      return;
    }
    beginPlayback().catch(() => undefined);
  };

  const activeIndex =
    playing && words ? findActiveWordIndex(words, currentTime) : -1;
  return { activeIndex, loading, playing, toggle, words };
}

function PlayButton({
  loading,
  onToggle,
  playing,
}: {
  loading: boolean;
  onToggle: () => void;
  playing: boolean;
}) {
  let label = "Play recording";
  if (loading) {
    label = "Loading recording";
  } else if (playing) {
    label = "Pause recording";
  }
  // Ghost transport control, matched to the recording-sound library's play
  // button (SoundLibraryRow): idle is a muted glyph that picks up a faint
  // neutral wash on hover; playing settles into a soft neutral chip. No accent
  // — playback state reads through tone alone, not color.
  return (
    <BaseButton
      aria-label={label}
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-full transition-colors duration-150 active:scale-95",
        playing
          ? "bg-foreground/15 text-foreground hover:bg-foreground/25"
          : "bg-transparent text-foreground-muted hover:bg-foreground/10 hover:text-foreground",
      )}
      disabled={loading}
      onClick={onToggle}
      type="button"
    >
      {loading ? (
        <Spinner className="size-3.5" />
      ) : (
        <HugeiconsIcon
          className="size-3.5"
          icon={playing ? PauseIcon : PlayIcon}
        />
      )}
    </BaseButton>
  );
}

function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    },
    [],
  );

  const handleCopy = () => {
    copyEntryText(text);
    setCopied(true);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    // Hold the check just long enough to read as confirmation, then revert.
    timerRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
  };

  // Both glyphs are stacked and cross-faded (scale + opacity) so the copy →
  // check swap animates, matching fluidfunctionalism's input-copy "icon"
  // variant. The Base UI Tooltip supplies the accessible label on hover.
  return (
    <Tooltip content={label}>
      <BaseButton
        aria-label={label}
        className="relative inline-flex size-7 items-center justify-center text-foreground-muted transition-[color,background-color,transform] hover:bg-surface-hover hover:text-foreground active:scale-95"
        onClick={handleCopy}
        type="button"
      >
        <HugeiconsIcon
          aria-hidden="true"
          className={cn(
            "absolute size-3.5 transition-[opacity,transform] duration-200 ease-out",
            copied ? "scale-50 opacity-0" : "scale-100 opacity-100",
          )}
          icon={Copy01Icon}
        />
        <HugeiconsIcon
          aria-hidden="true"
          className={cn(
            "absolute size-3.5 text-success transition-[opacity,transform] duration-200 ease-out",
            copied ? "scale-100 opacity-100" : "scale-50 opacity-0",
          )}
          icon={CopyCheckIcon}
        />
      </BaseButton>
    </Tooltip>
  );
}

function DeleteButton({
  entryId,
  onDelete,
}: {
  entryId: string;
  onDelete: (id: string) => void;
}) {
  return (
    <BaseButton
      aria-label="Delete entry"
      className="inline-flex size-7 items-center justify-center text-foreground-muted transition-[color,background-color,transform] hover:bg-error/15 hover:text-error active:scale-95"
      onClick={() => {
        onDelete(entryId);
      }}
      type="button"
    >
      <HugeiconsIcon className="size-3.5" icon={Delete02Icon} />
    </BaseButton>
  );
}

/**
 * Toggles a row's transcript between the AI-edited final text and the raw
 * pre-LLM original. Only mounted for entries where the LLM produced a visible
 * text variant. The glyph doubles as a state
 * indicator: the brain (accent) when the AI version is showing, the text glyph
 * when the original is showing — so the row reads as AI-touched at a glance.
 * The label describes the action the click performs, matching the copy
 * button's icon-swap convention above.
 */
function SwapButton({
  onToggle,
  showOriginal,
  showOriginalLabel,
  showProcessedLabel,
}: {
  onToggle: () => void;
  showOriginal: boolean;
  showOriginalLabel: string;
  showProcessedLabel: string;
}) {
  const label = showOriginal ? showProcessedLabel : showOriginalLabel;
  return (
    <Tooltip content={label}>
      <BaseButton
        aria-label={label}
        aria-pressed={showOriginal}
        className="relative inline-flex size-7 items-center justify-center text-foreground-muted transition-[color,background-color,transform] hover:bg-surface-hover hover:text-foreground active:scale-95"
        onClick={onToggle}
        type="button"
      >
        <HugeiconsIcon
          aria-hidden="true"
          className={cn(
            "absolute size-3.5 text-accent transition-[opacity,transform] duration-200 ease-out",
            showOriginal ? "scale-50 opacity-0" : "scale-100 opacity-100",
          )}
          icon={AiBrain02Icon}
        />
        <HugeiconsIcon
          aria-hidden="true"
          className={cn(
            "absolute size-3.5 transition-[opacity,transform] duration-200 ease-out",
            showOriginal ? "scale-100 opacity-100" : "scale-50 opacity-0",
          )}
          icon={TextFontIcon}
        />
      </BaseButton>
    </Tooltip>
  );
}

/**
 * Reveals a row's complete transcript in a hover/focus popup — the same Base UI
 * Tooltip surface the feature demos use — for transcripts the row clamps to four
 * lines. Read-only on purpose: the copy button already copies the full text, so
 * this popup just lifts the truncation cap for reading. Wraps the clamped
 * paragraph as its own trigger (no separate affordance), so hovering the "…"
 * text itself opens it.
 */
const DIFF_SUMMARY_LIMIT = 6;

function truncateDiffSnippet(text: string, max = 38): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function DiffChangeChip({
  change,
}: {
  change: TranscriptDiffResult["changes"][number];
}) {
  const t = useTranslations("history");
  const before = change.before
    ? truncateDiffSnippet(change.before)
    : t("diffInserted");
  const after = change.after
    ? truncateDiffSnippet(change.after)
    : t("diffRemoved");
  return (
    <span
      className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-border bg-foreground/5 px-1.5 py-1 text-[11px] leading-none"
      title={
        change.kind === "insert"
          ? change.after
          : change.kind === "delete"
            ? change.before
            : `${change.before} → ${change.after}`
      }
    >
      {change.before ? (
        <span className="min-w-0 max-w-[9rem] truncate text-error line-through decoration-error/70">
          {before}
        </span>
      ) : (
        <span className="text-foreground-muted">{before}</span>
      )}
      <span className="shrink-0 text-foreground-muted">→</span>
      {change.after ? (
        <span className="min-w-0 max-w-[9rem] truncate text-success">
          {after}
        </span>
      ) : (
        <span className="text-foreground-muted">{after}</span>
      )}
    </span>
  );
}

function DiffText({
  diff,
  side,
}: {
  diff: TranscriptDiffResult;
  side: "after" | "before";
}) {
  return (
    <p className="whitespace-pre-wrap break-words text-body-sm text-foreground leading-relaxed">
      {diff.hunks.map((hunk, index) => {
        const text = side === "before" ? hunk.before : hunk.after;
        if (!text) {
          return null;
        }
        return (
          <Fragment key={`${side}-${index}`}>
            {index > 0 ? " " : null}
            <span
              className={
                hunk.kind === "change"
                  ? side === "before"
                    ? "rounded-[3px] bg-error-dim/45 px-0.5 text-error line-through decoration-error/70"
                    : "rounded-[3px] bg-success-dim/55 px-0.5 text-success"
                  : undefined
              }
            >
              {text}
            </span>
          </Fragment>
        );
      })}
    </p>
  );
}

function TranscriptDiffView({ diff }: { diff: TranscriptDiffResult }) {
  const t = useTranslations("history");
  const panelLevel = Math.max(useSurface() - 1, 1);
  const hiddenChanges = Math.max(diff.changes.length - DIFF_SUMMARY_LIMIT, 0);
  const changeCount = t("diffChangeCount", { count: diff.changes.length });
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-md bg-accent-glow px-1.5 py-1 font-medium text-[11px] text-accent leading-none">
          <HugeiconsIcon
            aria-hidden="true"
            className="size-3"
            icon={AiBrain02Icon}
          />
          {t("diffAiEdits")}
        </span>
        <span className="text-[11px] text-foreground-muted leading-none">
          {diff.coarse
            ? `${changeCount} · ${t("diffLargeRewrite")}`
            : changeCount}
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {diff.changes.slice(0, DIFF_SUMMARY_LIMIT).map((change, index) => (
          <DiffChangeChip change={change} key={`${change.kind}-${index}`} />
        ))}
        {hiddenChanges > 0 ? (
          <span className="inline-flex items-center rounded-md border border-border bg-foreground/5 px-1.5 py-1 text-[11px] text-foreground-muted leading-none">
            {t("diffMoreChanges", { count: hiddenChanges })}
          </span>
        ) : null}
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <section
          className={cn(
            "min-w-0 rounded-md border border-border p-2",
            surfaceBg(panelLevel),
          )}
        >
          <div className="mb-1.5 font-medium text-[11px] text-foreground-muted uppercase leading-none tracking-[0.08em]">
            {t("diffBefore")}
          </div>
          <DiffText diff={diff} side="before" />
        </section>
        <section
          className={cn(
            "min-w-0 rounded-md border border-border p-2",
            surfaceBg(panelLevel),
          )}
        >
          <div className="mb-1.5 font-medium text-[11px] text-foreground-muted uppercase leading-none tracking-[0.08em]">
            {t("diffAfter")}
          </div>
          <DiffText diff={diff} side="after" />
        </section>
      </div>
    </div>
  );
}

function FullTranscriptHover({
  children,
  diff,
  label,
  text,
}: {
  children: ReactElement;
  diff: TranscriptDiffResult | null;
  label: string;
  text: string;
}) {
  const substrate = useSurface();
  const popupLevel = Math.min(substrate + 2, 8);
  const popupShadow = Math.max(popupLevel, 6);
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger render={children} />
      <TooltipPrimitive.Portal>
        <SurfaceProvider value={popupLevel}>
          <TooltipPrimitive.Positioner
            side="top"
            sideOffset={8}
            style={{ zIndex: Z_INDEX.tooltip }}
          >
            <TooltipPrimitive.Popup
              aria-label={label}
              className={cn(
                "max-w-[min(42rem,calc(100vw-2rem))] origin-(--transform-origin) rounded-lg p-3 transition-[transform,opacity] duration-150 data-[ending-style]:scale-95 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
                surfaceClasses(popupLevel, popupShadow),
              )}
            >
              <div
                className="max-h-[46vh] select-text overflow-y-auto"
                dir="auto"
              >
                {diff ? (
                  <TranscriptDiffView diff={diff} />
                ) : (
                  <div className="whitespace-pre-wrap break-words text-body text-foreground leading-relaxed">
                    {text}
                  </div>
                )}
              </div>
            </TooltipPrimitive.Popup>
          </TooltipPrimitive.Positioner>
        </SurfaceProvider>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

interface RowTranscriptProps {
  activeIndex: number;
  diff: TranscriptDiffResult | null;
  displayText: string;
  viewFullLabel: string;
  words: WordTiming[] | null;
}

/**
 * Renders a row's transcript body. At rest the text is clamped to four lines
 * (CSS `-webkit-line-clamp`, which appends the trailing "…"); when it actually
 * overflows that cap we attach a hover popup with the full text. During
 * playback the word-timed spans render UNclamped instead, so the highlight
 * sweep never scrolls out of view — playback is transient and reads top-down.
 */
function RowTranscript({
  activeIndex,
  diff,
  displayText,
  viewFullLabel,
  words,
}: RowTranscriptProps) {
  const [clamped, setClamped] = useState(false);
  const [copied, setCopied] = useState(false);
  const showWords = words !== null && words.length > 0;
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  useEffect(
    () => () => {
      if (copyFeedbackTimerRef.current) {
        clearTimeout(copyFeedbackTimerRef.current);
      }
    },
    [],
  );

  const copyFromLongPress = useCallback(() => {
    if (!displayText) {
      return;
    }
    copyEntryText(displayText);
    globalThis.navigator?.vibrate?.(10);
    setCopied(true);
    if (copyFeedbackTimerRef.current) {
      clearTimeout(copyFeedbackTimerRef.current);
    }
    copyFeedbackTimerRef.current = setTimeout(
      () => setCopied(false),
      COPY_FEEDBACK_MS,
    );
  }, [displayText]);

  const longPress = useLongPress(copyFromLongPress, {
    disabled: displayText.length === 0,
  });
  const touchCopyState = copied
    ? "copied"
    : longPress.pressing
      ? "pressing"
      : undefined;

  // Toggling `clamped` swaps the returned root element (plain <p> ↔ tooltip
  // wrapper), which REMOUNTS the paragraph. A callback ref re-attaches the
  // ResizeObserver to whichever <p> is currently live — a useEffect+useRef
  // would leave the observer bound to the detached node and flip-flop. Each
  // transition measures the actually-attached node, so it converges.
  const observerRef = useRef<ResizeObserver | null>(null);
  const measureRef = useCallback(
    (node: HTMLParagraphElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!node || showWords) {
        setClamped(false);
        return;
      }
      // line-clamp keeps clientHeight at the 4-line cap while scrollHeight
      // grows with the full content — the gap is the truncation signal.
      const measure = () =>
        setClamped(node.scrollHeight - node.clientHeight > 1);
      measure();
      if (typeof ResizeObserver !== "undefined") {
        const observer = new ResizeObserver(measure);
        observer.observe(node);
        observerRef.current = observer;
      }
    },
    // `displayText` is a dep so swapping original↔AI re-measures: the ref
    // identity changes, React re-runs it on the same node, and the new text's
    // overflow is re-evaluated (a short AI text may not clamp while its longer
    // original does, or vice versa).
    [displayText, showWords],
  );

  const paragraph = (
    <p
      className={cn(
        "touch-copy-transcript mt-0.5 min-w-0 flex-1 select-text whitespace-pre-wrap break-words rounded-sm text-body text-foreground leading-relaxed transition-[background-color,box-shadow,transform] duration-150 [touch-action:pan-y]",
        !showWords && "line-clamp-4",
        longPress.pressing &&
          "scale-[0.998] bg-accent/10 shadow-[inset_0_0_0_1px_var(--color-border-accent)]",
        copied &&
          "scale-100 bg-success/10 shadow-[inset_0_0_0_1px_var(--color-success)]",
      )}
      data-long-press-copy="transcript"
      data-touch-copy-state={touchCopyState}
      dir="auto"
      {...longPress.handlers}
      ref={measureRef}
    >
      {showWords && words
        ? words.map((word, index) => (
            <Fragment key={`${word.start}-${index}`}>
              {index > 0 ? " " : null}
              <span
                className={
                  index === activeIndex
                    ? "rounded-[3px] bg-foreground/15 text-foreground"
                    : undefined
                }
              >
                {word.text}
              </span>
            </Fragment>
          ))
        : displayText}
    </p>
  );

  if (showWords || (!clamped && !diff)) {
    return paragraph;
  }
  return (
    <FullTranscriptHover diff={diff} label={viewFullLabel} text={displayText}>
      {paragraph}
    </FullTranscriptHover>
  );
}

interface MetaLabels {
  duration: string;
  model: string;
  processing: string;
  speed: string;
  time: string;
  words: string;
  wpm: string;
}

interface HistoryRowFullProps extends HistoryRowProps {
  labels: MetaLabels;
  onDeleteEntry: (id: string) => void;
  outputDeviceId: string;
  showAudioStats: boolean;
  viewFullLabel: string;
  viewOriginalLabel: string;
  viewProcessedLabel: string;
}

function HistoryRow({
  entry,
  copyLabel,
  labels,
  onDeleteEntry,
  outputDeviceId,
  showAudioStats,
  viewFullLabel,
  viewOriginalLabel,
  viewProcessedLabel,
}: HistoryRowFullProps) {
  const playback = useHistoryPlayback(
    entry.id,
    Boolean(entry.audioFilePath),
    outputDeviceId,
  );
  const transcriptDiff =
    typeof entry.originalText === "string"
      ? buildTranscriptDiff(entry.originalText, entry.text)
      : null;
  const hasOriginal = transcriptDiff !== null;
  // Each entry is its own elevated card, one surface step above the list it sits
  // in (FF surfaces: substrate flows through context, lift +1). The meta footer
  // then recesses BACK to the list surface (`cardLevel - 1`) so it reads as a
  // distinct ledge under the card body — the STT model card's recessed-shelf idea.
  const cardLevel = Math.min(useSurface() + 1, 8);
  // Per-row view toggle for LLM-processed entries; resets implicitly because
  // each row is keyed by entry.id. Defaults to the AI-edited final text.
  const [showOriginal, setShowOriginal] = useState(false);
  const displayText =
    showOriginal && entry.originalText ? entry.originalText : entry.text;
  const wpm = showAudioStats
    ? wordsPerMinute(entry.wordCount, entry.durationMs)
    : 0;
  // Icon + bare value, reusing the summary tiles' stat icons (words / duration
  // / wpm) so a row reads as part of the same family. Dropping the inline text
  // labels keeps the strip on ONE line; the icon + hover title carry meaning.
  // Optional parts (wpm, the LLM trio) drop out cleanly when absent. `logo`
  // swaps the glyph for a maker brand mark (the model chip).
  const meta: {
    icon: IconSvgElement;
    key: string;
    logo?: string | null;
    title: string;
    truncate?: boolean;
    value: string;
  }[] = [
    {
      icon: Clock01Icon,
      key: "time",
      title: labels.time,
      value: formatTimestamp(entry.timestamp),
    },
    {
      icon: TextFontIcon,
      key: "words",
      title: labels.words,
      value: String(entry.wordCount),
    },
  ];
  if (showAudioStats) {
    meta.push({
      icon: StopWatchIcon,
      key: "duration",
      title: labels.duration,
      value: formatDuration(entry.durationMs),
    });
  }
  if (wpm > 0) {
    meta.push({
      icon: DashboardSpeed02Icon,
      key: "wpm",
      title: labels.wpm,
      value: formatWpm(wpm),
    });
  }
  // LLM post-processing telemetry, grouped at the end of the strip: which model
  // (branded with its maker logo when one is bundled, else the CPU glyph), how
  // long the pass took, and its generation speed. Each chip is independent —
  // e.g. tokens/s drops out when the provider reported no usage.
  if (entry.llmModel) {
    // Title carries the full model id so truncation stays inspectable on hover.
    meta.push({
      icon: CpuIcon,
      key: "model",
      logo: resolveProviderIcon(makerFromModelId(entry.llmModel)),
      title: entry.llmModel,
      truncate: true,
      value: entry.llmModel,
    });
  }
  const processing =
    entry.llmProcessingMs !== undefined
      ? formatProcessingDuration(entry.llmProcessingMs)
      : null;
  if (processing) {
    meta.push({
      icon: HourglassIcon,
      key: "processing",
      title: labels.processing,
      value: processing,
    });
  }
  const speed =
    entry.llmTokensPerSecond !== undefined
      ? formatTokensPerSecond(entry.llmTokensPerSecond)
      : null;
  if (speed) {
    meta.push({
      icon: FlashIcon,
      key: "speed",
      title: labels.speed,
      value: speed,
    });
  }
  return (
    // Per-card padding wrapper: virtua measures the border-box (margins are
    // NOT counted), so the inter-card gap lives here as padding, never as a
    // margin on the card itself. Horizontal inset is deliberately omitted —
    // the scroll container reserves a symmetric `scrollbar-gutter` on both
    // edges, so the side gaps match (left == right) instead of the right
    // being padding + the scrollbar's reserved width.
    <div className="py-1">
      <SurfaceProvider value={cardLevel}>
        <div
          className={cn(
            "flex flex-col gap-2.5 overflow-hidden rounded-xl border border-border px-3.5 py-3",
            surfaceClasses(cardLevel, Math.max(cardLevel - 1, 1)),
            "transition-colors duration-150",
            surfaceHoverBg(Math.min(cardLevel + 1, 8)),
            "hover:border-border-hover",
          )}
        >
          <div className="flex items-start gap-3">
            {entry.audioFilePath ? (
              <PlayButton
                loading={playback.loading}
                onToggle={playback.toggle}
                playing={playback.playing}
              />
            ) : null}
            <RowTranscript
              activeIndex={playback.activeIndex}
              diff={transcriptDiff}
              displayText={displayText}
              viewFullLabel={viewFullLabel}
              words={playback.words}
            />
            <ButtonGroup
              aria-label={copyLabel}
              className="shrink-0 self-start"
              connected
              orientation="vertical"
            >
              {hasOriginal ? (
                <SwapButton
                  onToggle={() => setShowOriginal((prev) => !prev)}
                  showOriginal={showOriginal}
                  showOriginalLabel={viewOriginalLabel}
                  showProcessedLabel={viewProcessedLabel}
                />
              ) : null}
              <CopyButton label={copyLabel} text={displayText} />
              <DeleteButton entryId={entry.id} onDelete={onDeleteEntry} />
            </ButtonGroup>
          </div>
          {/* Recessed meta shelf: full-bleed to the card's bottom + side edges
					    (negative margins MUST match the card's px-3.5/py-3), split off by a
					    hairline, and stepped DOWN one surface so it reads as a ledge. */}
          <div
            className={cn(
              "-mx-3.5 -mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-divider border-t px-3.5 pt-2.5 pb-3 text-foreground-secondary text-xs-tight",
              surfaceBg(Math.max(cardLevel - 1, 1)),
            )}
          >
            {meta.map((part) => (
              <span
                className="inline-flex min-w-0 items-center gap-1 tabular-nums"
                key={part.key}
                title={part.title}
              >
                {part.logo ? (
                  <img
                    alt=""
                    aria-hidden="true"
                    className="size-3.5 shrink-0 rounded-[3px] object-contain"
                    src={part.logo}
                  />
                ) : (
                  <HugeiconsIcon
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-foreground-muted"
                    icon={part.icon}
                    strokeWidth={1.75}
                  />
                )}
                <span
                  className={
                    part.truncate
                      ? "max-w-[10rem] truncate"
                      : "whitespace-nowrap"
                  }
                >
                  {part.value}
                </span>
              </span>
            ))}
          </div>
        </div>
      </SurfaceProvider>
    </div>
  );
}

export function HistoryTable({
  emptyLabel,
  entries,
  onDeleteEntry,
  showAudioStats = true,
}: HistoryTableProps) {
  const t = useTranslations("history");
  const outputDeviceId = useSettingsStore(
    (s) => s.settings.general.outputDeviceId,
  );
  // Lift the table one surface step above the section it sits in so the card
  // reads as its own surface, and re-provide that level so rows + the action
  // button-group elevate from here (surfaces system — no flat tokens).
  const level = Math.min(useSurface() + 1, 8);
  // Most recent first; entries are stored chronologically by the main process.
  const sorted = [...entries].reverse();
  const copyLabel = t("copy");
  const viewFullLabel = t("viewFull");
  const viewOriginalLabel = t("viewOriginal");
  const viewProcessedLabel = t("viewProcessed");
  const deleteEntry =
    onDeleteEntry ??
    ((id: string) => {
      deleteTranscriptionHistoryEntry(id).catch(() => undefined);
    });
  const labels: MetaLabels = {
    duration: t("colDuration"),
    model: t("colModel"),
    processing: t("colProcessing"),
    speed: t("colSpeed"),
    time: t("colTime"),
    wpm: t("colWpm"),
    words: t("colWords"),
  };

  const rows = sorted.map((entry) => (
    <HistoryRow
      copyLabel={copyLabel}
      entry={entry}
      key={entry.id}
      labels={labels}
      onDeleteEntry={deleteEntry}
      outputDeviceId={outputDeviceId}
      showAudioStats={showAudioStats}
      viewFullLabel={viewFullLabel}
      viewOriginalLabel={viewOriginalLabel}
      viewProcessedLabel={viewProcessedLabel}
    />
  ));

  let body: React.ReactNode;
  if (sorted.length === 0) {
    body = (
      <div className="px-3 py-6 text-center text-body-sm text-foreground-muted">
        {emptyLabel ?? t("tableEmpty")}
      </div>
    );
  } else if (sorted.length < VIRTUALIZE_THRESHOLD) {
    body = (
      <div
        className="overflow-y-auto"
        style={{
          maxHeight: MAX_BODY_HEIGHT_PX,
          scrollbarGutter: "stable both-edges",
          touchAction: "pan-y",
          WebkitOverflowScrolling: "touch",
        }}
      >
        {rows}
      </div>
    );
  } else {
    body = (
      <VList
        itemSize={ROW_HEIGHT_HINT_PX}
        style={{
          height: Math.min(
            sorted.length * ROW_HEIGHT_HINT_PX,
            MAX_BODY_HEIGHT_PX,
          ),
          scrollbarGutter: "stable both-edges",
          touchAction: "pan-y",
          WebkitOverflowScrolling: "touch",
        }}
      >
        {rows}
      </VList>
    );
  }

  return (
    <SurfaceProvider value={level}>
      <div
        className={cn(
          "overflow-hidden rounded-xl border border-border",
          surfaceBg(level),
        )}
      >
        {body}
      </div>
    </SurfaceProvider>
  );
}
