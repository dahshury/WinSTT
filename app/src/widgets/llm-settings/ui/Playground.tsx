import { PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useReducer } from "react";
import { useTranslations } from "use-intl";
import { surfaceClasses, useSurface } from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import { FormControl } from "@/shared/ui/form-control";

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

function playgroundReducer(state: PlaygroundState, action: PlaygroundAction): PlaygroundState {
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
export function Playground({ run, disabled = false, disabledReason }: PlaygroundProps) {
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
			dispatch({ type: "run-error", error: err instanceof Error ? err.message : String(err) });
		}
	};

	// Inputs sit one surface step above the panel they're on — the same lift the
	// other controls in this modal (selectors, text fields) use.
	const inputLevel = Math.min(useSurface() + 1, 8);
	const textareaClass = `box-border w-full max-w-full resize-y overflow-y-auto whitespace-pre-wrap rounded-sm ${surfaceClasses(inputLevel)} p-2.5 text-body text-foreground caret-accent outline-none transition-colors [overflow-wrap:anywhere] placeholder:text-foreground-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1`;

	return (
		<div className="flex flex-col">
			<div aria-hidden="true" className="mt-2 h-px w-full bg-[var(--color-divider-strong)]" />
			<FormControl caption={t("playgroundHint")} label={t("playgroundSample")}>
				<textarea
					aria-label={t("playgroundSample")}
					className={`min-h-[140px] ${textareaClass}`}
					onChange={(e) => dispatch({ type: "set-sample", value: e.target.value })}
					placeholder={t("playgroundSamplePlaceholder")}
					value={sample}
				/>
			</FormControl>
			<div className="flex items-center gap-3 py-1">
				<Button
					className="flex items-center gap-1.5 rounded-md border border-accent bg-accent px-4 py-2 font-medium text-white transition-colors duration-150 hover:bg-accent-dim disabled:cursor-not-allowed disabled:opacity-60"
					disabled={!canRun}
					onClick={handleRun}
				>
					<HugeiconsIcon icon={PlayIcon} size={14} />
					{running ? t("playgroundRunning") : t("playgroundRun")}
				</Button>
				{error ? <span className="text-error text-xs">{error}</span> : null}
				{!error && disabled && disabledReason ? (
					<span className="text-foreground-muted text-xs">{disabledReason}</span>
				) : null}
			</div>
			<FormControl label={t("playgroundOutput")}>
				<textarea
					aria-label={t("playgroundOutput")}
					className={`min-h-[120px] ${textareaClass}`}
					readOnly={true}
					value={output}
				/>
			</FormControl>
		</div>
	);
}
