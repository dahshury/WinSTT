import { Button as BaseButton } from "@base-ui/react/button";
import { Delete02Icon, FileAudioIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { useFileTranscriptionStore } from "@/features/file-transcription";
import {
  type FileQueueItem,
  fileQueueCancel,
  fileQueueCopy,
  fileQueueDiscardAll,
  fileQueuePause,
  fileQueueResume,
  fileQueueRetry,
} from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, surfaceBg90, useSurface } from "@/shared/lib/surface";
import { AnimatedText as TextSwap } from "@/shared/ui/animated-value";
import { QueueRow } from "./QueueRow";

// Keep the rows on screen this long after the queue empties so the page-slide
// (AudioDisplay) can fade them out instead of snapping to the visualizer. Must
// be >= the page-slide duration in globals.css.
const ROW_LINGER_MS = 320;

/**
 * Hold the last non-empty queue for a moment after it drains, so the exit
 * transition shows the rows fading out. Returns live items while busy (no lag),
 * the last snapshot during the linger, then []. Avoids extra renders: the ref is
 * updated in render and `setCleared(false)` is a no-op while busy.
 */
function useLingeringItems(items: FileQueueItem[]): FileQueueItem[] {
  // Snapshot the last non-empty queue so the drain transition can fade it out.
  // Captured during render via the store-previous-value pattern (no ref reads
  // in render); a timer clears the snapshot once the queue stays empty.
  const [lingering, setLingering] = useState(items);
  const [prevItems, setPrevItems] = useState(items);
  if (items !== prevItems) {
    setPrevItems(items);
    if (items.length > 0) {
      setLingering(items);
    }
  }
  useEffect(() => {
    if (items.length > 0) {
      return;
    }
    const timer = setTimeout(() => setLingering([]), ROW_LINGER_MS);
    return () => clearTimeout(timer);
  }, [items]);
  return items.length > 0 ? items : lingering;
}

/**
 * The multi-file transcription queue, rendered as a compact scrollable list
 * inside the (tiny, 420×150) main-window overlay. One row per file, each with
 * its own welded progress hairline + per-row pause/resume/discard. Returns null
 * once the (lingered) queue is empty so the page-slide settles on the visualizer.
 */
export function FileOverlay() {
  const t = useTranslations("fileOverlay");
  const storeItems = useFileTranscriptionStore((s) => s.items);
  const items = useLingeringItems(storeItems);
  // useSurface() read before any early return (surface-elevation invariant).
  const substrate = useSurface();
  const rowLevel = Math.min(substrate + 1, 8);

  if (items.length === 0) {
    return null;
  }

  const total = items.length;
  const done = items.filter((item) => item.status === "complete").length;
  const hasActive = items.some((item) => item.status === "transcribing");
  const hasQueued = items.some((item) => item.status === "queued");
  const hasPaused = items.some((item) => item.status === "paused");
  let headerLabel = t("headerQueued");
  if (hasActive) {
    headerLabel = t("headerTranscribing");
  } else if (hasQueued) {
    headerLabel = t("headerQueued");
  } else if (hasPaused) {
    headerLabel = t("headerPaused");
  } else if (done === total) {
    headerLabel = t("headerDone");
  }

  return (
    <section
      aria-label={t("queueTitle")}
      className={cn(
        "file-queue absolute inset-0 z-overlay flex flex-col overflow-hidden",
        surfaceBg(substrate),
        "select-none text-foreground",
      )}
    >
      <header
        className={cn(
          "sticky top-0 z-raised flex h-7 shrink-0 items-center gap-1.5 px-3",
          surfaceBg90(substrate),
          "border-foreground/10 border-b backdrop-blur-sm motion-reduce:backdrop-blur-none",
        )}
      >
        <HugeiconsIcon
          aria-hidden
          className="shrink-0 text-foreground-muted"
          icon={FileAudioIcon}
          size={13}
        />
        <TextSwap
          className="min-w-0 truncate font-medium text-[11px] text-foreground-dim tracking-tight"
          text={headerLabel}
        />
        <span className="ml-auto shrink-0 font-mono text-[11px] text-foreground-muted tabular-nums">
          {done}
          <span className="text-foreground/30"> / </span>
          {total}
        </span>
        <BaseButton
          aria-label={t("discardAll")}
          className="ml-1 grid size-[18px] shrink-0 place-items-center rounded text-foreground-muted transition-[transform,color] duration-150 ease-out hover:text-error focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-error/60 active:scale-[0.97]"
          onClick={() => fileQueueDiscardAll()}
          type="button"
        >
          <HugeiconsIcon aria-hidden icon={Delete02Icon} size={13} />
        </BaseButton>
      </header>

      {/* aria-relevant is "additions" only (not "text"): announce newly
			    queued rows, but NOT the per-chunk percentage churn inside each row
			    — the progressbar already exposes live progress via aria-valuenow,
			    so announcing the ticking text too would flood the SR queue. */}
      <ol
        aria-live="polite"
        aria-relevant="additions"
        className="min-h-0 flex-1 divide-y divide-foreground/10 overflow-y-auto overscroll-contain [scrollbar-width:thin]"
      >
        {items.map((item, index) => (
          <QueueRow
            index={index}
            item={item}
            key={item.id}
            onCopy={fileQueueCopy}
            onDiscard={fileQueueCancel}
            onPause={fileQueuePause}
            onResume={fileQueueResume}
            onRetry={fileQueueRetry}
            rowLevel={rowLevel}
          />
        ))}
      </ol>
    </section>
  );
}
