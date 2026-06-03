import {
  AnimatePresence,
  domAnimation,
  LazyMotion,
  m as motion,
} from "motion/react";
import { type RefObject, useEffect, useState } from "react";
import { springs } from "@/shared/lib/springs";
import {
  type HighlightRect,
  findDataAttributeElement,
  highlightRectsEqual,
  measureHighlightRect,
} from "./highlight-geometry";

/**
 * A reusable animated highlight layer for Base-UI menu/combobox popups.
 *
 * Renders two spring-animated pills behind the option rows:
 *  - the **selected** pill (accent-tinted) marking the current `value`, and
 *  - the **hover** pill (neutral) that glides to whichever row Base UI marks
 *    `data-highlighted` (covers both pointer hover AND keyboard arrow nav,
 *    since Base UI sets that attribute for both).
 *
 * This replaces the old static `data-[checked]:bg-surface-N` step — which only
 * lifted the selected row ~2 barely-perceptible surface levels — with the bold,
 * gliding selected/hover indicator from the fluidfunctionalism `select` design
 * (the same lineage as this app's `Switcher` / `CheckboxGroup`). The current
 * value now reads instantly, and the hover pill animates between rows.
 *
 * ## Positioning contract
 * Mount this as a child of `containerRef`'s element, which MUST be
 * `position: relative` and is the element option rows live under. Each row must
 * carry `data-menu-option="<id>"`. Rects are measured relative to the container
 * with three corrections so the pills track rows exactly at any frame:
 *  - **scroll** — `+ scrollTop/Left` so a scrolled long list (languages, voices)
 *    stays aligned; the pills are absolute children of the scroll content and
 *    scroll with it.
 *  - **ancestor scale** — divide by the live container scale so the open
 *    animation (`scale(0.95)→1`, see `searchable-select.css`) doesn't shrink the
 *    pill's travel (same trick as `Switcher.rectFromElement`).
 * Pills sit beneath the rows (rows are `z-raised`), so row text/checkmarks stay
 * crisp on top of the tint.
 */

function findSelected(
  container: HTMLElement,
  value: string,
): HTMLElement | null {
  return findDataAttributeElement(
    container,
    "[data-menu-option]",
    (row) => row.dataset.menuOption,
    value,
  );
}

interface MeasureState {
  highlightedIsSelected: boolean;
  highlightedRect: HighlightRect | null;
  selectedRect: HighlightRect | null;
}

const EMPTY_STATE: MeasureState = {
  highlightedRect: null,
  selectedRect: null,
  highlightedIsSelected: false,
};

export interface MenuHighlightLayerProps {
  /**
   * The `position: relative` element the option rows live under (the popup's
   * radio-group for menus, or the popup itself for comboboxes). This layer is
   * rendered as one of its children.
   */
  containerRef: RefObject<HTMLElement | null>;
  /** The currently-selected option id (`""` for none). */
  value: string;
}

export function MenuHighlightLayer({
  containerRef,
  value,
}: MenuHighlightLayerProps) {
  const [state, setState] = useState<MeasureState>(EMPTY_STATE);

  // This component only mounts while the popup is open (Base UI unmounts the
  // portal on close), so the effect's lifetime IS the open session. Re-runs on
  // `value` change to re-find the selected row (a programmatic value change
  // while open won't trip the `data-highlighted` observer below). Observers
  // cover the rest: MutationObserver tracks `data-highlighted` flips (pointer +
  // keyboard) and filtered-list row add/removal; ResizeObserver tracks the
  // open-animation scale settling and any reflow.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const measure = () => {
      const selectedEl = findSelected(container, value);
      const highlightedEl =
        container.querySelector<HTMLElement>("[data-highlighted]");
      const nextSelected = selectedEl
        ? measureHighlightRect(selectedEl, container)
        : null;
      const nextHighlighted = highlightedEl
        ? measureHighlightRect(highlightedEl, container)
        : null;
      const nextHighlightedIsSelected =
        highlightedEl !== null && highlightedEl === selectedEl;
      setState((prev) =>
        highlightRectsEqual(prev.selectedRect, nextSelected) &&
        highlightRectsEqual(prev.highlightedRect, nextHighlighted) &&
        prev.highlightedIsSelected === nextHighlightedIsSelected
          ? prev
          : {
              selectedRect: nextSelected,
              highlightedRect: nextHighlighted,
              highlightedIsSelected: nextHighlightedIsSelected,
            },
      );
    };
    measure();
    // One more after layout so the post-mount (settled-scale) geometry wins
    // even if no observer happens to fire on the first frame.
    const raf = requestAnimationFrame(measure);
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    const mo = new MutationObserver(measure);
    mo.observe(container, {
      attributes: true,
      attributeFilter: ["data-highlighted"],
      childList: true,
      subtree: true,
    });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
    };
  }, [containerRef, value]);

  const { selectedRect, highlightedRect, highlightedIsSelected } = state;
  const isHoveringOther = highlightedRect !== null && !highlightedIsSelected;
  // The hover pill is suppressed while the highlight rests on the selected row
  // (the selected pill already marks it) — only shown when gliding elsewhere.
  const showHover = highlightedRect !== null && !highlightedIsSelected;
  const hoverOrigin = selectedRect ?? highlightedRect;

  return (
    <LazyMotion features={domAnimation} strict={true}>
      <AnimatePresence>
        {selectedRect ? (
          <motion.div
            animate={{
              top: selectedRect.top,
              left: selectedRect.left,
              width: selectedRect.width,
              height: selectedRect.height,
              opacity: isHoveringOther ? 0.8 : 1,
            }}
            aria-hidden="true"
            className="pointer-events-none absolute rounded-xs bg-accent/15 ring-1 ring-accent/40 ring-inset"
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            initial={false}
            key="menu-selected"
            transition={{ ...springs.moderate, opacity: { duration: 0.08 } }}
          />
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {showHover && highlightedRect ? (
          <motion.div
            animate={{
              top: highlightedRect.top,
              left: highlightedRect.left,
              width: highlightedRect.width,
              height: highlightedRect.height,
              opacity: 1,
            }}
            aria-hidden="true"
            className="pointer-events-none absolute rounded-xs bg-foreground/[0.06] ring-1 ring-divider ring-inset"
            exit={{ opacity: 0, transition: { duration: 0.06 } }}
            initial={{
              top: (hoverOrigin ?? highlightedRect).top,
              left: (hoverOrigin ?? highlightedRect).left,
              width: (hoverOrigin ?? highlightedRect).width,
              height: (hoverOrigin ?? highlightedRect).height,
              opacity: 0,
            }}
            key="menu-hover"
            transition={{ ...springs.fast, opacity: { duration: 0.08 } }}
          />
        ) : null}
      </AnimatePresence>
    </LazyMotion>
  );
}
