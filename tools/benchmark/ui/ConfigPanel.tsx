import type { Dispatch, SetStateAction } from "react";
import { useState } from "react";

import type { OllamaModel, OpenRouterModel } from "@/shared/api/models";
import { PasswordField } from "@/shared/ui/text-field";
import { Switcher } from "@/shared/ui/switcher";
import { OllamaModelSelector } from "@/widgets/model-picker/ollama/ui/OllamaModelSelector";
import { OpenRouterModelSelector } from "@/widgets/model-picker/ui/OpenRouterModelSelector";
import { ReasoningEffortDropdown } from "@/widgets/model-picker/ui/ReasoningEffortDropdown";

import { CAPABILITY_GAP_PROFILES } from "../../lib/postprocess/corpus";
import type { Provider } from "../../lib/postprocess/clients";
import type { BenchmarkConfig, RunProgress, RunnerSpec } from "../engine/types";

interface Props {
	config: BenchmarkConfig;
	setConfig: Dispatch<SetStateAction<BenchmarkConfig>>;
	ollamaModels: OllamaModel[];
	openrouterModels: OpenRouterModel[];
	ollamaError: string | null;
	onScanOllama: () => void;
	onScanOpenRouter: () => void;
	running: boolean;
	progress: RunProgress | null;
	onRun: () => void;
	onStop: () => void;
}

const PROVIDER_OPTIONS = [
	{ value: "ollama" as const, label: "Ollama" },
	{ value: "openrouter" as const, label: "OpenRouter" },
];

function Section(props: {
	title: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="border-surface-5 border-t pt-4">
			<div className="mb-2">
				<div className="text-foreground text-xs-tight font-semibold uppercase tracking-wide">
					{props.title}
				</div>
				{props.hint ? (
					<div className="text-foreground-muted mt-0.5 text-xs">
						{props.hint}
					</div>
				) : null}
			</div>
			{props.children}
		</div>
	);
}

export function ConfigPanel(props: Props) {
	const { config, setConfig } = props;
	const patch = (p: Partial<BenchmarkConfig>) =>
		setConfig((c) => ({ ...c, ...p }));

	const [draftProvider, setDraftProvider] = useState<Provider>("ollama");
	const [draftOllama, setDraftOllama] = useState("");
	const [draftOpenrouter, setDraftOpenrouter] = useState("");

	const addRunner = (spec: RunnerSpec) => {
		if (!spec.model) return;
		if (
			config.runners.some(
				(r) => r.provider === spec.provider && r.model === spec.model,
			)
		)
			return;
		patch({ runners: [...config.runners, spec] });
	};
	const removeRunner = (i: number) =>
		patch({ runners: config.runners.filter((_, idx) => idx !== i) });

	const toggleModifier = (id: string) =>
		patch({
			modifiers: config.modifiers.includes(id)
				? config.modifiers.filter((m) => m !== id)
				: [...config.modifiers, id],
		});

	const pct =
		props.progress && props.progress.total > 0
			? Math.round((props.progress.done / props.progress.total) * 100)
			: 0;

	return (
		<aside className="border-surface-5 bg-surface-2/40 h-fit rounded-xl border p-4">
			{/* Runners */}
			<div>
				<div className="text-foreground text-xs-tight mb-2 font-semibold uppercase tracking-wide">
					Runner models
				</div>
				<Switcher
					options={PROVIDER_OPTIONS}
					value={draftProvider}
					onChange={setDraftProvider}
					fullWidth
				/>
				<div className="mt-2">
					{draftProvider === "ollama" ? (
						<OllamaModelSelector
							models={props.ollamaModels}
							value={draftOllama}
							onChange={setDraftOllama}
							onOpen={props.onScanOllama}
							placeholder="Select an Ollama model"
						/>
					) : (
						<OpenRouterModelSelector
							models={props.openrouterModels}
							value={draftOpenrouter}
							onChange={setDraftOpenrouter}
							onOpen={props.onScanOpenRouter}
						/>
					)}
				</div>
				<button
					type="button"
					className="bg-surface-4 hover:bg-surface-5 text-foreground mt-2 w-full rounded-lg px-3 py-1.5 text-sm"
					onClick={() =>
						addRunner({
							provider: draftProvider,
							model: draftProvider === "ollama" ? draftOllama : draftOpenrouter,
						})
					}
				>
					+ Add runner
				</button>
				<div className="mt-2 flex flex-wrap gap-1.5">
					{config.runners.map((r, i) => (
						<span
							key={`${r.provider}:${r.model}`}
							className="bg-surface-4 text-foreground inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs"
						>
							<span className="text-foreground-muted">
								{r.provider === "ollama" ? "◆" : "☁"}
							</span>
							{r.model}
							<button
								type="button"
								className="text-foreground-muted hover:text-foreground"
								onClick={() => removeRunner(i)}
							>
								×
							</button>
						</span>
					))}
					{config.runners.length === 0 ? (
						<span className="text-foreground-muted text-xs">
							No runners added yet.
						</span>
					) : null}
				</div>
				{props.ollamaError ? (
					<div className="mt-1 text-xs text-[var(--color-warning)]">
						Ollama: {props.ollamaError}
					</div>
				) : null}
			</div>

			<Section
				title="Thinking effort"
				hint="Applied to runner calls (Ollama think / OpenRouter reasoning)."
			>
				<ReasoningEffortDropdown
					value={config.thinkingEffort}
					onChange={(v) => patch({ thinkingEffort: v })}
					ariaLabel="Benchmark thinking effort"
				/>
			</Section>

			<Section
				title="Judge"
				hint="Grades style & accuracy. Use a strong, independent model for calibrated numbers."
			>
				<label className="text-foreground mb-2 flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						checked={config.judgeEnabled}
						onChange={(e) => patch({ judgeEnabled: e.target.checked })}
					/>
					Enable judge
				</label>
				{config.judgeEnabled ? (
					<>
						<Switcher
							options={PROVIDER_OPTIONS}
							value={config.judgeProvider}
							onChange={(v) => patch({ judgeProvider: v })}
							fullWidth
						/>
						<div className="mt-2">
							{config.judgeProvider === "ollama" ? (
								<OllamaModelSelector
									models={props.ollamaModels}
									value={config.judgeModel}
									onChange={(v) => patch({ judgeModel: v })}
									onOpen={props.onScanOllama}
									placeholder="Judge model"
								/>
							) : (
								<OpenRouterModelSelector
									models={props.openrouterModels}
									value={config.judgeModel}
									onChange={(v) => patch({ judgeModel: v })}
									onOpen={props.onScanOpenRouter}
								/>
							)}
						</div>
					</>
				) : null}
			</Section>

			<Section
				title="Semantic Δ embeddings"
				hint="Ollama embedding model (e.g. nomic-embed-text). Powers the magnitude scatter."
			>
				<label className="text-foreground mb-2 flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						checked={config.embedEnabled}
						onChange={(e) => patch({ embedEnabled: e.target.checked })}
					/>
					Enable embeddings
				</label>
				{config.embedEnabled ? (
					<OllamaModelSelector
						models={props.ollamaModels}
						value={config.embedModel}
						onChange={(v) => patch({ embedModel: v })}
						onOpen={props.onScanOllama}
						placeholder="Embedding model"
					/>
				) : null}
			</Section>

			<Section
				title="OpenRouter API key"
				hint="Stored only in this browser. Needed for cloud runners/judge."
			>
				<PasswordField
					value={config.openrouterKey}
					onChange={(e) => patch({ openrouterKey: e.target.value })}
					onBlur={props.onScanOpenRouter}
					placeholder="sk-or-…"
				/>
			</Section>

			<Section title="Ollama endpoint">
				<input
					className="border-surface-5 bg-surface-3 text-foreground w-full rounded-lg border px-3 py-1.5 text-sm"
					value={config.ollamaEndpoint}
					onChange={(e) => patch({ ollamaEndpoint: e.target.value })}
					onBlur={props.onScanOllama}
				/>
			</Section>

			<Section title="Modifiers" hint="Which tones/operations to benchmark.">
				<div className="grid grid-cols-2 gap-1.5">
					{CAPABILITY_GAP_PROFILES.map((p) => (
						<label
							key={p.id}
							className="text-foreground flex items-center gap-1.5 text-xs"
						>
							<input
								type="checkbox"
								checked={config.modifiers.includes(p.id)}
								onChange={() => toggleModifier(p.id)}
							/>
							{p.id}
						</label>
					))}
				</div>
			</Section>

			<Section title="Sampling">
				<div className="flex items-center gap-4">
					<label className="text-foreground flex items-center gap-2 text-sm">
						Corpus
						<input
							type="number"
							min={0}
							max={11}
							value={config.corpusLimit}
							onChange={(e) => patch({ corpusLimit: Number(e.target.value) })}
							className="border-surface-5 bg-surface-3 w-16 rounded-lg border px-2 py-1 text-sm"
						/>
					</label>
					<label className="text-foreground flex items-center gap-2 text-sm">
						Trials
						<input
							type="number"
							min={1}
							max={9}
							value={config.trials}
							onChange={(e) => patch({ trials: Number(e.target.value) })}
							className="border-surface-5 bg-surface-3 w-16 rounded-lg border px-2 py-1 text-sm"
						/>
					</label>
				</div>
				<label className="text-foreground mt-2 flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						checked={config.includeCapability}
						onChange={(e) => patch({ includeCapability: e.target.checked })}
					/>
					Include capability checks (adherence)
				</label>
			</Section>

			<div className="border-surface-5 mt-4 border-t pt-4">
				{props.running ? (
					<>
						<div className="bg-surface-4 h-2 w-full overflow-hidden rounded-full">
							<div
								className="bg-activity h-full transition-[width]"
								style={{ width: `${pct}%` }}
							/>
						</div>
						<div className="text-foreground-muted mt-1 truncate text-xs">
							{pct}% · {props.progress?.label}
						</div>
						<button
							type="button"
							className="border-surface-5 text-foreground mt-2 w-full rounded-lg border px-3 py-2 text-sm"
							onClick={props.onStop}
						>
							Stop
						</button>
					</>
				) : (
					<button
						type="button"
						disabled={config.runners.length === 0}
						className="bg-activity text-on-activity w-full rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-40"
						onClick={props.onRun}
					>
						Run benchmark
					</button>
				)}
			</div>
		</aside>
	);
}
