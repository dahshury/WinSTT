import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { SurfaceProvider, surfaceBg, useSurface } from "@/shared/lib/surface";

export interface ElevatedSurfaceProps {
  children: ReactNode;
  className?: string | undefined;
  /**
   * Use `inline` for narrow trigger controls (Select, NumberStepper,
   * TextField) that already carry their own internal padding — the wrapper
   * just provides the ring + shadow + lifted background without extra
   * gutter. Default (full) adds `p-1.5` for option-group controls
   * (Switcher, CheckboxGroup) where the frame visibly surrounds the pills.
   */
  inline?: boolean;
  /** How many surface steps to lift above the current substrate. Default 1. */
  offset?: number;
}

/**
 * Shared "elevated control" surface — the standard wrapper for every
 * primary interactive group across the settings UI (recording mode picker,
 * visualizer pickers, checkbox groups, sliders, selects, number steppers).
 *
 * Routes through the substrate context: lifts +N (default 1) above the
 * current surface AND re-provides the new level downward so any nested
 * popover / dropdown inside the control automatically elevates another
 * step. That's how the section panel (surface-3) → control (surface-5) →
 * combobox popup (surface-7) chain stays cohesive without hardcoding.
 *
 * Visual recipe (via tokens): tinted-surface fill + hairline ring + the
 * fluidfunctionalism multi-layer shadow with the n8n accent bottom edge.
 */
export function ElevatedSurface({
  children,
  className,
  inline = false,
  offset = 1,
}: ElevatedSurfaceProps) {
  const substrate = useSurface();
  const level = Math.min(substrate + offset, 8);
  return (
    <SurfaceProvider value={level}>
      <div
        className={cn(
          surfaceBg(level),
          "rounded-lg shadow-elevated ring-1 ring-divider transition-[transform,box-shadow] duration-200 ease-out",
          inline ? "[&>*]:rounded-lg" : "p-1.5",
          className,
        )}
      >
        {children}
      </div>
    </SurfaceProvider>
  );
}
