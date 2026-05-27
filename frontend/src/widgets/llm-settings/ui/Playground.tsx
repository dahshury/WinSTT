import { PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useReducer } from "react";
import { useTranslations } from "use-intl";
import { runLlmPreview } from "@/shared/api/ipc-client";
import { surfaceClasses, useSurface } from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";

interface PlaygroundProps {
	feature: "dictation" | "transforms";
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
 * Per-feature playground. Sends `sample` through the chosen feature's full
 * pipeline (presets+modifiers composed into a system prompt, routed through
 * that feature's provider+model). Displays the result. Pure observation —
 * no clipboard/selection/paste side effects.
 */
export function Playground({ feature }: PlaygroundProps) {
	const t = useTranslations("llm");
	const [state, dispatch] = useReducer(playgroundReducer, INITIAL_STATE);
	const { sample, output, error, running } = state;

	const canRun = !running && sample.trim().length > 0;

	const handleRun = async () => {
		dispatch({ type: "run-start" });
		try {
			const result = await runLlmPreview(sample, feature);
			dispatch({ type: "run-success", output: result });
		} catch (err) {
			dispatch({ type: "run-error", error: err instanceof Error ? err.message : String(err) });
		}
	};

	const substrate = useSurface();
	const cardLevel = Math.min(substrate + 1, 8);
	const inputLevel = Math.min(substrate + 2, 8);
	return (
		<div className={`mt-4 rounded-md p-4 ${surfaceClasses(cardLevel)}`}>
			<div className="mb-3 flex items-center gap-2">
				<HugeiconsIcon className="text-accent" icon={PlayIcon} size={16} />
				<span className="font-medium text-body">{t("playgroundTitle")}</span>
				<span className="ml-auto text-foreground-muted text-xs">{t("playgroundHint")}</span>
			</div>
			<label className="flex flex-col gap-1">
				<span className="text-foreground-muted text-xs uppercase tracking-wide">
					{t("playgroundSample")}
				</span>
				<textarea
					aria-label={t("playgroundSample")}
					className={`min-h-[140px] w-full resize-y rounded ${surfaceClasses(inputLevel)} p-2 text-body text-foreground outline-none transition-colors focus:border-accent`}
					onChange={(e) => dispatch({ type: "set-sample", value: e.target.value })}
					placeholder={t("playgroundSamplePlaceholder")}
					value={sample}
				/>
			</label>
			<div className="mt-3 flex items-center gap-3">
				<Button
					className="flex items-center gap-1 rounded-md bg-accent px-4 py-2 font-medium text-body text-white transition-colors hover:bg-accent-dim disabled:cursor-not-allowed disabled:opacity-60"
					disabled={!canRun}
					onClick={handleRun}
				>
					<HugeiconsIcon icon={PlayIcon} size={14} />
					{running ? t("playgroundRunning") : t("playgroundRun")}
				</Button>
				{error ? <span className="text-error text-xs">{error}</span> : null}
			</div>
			<label className="mt-3 flex flex-col gap-1">
				<span className="text-foreground-muted text-xs uppercase tracking-wide">
					{t("playgroundOutput")}
				</span>
				<textarea
					aria-label={t("playgroundOutput")}
					className={`min-h-[120px] w-full resize-y rounded ${surfaceClasses(inputLevel)} p-2 text-body text-foreground outline-none`}
					readOnly={true}
					value={output}
				/>
			</label>
		</div>
	);
}
