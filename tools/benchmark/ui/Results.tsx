import { useState } from "react";

import { Sparkline } from "@/widgets/transcription-history-settings/ui/Sparkline";

import { aggregate } from "../../lib/postprocess/aggregate";
import type {
	ModifierModelAgg,
	TrialRecord,
} from "../../lib/postprocess/types";
import type { BenchmarkConfig, StoredRun } from "../engine/types";
import {
	GroupedBars,
	Heatmap,
	RubricRadar,
	Scatter,
	seriesColor,
} from "./charts";

type View =
	| "overview"
	| "style"
	| "accuracy"
	| "speed"
	| "magnitude"
	| "rubric"
	| "history"
	| "samples";

const VIEWS: { id: View; label: string }[] = [
	{ id: "overview", label: "Overview" },
	{ id: "style", label: "Style" },
	{ id: "accuracy", label: "Accuracy" },
	{ id: "speed", label: "Speed" },
	{ id: "magnitude", label: "Magnitude" },
	{ id: "rubric", label: "Rubric" },
	{ id: "samples", label: "Samples" },
	{ id: "history", label: "History" },
];

const RUBRIC_AXES = ["style", "meaning", "fidelity", "fluency", "degree"];

function aggKey(modifier: string, model: string): string {
	return `${modifier}␟${model}`;
}

export function Results(props: {
	liveTrials: TrialRecord[];
	history: StoredRun[];
	config: BenchmarkConfig;
}) {
	const [view, setView] = useState<View>("overview");
	const aggregates = aggregate(props.liveTrials);
	const map = new Map<string, ModifierModelAgg>();
	for (const a of aggregates) map.set(aggKey(a.modifierId, a.model), a);

	const models = uniquePreserveOrder(aggregates.map((a) => a.model));
	const modifiers = uniquePreserveOrder(aggregates.map((a) => a.modifierId));

	const hasData = aggregates.length > 0;
	const pick = (
		modifier: string,
		model: string,
		f: (a: ModifierModelAgg) => number | null,
	) => {
		const a = map.get(aggKey(modifier, model));
		return a ? f(a) : null;
	};

	return (
		<section className="min-w-0">
			<div className="mb-4 flex flex-wrap gap-1">
				{VIEWS.map((v) => (
					<button
						key={v.id}
						type="button"
						onClick={() => setView(v.id)}
						className={
							view === v.id
								? "bg-activity text-on-activity rounded-lg px-3 py-1.5 text-sm font-medium"
								: "bg-surface-3 text-foreground-muted hover:text-foreground rounded-lg px-3 py-1.5 text-sm"
						}
					>
						{v.label}
					</button>
				))}
			</div>

			{!hasData && view !== "history" ? (
				<div className="border-surface-5 text-foreground-muted rounded-xl border border-dashed p-10 text-center text-sm">
					No results yet. Add runner models and press <b>Run benchmark</b>.
					Results stream in live.
				</div>
			) : null}

			{hasData && view === "overview" ? (
				<Card
					title="Composite quality — model × modifier"
					hint="Blend of judge style (½) + accuracy (½), scaled by guard pass-rate. Darker = higher."
				>
					<Heatmap
						rows={modifiers}
						cols={models}
						value={(r, c) => pick(r, c, (a) => a.composite)}
					/>
				</Card>
			) : null}

			{hasData &&
			(view === "style" || view === "accuracy" || view === "speed") ? (
				<Card title={metricLabel(view)} hint={metricHint(view)}>
					<Legend models={models} />
					<GroupedBars
						groups={modifiers}
						series={models}
						value={(g, s) => pick(g, s, metricPicker(view))}
						unit={view === "speed" ? " tok/s" : ""}
						{...(view === "speed" ? {} : { max: 100 })}
					/>
				</Card>
			) : null}

			{hasData && view === "magnitude" ? (
				<Card
					title="Magnitude — how much the text changed"
					hint="High surface Δ + low semantic Δ = clean restyle. Low both = no-op. High semantic Δ = meaning drift."
				>
					<Legend models={models} />
					<Scatter
						points={aggregates
							.filter((a) => a.meanSemanticDelta !== null)
							.map((a) => ({
								x: a.meanSurfaceDelta,
								y: a.meanSemanticDelta ?? 0,
								label: `${a.modifierId} · ${a.model}`,
								seriesIndex: models.indexOf(a.model),
							}))}
					/>
					{aggregates.every((a) => a.meanSemanticDelta === null) ? (
						<p className="text-foreground-muted mt-2 text-xs italic">
							Semantic Δ unavailable — enable an Ollama embedding model to
							populate the scatter.
						</p>
					) : null}
				</Card>
			) : null}

			{hasData && view === "rubric" ? (
				<RubricView
					trials={props.liveTrials}
					modifiers={modifiers}
					models={models}
				/>
			) : null}

			{hasData && view === "samples" ? (
				<SamplesView trials={props.liveTrials} />
			) : null}

			{view === "history" ? <HistoryView history={props.history} /> : null}
		</section>
	);
}

function metricLabel(view: View): string {
	if (view === "style") return "Style — tone/register achievement (judge)";
	if (view === "accuracy")
		return "Accuracy — meaning preserved + instructions followed";
	return "Speed — generation throughput (from run data)";
}
function metricHint(view: View): string {
	if (view === "style")
		return "Mean judge style_match: how fully each model achieves the requested transformation.";
	if (view === "accuracy")
		return "Judge meaning + fidelity blended with deterministic capability pass-rate.";
	return "Median tokens/sec, measured from actual run timing.";
}
function metricPicker(view: View): (a: ModifierModelAgg) => number | null {
	if (view === "style") return (a) => a.style;
	if (view === "accuracy") return (a) => a.accuracy;
	return (a) => a.medianTokensPerSec;
}

function RubricView(props: {
	trials: TrialRecord[];
	modifiers: string[];
	models: string[];
}) {
	const [modifier, setModifier] = useState(props.modifiers[0] ?? "");
	const active = props.modifiers.includes(modifier)
		? modifier
		: (props.modifiers[0] ?? "");
	const series = props.models.map((model, seriesIndex) => {
		const ts = props.trials.filter(
			(t) => t.model === model && t.modifierId === active && t.judge,
		);
		const avg = (f: (t: TrialRecord) => number) =>
			ts.length ? ts.reduce((s, t) => s + f(t), 0) / ts.length : 0;
		return {
			label: model,
			seriesIndex,
			values: [
				avg((t) => t.judge!.styleMatch),
				avg((t) => t.judge!.meaningPreservation),
				avg((t) => t.judge!.fidelity),
				avg((t) => t.judge!.fluency),
				avg((t) => t.judge!.degree),
			],
		};
	});
	return (
		<Card
			title="Rubric — judge criteria per model"
			hint="Five judge axes for the selected modifier."
		>
			<div className="mb-3 flex flex-wrap gap-1">
				{props.modifiers.map((m) => (
					<button
						key={m}
						type="button"
						onClick={() => setModifier(m)}
						className={
							active === m
								? "bg-surface-5 text-foreground rounded-md px-2 py-1 text-xs"
								: "bg-surface-3 text-foreground-muted rounded-md px-2 py-1 text-xs"
						}
					>
						{m}
					</button>
				))}
			</div>
			<div className="flex flex-wrap items-center gap-6">
				<RubricRadar axes={RUBRIC_AXES} series={series} />
				<Legend models={props.models} vertical />
			</div>
		</Card>
	);
}

function SamplesView(props: { trials: TrialRecord[] }) {
	const corpus = props.trials.filter((t) => t.output);
	return (
		<Card
			title="Sample outputs"
			hint="What each model actually produced (post thinking-strip + normalize)."
		>
			<div className="flex flex-col gap-2">
				{corpus.slice(0, 40).map((t, i) => (
					<div
						key={`${t.model}:${t.modifierId}:${t.sampleId}:${i}`}
						className="border-surface-5 rounded-lg border p-3"
					>
						<div className="text-foreground-muted mb-1 flex flex-wrap gap-2 text-xs">
							<span className="text-foreground font-medium">{t.model}</span>
							<span>· {t.modifierId}</span>
							<span>· {t.magnitude}</span>
							{t.judge ? <span>· style {t.judge.styleMatch}</span> : null}
							<span>· {t.guards.pass ? "guards ✓" : "guards ✗"}</span>
						</div>
						<div className="text-foreground whitespace-pre-wrap text-sm">
							{t.output}
						</div>
					</div>
				))}
			</div>
		</Card>
	);
}

function HistoryView(props: { history: StoredRun[] }) {
	const trend = props.history.map((run) => {
		const comps = run.aggregates.map((a) => a.composite);
		return comps.length ? comps.reduce((s, v) => s + v, 0) / comps.length : 0;
	});
	return (
		<Card
			title="Run history"
			hint="Persisted to tools/out/benchmark-runs.json across runs."
		>
			{props.history.length === 0 ? (
				<div className="text-foreground-muted text-sm">No saved runs yet.</div>
			) : (
				<>
					<div className="mb-4 max-w-md">
						<div className="text-foreground-muted mb-1 text-xs">
							Mean composite across runs (oldest → newest)
						</div>
						<Sparkline values={trend} className="h-10 w-full" />
					</div>
					<div className="flex flex-col gap-1.5">
						{[...props.history].reverse().map((run) => (
							<div
								key={run.id}
								className="border-surface-5 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border px-3 py-2 text-xs"
							>
								<span className="text-foreground font-mono">
									{new Date(run.startedAt).toLocaleString()}
								</span>
								<span className="text-foreground-muted">
									{run.models.length} model(s) · {run.modifiers.length}{" "}
									modifier(s)
								</span>
								<span className="text-foreground-muted">
									{run.aggregates.length} cells ·{" "}
									{(run.durationMs / 1000).toFixed(1)}s
								</span>
								<span className="text-foreground">
									comp{" "}
									{(
										run.aggregates.reduce((s, a) => s + a.composite, 0) /
										Math.max(1, run.aggregates.length)
									).toFixed(0)}
								</span>
							</div>
						))}
					</div>
				</>
			)}
		</Card>
	);
}

function Card(props: {
	title: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="border-surface-5 bg-surface-2/40 mb-4 rounded-xl border p-4">
			<div className="text-foreground text-sm font-semibold">{props.title}</div>
			{props.hint ? (
				<div className="text-foreground-muted mb-3 mt-0.5 text-xs">
					{props.hint}
				</div>
			) : (
				<div className="mb-3" />
			)}
			<div className="overflow-x-auto">{props.children}</div>
		</div>
	);
}

function Legend(props: { models: string[]; vertical?: boolean }) {
	return (
		<div
			className={
				props.vertical ? "flex flex-col gap-1.5" : "mb-2 flex flex-wrap gap-3"
			}
		>
			{props.models.map((m, i) => (
				<span
					key={m}
					className="text-foreground-muted inline-flex items-center gap-1.5 font-mono text-xs"
				>
					<i
						className="inline-block h-2.5 w-2.5 rounded-sm"
						style={{ background: seriesColor(i) }}
					/>
					{m}
				</span>
			))}
		</div>
	);
}

function uniquePreserveOrder(arr: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const x of arr)
		if (!seen.has(x)) {
			seen.add(x);
			out.push(x);
		}
	return out;
}
