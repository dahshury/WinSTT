import { PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	useLayoutEffect,
	useRef,
	useReducer,
	useState,
	type KeyboardEvent,
	type MouseEvent,
} from "react";
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
	/** Disables the Run button regardless of sample
	 *  content (e.g. no model resolvable for the chosen provider). */
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

const INPUT_MIN_ROWS = 4;
const INPUT_MAX_ROWS = 10;

function textareaHeightLimit(ref: HTMLTextAreaElement | null): number {
	if (!ref) return 120;
	const computed = getComputedStyle(ref);
	const lineHeight = Number.parseFloat(computed.lineHeight);
	if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
		return 120;
	}
	return lineHeight * INPUT_MAX_ROWS;
}

/**
 * Input/output/run surface for the LLM Playground. Sends `sample` through the
 * caller-supplied `run` and displays the result. Updated to a message-composer
 * layout with an embedded Run action in the input surface.
 */
export function Playground({
	run,
	disabled = false,
	disabledReason,
}: PlaygroundProps) {
	const t = useTranslations("llm");
	const [state, dispatch] = useReducer(playgroundReducer, INITIAL_STATE);
	const { sample, output, error, running } = state;
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const [isFocused, setIsFocused] = useState(false);
	const [isHovered, setIsHovered] = useState(false);

	const canRun = !(running || disabled) && sample.trim().length > 0;

	useLayoutEffect(() => {
		const el = textareaRef.current;
		if (!el) {
			return;
		}
		el.style.height = "auto";
		const minHeight =
			Number.parseFloat(getComputedStyle(el).lineHeight) * INPUT_MIN_ROWS;
		const maxHeight = textareaHeightLimit(el);
		const nextHeight = Math.min(
			Math.max(el.scrollHeight, Number.isFinite(minHeight) ? minHeight : 96),
			maxHeight,
		);
		el.style.height = `${nextHeight}px`;
		el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
	}, [sample]);

	const handleRun = async () => {
		if (!canRun) {
			return;
		}
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

	const handleSubmit = () => {
		void handleRun();
	};

	const focusComposer = () => {
		if (disabled) {
			return;
		}
		textareaRef.current?.focus();
	};

	const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
		if (disabled || running) return;
		const target = event.target as HTMLElement;
		if (target === textareaRef.current) {
			return;
		}
		if (target.closest("button, a, input, textarea, [role='button']")) {
			return;
		}
		event.preventDefault();
		focusComposer();
	};

	const handleTextareaKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.nativeEvent.isComposing) {
			return;
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			handleSubmit();
		}
	};

	// Inputs sit one surface step above the panel they're on — same lift as other
	// controls in this modal.
	const inputLevel = Math.min(useSurface() + 1, 8);

	const composerClass = cn(
		"flex min-h-[120px] w-full flex-col rounded-2xl border transition-[border-color,box-shadow] duration-150",
		"p-2",
		isFocused
			? "border-accent/60 ring-2 ring-accent/20"
			: isHovered
				? "border-border-hover"
				: "border-divider/90",
		surfaceClasses(inputLevel),
		disabled && "pointer-events-none opacity-70",
	);

	const outputClass = cn(
		"box-border w-full max-w-full resize-y overflow-y-auto whitespace-pre-wrap rounded-lg p-2.5",
		"text-body text-foreground caret-accent outline-none transition-colors [overflow-wrap:anywhere]",
		"placeholder:text-foreground-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1",
		surfaceClasses(inputLevel),
	);

	return (
		<div className="flex flex-col">
			<FormControl label={t("playgroundSample")} tooltip={t("playgroundHint")}>
				<SurfaceProvider value={inputLevel}>
					{/* react-doctor-disable-next-line react-doctor/no-static-element-interactions -- pointer-only focus-proxy wrapper: onMouseDown skips interactive descendants and just redirects empty-area clicks to the textarea, which is itself keyboard-reachable; adding role+tabIndex would create a spurious tab stop. */}
					<div
						aria-label={t("playgroundSample")}
						className={composerClass}
						onMouseDown={handleMouseDown}
						onMouseEnter={() => setIsHovered(true)}
						onMouseLeave={() => setIsHovered(false)}
					>
						<textarea
							ref={textareaRef}
							aria-label={t("playgroundSample")}
							className="w-full min-h-0 resize-none bg-transparent px-3 pt-2.5 pb-1 text-body text-foreground caret-accent outline-none [overflow-wrap:anywhere] placeholder:text-foreground-muted"
							onChange={(e) =>
								dispatch({ type: "set-sample", value: e.target.value })
							}
							onFocus={() => setIsFocused(true)}
							onBlur={() => setIsFocused(false)}
							onKeyDown={handleTextareaKeyDown}
							placeholder={t("playgroundSamplePlaceholder")}
							value={sample}
						/>
						<div className="mt-1 flex items-center justify-between gap-2 px-1.5 pb-1.5">
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
								type="button"
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
