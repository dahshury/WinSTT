import { PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useReducer } from "react";
import { useTranslations } from "use-intl";
import { cn } from "@/shared/lib/cn";
import {
  SurfaceProvider,
  surfaceClasses,
  useSurface,
} from "@/shared/lib/surface";
import { FormControl } from "@/shared/ui/form-control";
import { InputGroupButton } from "@/shared/ui/input-group";
import { PulseDot } from "@/shared/ui/pulse-dot";

interface PlaygroundProps {
  /** Disables the Run button regardless of sample content (e.g. no model
   *  resolvable for the chosen provider). */
  disabled?: boolean;
  /** Short explanation rendered beside the Run button when `disabled`. */
  disabledReason?: string | undefined;
  /** Runs the sample through the LLM and resolves with the transformed text.
   *  The caller owns which config/provider/model the sample is routed through
   *  — this component only owns the input/output/run UI. */
  run: (sample: string) => Promise<string>;
}

interface PlaygroundState {
  error: string | null;
  output: string;
  running: boolean;
  sample: string;
}

type PlaygroundAction =
  | { type: "set-sample"; value: string }
  | { type: "run-start" }
  | { type: "run-success"; output: string }
  | { type: "run-error"; error: string };

const INITIAL_STATE: PlaygroundState = {
  sample: "",
  output: "",
  error: null,
  running: false,
};

function playgroundReducer(
  state: PlaygroundState,
  action: PlaygroundAction,
): PlaygroundState {
  switch (action.type) {
    case "set-sample":
      return { ...state, sample: action.value };
    case "run-start":
      return { ...state, error: null, output: "", running: true };
    case "run-success":
      return { ...state, output: action.output, running: false };
    case "run-error":
      return { ...state, error: action.error, running: false };
    default:
      return state;
  }
}

/**
 * Input/output/run surface for the LLM Playground. Sends `sample` through the
 * caller-supplied `run` and displays the result. Laid out as flat `FormControl`
 * rows on the modal's surface (matching the rest of the settings) — no nested
 * card — and a standard primary action button. Pure observation, no
 * clipboard/selection/paste side effects.
 */
export function Playground({
  run,
  disabled = false,
  disabledReason,
}: PlaygroundProps) {
  const t = useTranslations("llm");
  const [state, dispatch] = useReducer(playgroundReducer, INITIAL_STATE);
  const { sample, output, error, running } = state;

  const canRun = !(running || disabled) && sample.trim().length > 0;

  const handleRun = async () => {
    dispatch({ type: "run-start" });
    try {
      const result = await run(sample);
      dispatch({ type: "run-success", output: result });
    } catch (err) {
      dispatch({
        type: "run-error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Inputs sit one surface step above the panel they're on — the same lift the
  // other controls in this modal (selectors, text fields) use.
  const inputLevel = Math.min(useSurface() + 1, 8);
  // The sample input is a fluidfunctionalism input-message composer: ONE
  // surfaced frame that owns the ring + focus glow, with the textarea AND the
  // Run action living inside it. The Run button is the embedded "send" action
  // (bottom-right) rather than a detached primary button below the field.
  const composerClass = cn(
    "flex flex-col rounded-lg ring-1 ring-divider transition-[box-shadow] duration-150",
    "focus-within:shadow-[0_0_0_4px_var(--color-accent-glow),var(--shadow-elevated)] focus-within:ring-accent/70",
    surfaceClasses(inputLevel),
  );
  // The output is a plain surfaced read-only box — no composer chrome.
  const outputClass = cn(
    "box-border w-full max-w-full resize-y overflow-y-auto whitespace-pre-wrap rounded-lg p-2.5",
    "text-body text-foreground caret-accent outline-none transition-colors [overflow-wrap:anywhere]",
    "placeholder:text-foreground-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1",
    surfaceClasses(inputLevel),
  );

  return (
    <div className="flex flex-col">
      <div
        aria-hidden="true"
        className="mt-2 h-px w-full bg-[var(--color-divider-strong)]"
      />
      <FormControl label={t("playgroundSample")} tooltip={t("playgroundHint")}>
        <SurfaceProvider value={inputLevel}>
          <div className={composerClass}>
            <textarea
              aria-label={t("playgroundSample")}
              className="min-h-[120px] w-full resize-y bg-transparent px-3 pt-2.5 pb-1 text-body text-foreground caret-accent outline-none [overflow-wrap:anywhere] placeholder:text-foreground-muted"
              onChange={(e) =>
                dispatch({ type: "set-sample", value: e.target.value })
              }
              placeholder={t("playgroundSamplePlaceholder")}
              value={sample}
            />
            {/* Action row: inline run status on the left, the embedded Run
						    "send" action on the right — a neutral surfaced icon button
						    (the same embedded-action treatment as the snippet add /
						    hotkey play buttons), NOT a detached blue CTA. */}
            <div className="flex items-center justify-between gap-2 px-1.5 pb-1.5">
              <span className="min-w-0 flex-1 truncate text-xs-tight">
                {error ? <span className="text-error">{error}</span> : null}
                {!error && disabled && disabledReason ? (
                  <span className="text-foreground-muted">
                    {disabledReason}
                  </span>
                ) : null}
              </span>
              <InputGroupButton
                aria-label={
                  running ? t("playgroundRunning") : t("playgroundRun")
                }
                disabled={!canRun}
                onClick={handleRun}
                tone="surface"
              >
                {running ? (
                  <PulseDot className="size-2.5" />
                ) : (
                  <HugeiconsIcon icon={PlayIcon} size={16} strokeWidth={2.25} />
                )}
              </InputGroupButton>
            </div>
          </div>
        </SurfaceProvider>
      </FormControl>
      <FormControl label={t("playgroundOutput")}>
        <textarea
          aria-label={t("playgroundOutput")}
          className={`min-h-[120px] ${outputClass}`}
          readOnly={true}
          value={output}
        />
      </FormControl>
    </div>
  );
}
