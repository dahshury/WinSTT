import { useCallback, useEffect, useRef, useState } from "react";

import type { OllamaModel, OpenRouterModel } from "@/shared/api/models";

import { fetchOllamaCatalog, fetchOpenRouterCatalog } from "../engine/catalog";
import { fetchRuns, saveRun, toStoredRun } from "../engine/persistence";
import { runBenchmark } from "../engine/run";
import type { BenchmarkConfig, RunProgress, StoredRun } from "../engine/types";
import type { TrialRecord } from "../../lib/postprocess/types";
import { ConfigPanel } from "./ConfigPanel";
import { Results } from "./Results";

const DEFAULT_CONFIG: BenchmarkConfig = {
	runners: [],
	ollamaEndpoint: "http://127.0.0.1:11434",
	openrouterKey: "",
	thinkingEffort: "off",
	judgeEnabled: true,
	judgeProvider: "ollama",
	judgeModel: "",
	embedEnabled: true,
	embedModel: "nomic-embed-text",
	modifiers: ["formal", "friendly", "concise", "restructure", "translate"],
	corpusLimit: 2,
	includeCapability: true,
	trials: 1,
};

const CONFIG_KEY = "winstt-benchmark-config";

function loadConfig(): BenchmarkConfig {
	try {
		const raw = localStorage.getItem(CONFIG_KEY);
		if (raw)
			return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as BenchmarkConfig) };
	} catch {
		/* ignore */
	}
	return DEFAULT_CONFIG;
}

export function App() {
	const [config, setConfig] = useState<BenchmarkConfig>(loadConfig);
	const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
	const [openrouterModels, setOpenrouterModels] = useState<OpenRouterModel[]>(
		[],
	);
	const [ollamaError, setOllamaError] = useState<string | null>(null);
	const [running, setRunning] = useState(false);
	const [progress, setProgress] = useState<RunProgress | null>(null);
	const [liveTrials, setLiveTrials] = useState<TrialRecord[]>([]);
	const [history, setHistory] = useState<StoredRun[]>([]);
	const abortRef = useRef<AbortController | null>(null);

	useEffect(() => {
		localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
	}, [config]);

	const scanOllama = useCallback(async () => {
		try {
			setOllamaError(null);
			setOllamaModels(await fetchOllamaCatalog(config.ollamaEndpoint));
		} catch (err) {
			setOllamaError(err instanceof Error ? err.message : String(err));
		}
	}, [config.ollamaEndpoint]);

	const scanOpenRouter = useCallback(async () => {
		if (!config.openrouterKey) return;
		try {
			setOpenrouterModels(await fetchOpenRouterCatalog(config.openrouterKey));
		} catch (err) {
			console.warn("OpenRouter scan failed", err);
		}
	}, [config.openrouterKey]);

	useEffect(() => {
		void scanOllama();
		void fetchRuns().then(setHistory);
	}, [scanOllama]);

	const handleRun = useCallback(async () => {
		if (running || config.runners.length === 0) return;
		setRunning(true);
		setLiveTrials([]);
		setProgress({ done: 0, total: 0, label: "starting…", phase: "runner" });
		const controller = new AbortController();
		abortRef.current = controller;
		const startedAt = new Date().toISOString();
		const collected: TrialRecord[] = [];
		try {
			const { durationMs } = await runBenchmark(config, {
				signal: controller.signal,
				onProgress: setProgress,
				onTrial: (t) => {
					collected.push(t);
					setLiveTrials((prev) => [...prev, t]);
				},
			});
			const run = toStoredRun(
				config,
				collected,
				durationMs,
				startedAt,
				crypto.randomUUID(),
			);
			await saveRun(run);
			setHistory(await fetchRuns());
		} catch (err) {
			console.error("benchmark run failed", err);
		} finally {
			setRunning(false);
			abortRef.current = null;
		}
	}, [config, running]);

	const handleStop = useCallback(() => {
		abortRef.current?.abort();
	}, []);

	return (
		<div className="min-h-screen">
			<header className="border-surface-5 bg-surface-1/80 sticky top-0 z-10 border-b px-6 py-3 backdrop-blur">
				<h1 className="text-foreground text-base font-semibold">
					WinSTT · Model Modifier Benchmark
				</h1>
				<p className="text-foreground-muted text-xs">
					Standalone dev tool — reuses the app's pickers & prompts, not shipped
					with the binary.
				</p>
			</header>
			<div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-6 p-6 lg:grid-cols-[380px_1fr]">
				<ConfigPanel
					config={config}
					setConfig={setConfig}
					ollamaModels={ollamaModels}
					openrouterModels={openrouterModels}
					ollamaError={ollamaError}
					onScanOllama={scanOllama}
					onScanOpenRouter={scanOpenRouter}
					running={running}
					progress={progress}
					onRun={handleRun}
					onStop={handleStop}
				/>
				<Results liveTrials={liveTrials} history={history} config={config} />
			</div>
		</div>
	);
}
