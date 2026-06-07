import { Slider as BaseSlider } from "@base-ui/react/slider";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, surfaceShadow, useSurface } from "@/shared/lib/surface";
import { SliderHashMarks } from "./SliderHashMarks";

type SliderVariant = "pips" | "scrubber";

export interface SliderProps {
  "aria-label"?: string;
  className?: string;
  disabled?: boolean;
  formatValue?: (v: number) => string;
  label?: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step: number;
  value: number;
  variant?: SliderVariant;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function decimalsForStep(step: number): number {
  if (!Number.isFinite(step)) {
    return 0;
  }
  const [, fraction = ""] = String(step).split(".");
  return fraction.length;
}

function valueAsNumber(value: number | number[]): number {
  return Array.isArray(value) ? (value[0] ?? 0) : value;
}

export function Slider({
  "aria-label": ariaLabel,
  className,
  disabled,
  formatValue,
  label,
  max,
  min,
  onChange,
  step,
  value: rawValue,
}: SliderProps) {
  const value = clamp(rawValue, min, max);
  const substrate = useSurface();
  const trackLevel = Math.min(substrate + 1, 8);
  const valueLevel = Math.min(substrate + 2, 8);
  const trackBgClass = surfaceBg(trackLevel);
  const valueBgClass = surfaceBg(valueLevel);
  const valueShadowClass = surfaceShadow(valueLevel);
  const displayValue = formatValue
    ? formatValue(value)
    : value.toFixed(decimalsForStep(step));

  const range = max - min || 1;
  const discreteSteps = range / step;
  const hashMarkCount =
    discreteSteps <= 10 ? Math.max(0, Math.round(discreteSteps) - 1) : 9;
  const hashMarkPct = (i: number) =>
    discreteSteps <= 10 ? (((i + 1) * step) / range) * 100 : (i + 1) * 10;

  return (
    <BaseSlider.Root
      aria-label={ariaLabel ?? label}
      className={cn(
        "group/elastic-slider relative h-9 w-full",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
      data-slot="elastic-slider"
      disabled={disabled}
      largeStep={step * 10}
      max={max}
      min={min}
      onValueChange={(nextValue) => onChange(valueAsNumber(nextValue))}
      step={step}
      value={value}
    >
      <BaseSlider.Control
        className="absolute inset-0 cursor-pointer touch-none select-none outline-none"
        data-slot="elastic-slider-control"
      >
        <BaseSlider.Track
          className={cn(
            "relative h-full overflow-hidden rounded-lg ring-1 ring-divider",
            trackBgClass,
          )}
          data-slot="elastic-slider-track"
        >
          <BaseSlider.Indicator
            className={cn(
              // Round only the LEFT corners (to sit flush in the track's rounded
              // left edge); the right edge — the live progress cap — stays square
              // so the fill doesn't read as a rounded pill mid-track.
              "h-full rounded-l-lg ring-1 ring-divider-strong ring-inset transition-[background-color,box-shadow,opacity] duration-100",
              "opacity-90 group-hover/elastic-slider:opacity-100 group-data-[dragging]/elastic-slider:opacity-100",
              valueBgClass,
              valueShadowClass,
            )}
            data-slot="elastic-slider-fill"
          />
          <SliderHashMarks count={hashMarkCount} pctFor={hashMarkPct} />
          <BaseSlider.Thumb
            aria-label={ariaLabel ?? label}
            getAriaValueText={() => displayValue}
            className={cn(
              "h-5 w-1 rounded-full bg-foreground outline-none",
              "opacity-0 transition-[opacity,scale] duration-150",
              "group-hover/elastic-slider:scale-x-100 group-hover/elastic-slider:opacity-50 group-data-[dragging]/elastic-slider:scale-x-100 group-data-[dragging]/elastic-slider:opacity-80",
              "has-[:focus-visible]:opacity-80 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-foreground/40 has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-bg-base",
            )}
            data-slot="elastic-slider-thumb"
          />

          {label ? (
            <span
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute top-1/2 left-3 inline-flex -translate-y-1/2 items-center font-medium text-sm/none transition-colors duration-100",
                "text-foreground-secondary group-hover/elastic-slider:text-foreground group-data-[dragging]/elastic-slider:text-foreground",
              )}
              data-slot="elastic-slider-label"
            >
              {label}
            </span>
          ) : null}

          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-medium font-mono text-sm/none tabular-nums transition-colors duration-100",
              "text-foreground-secondary group-hover/elastic-slider:text-foreground group-data-[dragging]/elastic-slider:text-foreground",
            )}
            data-slot="elastic-slider-value"
          >
            {displayValue}
          </span>
        </BaseSlider.Track>
      </BaseSlider.Control>
    </BaseSlider.Root>
  );
}
