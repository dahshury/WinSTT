/**
 * ComponentPreviewTooltip — hover/focus a trigger to reveal a live, animated preview of a
 * named demo scene (see demos.tsx). App-themed, accessible, used inline in MDX to make
 * settings "show, don't tell". The preview renders only while open (animations restart on
 * each hover) and is an absolute child of the trigger so moving the cursor onto it doesn't
 * dismiss it.
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import { DEMOS } from "@/components/demo-registry";

type Side = "top" | "bottom" | "left" | "right";
type TimerRef = { current: ReturnType<typeof setTimeout> | null };

function clearTooltipTimer(timer: TimerRef) {
  if (timer.current) clearTimeout(timer.current);
  timer.current = null;
}

export interface ComponentPreviewTooltipProps {
  /** Demo scene name — a key in DEMOS. */
  name: string;
  /** Tooltip position relative to the trigger. */
  side?: Side;
  /** Preview width in px. */
  width?: number;
  children: ReactNode;
}

export function ComponentPreviewTooltip({
  name,
  side = "top",
  width = 340,
  children,
}: ComponentPreviewTooltipProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      clearTooltipTimer(openTimer);
      clearTooltipTimer(closeTimer);
    };
  }, []);

  const show = () => {
    clearTooltipTimer(closeTimer);
    setMounted(true);
    openTimer.current = setTimeout(() => setOpen(true), 90);
  };
  const hide = () => {
    clearTooltipTimer(openTimer);
    setOpen(false);
    closeTimer.current = setTimeout(() => setMounted(false), 220);
  };

  const Demo = DEMOS[name];

  return (
    <button
      type="button"
      className="cpt-trigger"
      data-open={open ? "true" : undefined}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      <span className="cpt-spark" aria-hidden="true" />
      {mounted ? (
        <span
          className="cpt-pop"
          data-side={side}
          data-open={open ? "true" : "false"}
          role="tooltip"
          style={{ width }}
        >
          <span className="cpt-card">
            {Demo ? (
              <Demo />
            ) : (
              <span className="cpt-missing">No preview for "{name}"</span>
            )}
          </span>
          <span className="cpt-arrow" aria-hidden="true" />
        </span>
      ) : null}
    </button>
  );
}
