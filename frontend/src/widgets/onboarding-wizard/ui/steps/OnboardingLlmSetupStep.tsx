import {
	ArrowRight02Icon,
	ArrowUpRight01Icon,
	CheckmarkCircle02Icon,
	Cursor01Icon,
	Download04Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import {
	findRecommendedModel,
	RECOMMENDED_OLLAMA_MODELS,
	useLlmCatalogStore,
} from "@/entities/llm-catalog";
import { useSettingsStore } from "@/entities/setting";
import { detectOllama, type OllamaDetectResult, startOllama } from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { Spinner } from "@/shared/ui/spinner";
import { Toggle } from "@/shared/ui/toggle";
import { useOnboardingWizardStore } from "../../model/wizard-store";

const OLLAMA_HOMEPAGE = "https://ollama.com/download";
const DEFAULT_FALLBACK_MODEL =
	RECOMMENDED_OLLAMA_MODELS.find((m) => (m.tags ?? []).includes("recommended"))?.name ??
	"llama3.2:3b";

/**
 * Step 4: optional LLM cleanup. Tries to detect Ollama (`detectOllama` returns
 * `{ installed }` — `installed=true` means the daemon is reachable on the
 * default port, false means either not installed or not running). When
 * available, the user picks a model via the same `OllamaModelManagerDialog`
 * used in Settings (install + select happens inside the dialog) and toggles
 * dictation cleanup with the canonical `Toggle` switch.
 *
 * Per the capability-toggle invariant (memory: feedback_capability_must_have_model)
 * we never flip `llm.dictation.enabled` true without first writing a real
 * model id into `llm.dictation.model`.
 */
export function OnboardingLlmSetupStep() {
	const [detect, setDetect] = useState<OllamaDetectResult | null>(null);
	const [starting, setStarting] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);
	const setPickerOpen = useOnboardingWizardStore((s) => s.setLlmPickerOpen);
	const llmDictation = useSettingsStore((s) => s.settings.llm.dictation);
	const updateLlmDictation = useSettingsStore((s) => s.updateLlmDictation);
	const installedModels = useLlmCatalogStore((s) => s.models);
	const scanModels = useLlmCatalogStore((s) => s.scanModels);

	useEffect(() => {
		let cancelled = false;
		detectOllama()
			.then((result) => {
				if (!cancelled) {
					setDetect(result);
					if (result.installed) {
						scanModels().catch(() => undefined);
					}
				}
			})
			.catch(() => {
				if (!cancelled) {
					setDetect({ installed: false });
				}
			});
		return () => {
			cancelled = true;
		};
	}, [scanModels]);

	if (!detect) {
		return (
			<div className="flex items-center gap-2 px-1 py-1.5 text-body-sm text-foreground-muted">
				<Spinner className="size-3 border" />
				<span>Looking for Ollama on this machine…</span>
			</div>
		);
	}

	if (!detect.installed) {
		return (
			<NotInstalledPanel
				error={startError}
				onStart={() => {
					setStarting(true);
					setStartError(null);
					startOllama()
						.then((result) => {
							if (result.started) {
								return detectOllama().then(setDetect);
							}
							setStartError(result.error ?? "Could not start Ollama.");
							return;
						})
						.finally(() => setStarting(false));
				}}
				starting={starting}
			/>
		);
	}

	const enabled = llmDictation.enabled;
	const selectedModel = llmDictation.model;
	const displayName = formatModelLabel(selectedModel, installedModels);
	const isInstalled = !!selectedModel && installedModels.some((m) => m.name === selectedModel);

	const handleToggle = (next: boolean) => {
		if (!next) {
			updateLlmDictation({ enabled: false });
			return;
		}
		// Per feedback_capability_must_have_model: never set enabled=true with model="".
		// Falls back to the smallest recommended model so the toggle never lands
		// on an empty capability.
		const resolved = selectedModel || DEFAULT_FALLBACK_MODEL;
		updateLlmDictation({ enabled: true, model: resolved, provider: "ollama" });
	};

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center gap-2 rounded-md bg-success/10 px-3 py-2 text-body-sm text-success ring-1 ring-success/25">
				<HugeiconsIcon icon={CheckmarkCircle02Icon} size={13} />
				<span className="font-medium">Ollama is running locally.</span>
			</div>

			<FormControl
				caption="Browse installed models or install a recommended one. The same picker you'll see in Settings → LLM."
				label="Model"
				layout="stacked"
			>
				<ElevatedSurface inline>
					<button
						className={cn(
							"flex h-8 w-full items-center justify-between gap-2 rounded-lg bg-transparent px-3 text-left outline-none transition-colors duration-150",
							"hover:bg-foreground/[0.04]",
							"focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1"
						)}
						onClick={() => setPickerOpen(true)}
						type="button"
					>
						<span className="flex min-w-0 flex-1 items-center gap-2">
							{selectedModel ? (
								<>
									<span className="sr-only">{isInstalled ? "Installed" : "Not installed"}</span>
									<span
										aria-hidden="true"
										className={cn(
											"size-1.5 shrink-0 rounded-full",
											isInstalled ? "bg-teal" : "bg-warning"
										)}
									/>
								</>
							) : null}
							<span
								className={cn(
									"truncate text-body",
									selectedModel ? "text-foreground" : "text-foreground-muted"
								)}
							>
								{displayName}
							</span>
						</span>
						<span className="inline-flex items-center gap-1 font-mono text-accent text-xs-tight uppercase tracking-[0.14em]">
							Browse
							<HugeiconsIcon icon={ArrowRight02Icon} size={10} />
						</span>
					</button>
				</ElevatedSurface>
			</FormControl>

			<FormControl
				caption="Removes filler words, fixes punctuation, and follows custom prompts."
				label="Clean up dictation"
				layout="row"
			>
				<Toggle
					aria-label="Clean up dictation with LLM"
					checked={enabled}
					onCheckedChange={handleToggle}
				/>
			</FormControl>
		</div>
	);
}

/** Human-readable label for the currently-selected model. */
function formatModelLabel(modelId: string, installed: readonly { name: string }[]): string {
	if (!modelId) {
		return "No model selected — click to choose";
	}
	const recommended = findRecommendedModel(modelId);
	if (recommended) {
		return `${recommended.displayName} · ${recommended.paramSize}`;
	}
	const isInstalled = installed.some((m) => m.name === modelId);
	return isInstalled ? modelId : `${modelId} (not installed)`;
}

interface NotInstalledPanelProps {
	error: string | null;
	onStart: () => void;
	starting: boolean;
}

function NotInstalledPanel({ error, starting, onStart }: NotInstalledPanelProps) {
	return (
		<div className="flex flex-col gap-3">
			<div className="rounded-md bg-surface-2 px-4 py-3 ring-1 ring-divider">
				<div className="flex items-center gap-2 font-medium text-body text-foreground">
					<HugeiconsIcon className="text-foreground-muted" icon={Download04Icon} size={14} />
					Ollama isn't running
				</div>
				<p className="mt-1.5 text-body-sm text-foreground-muted leading-snug">
					Ollama runs LLMs locally and powers WinSTT's dictation cleanup. It's a free, open-source
					one-time install. If you already have it installed, we can try to start it for you.
				</p>
				<div className="mt-3 flex flex-wrap items-center gap-2.5">
					<button
						className={cn(
							"inline-flex h-7 items-center justify-center rounded-md bg-accent px-3 font-medium text-body-sm text-white outline-none transition-[background-color,box-shadow] duration-150",
							"shadow-elevated hover:bg-accent-hover",
							"focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1",
							"disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
						)}
						disabled={starting}
						onClick={onStart}
						type="button"
					>
						{starting ? "Starting…" : "Try to start Ollama"}
					</button>
					<a
						className="inline-flex items-center gap-1 font-mono text-foreground-muted text-xs-tight uppercase tracking-[0.16em] underline-offset-4 transition-colors hover:text-foreground-secondary hover:underline"
						href={OLLAMA_HOMEPAGE}
						rel="noreferrer noopener"
						target="_blank"
					>
						<HugeiconsIcon icon={Cursor01Icon} size={10} />
						Or install Ollama
						<HugeiconsIcon icon={ArrowUpRight01Icon} size={10} />
					</a>
				</div>
				{error ? <p className="mt-2 text-body-sm text-error">{error}</p> : null}
			</div>
			<p className="text-body-sm text-foreground-dim">
				You can finish setup without it and enable LLM cleanup later from Settings.
			</p>
		</div>
	);
}
