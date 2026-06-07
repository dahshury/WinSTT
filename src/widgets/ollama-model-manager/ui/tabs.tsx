import type {
	OllamaModel,
	OllamaPullProgress,
	RecommendedOllamaModel,
} from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { isCustomModelQuery } from "../lib/filter";
import { CustomPullRow, InstalledRow, RecommendedRow } from "./rows";
import type { Tab } from "./chrome";
import type { TranslateFn } from "./types";

export interface InstalledTabProps {
	current: string;
	deletingName: string | null;
	hasQuery: boolean;
	models: OllamaModel[];
	onAskDelete: (name: string) => void;
	onSelect: (name: string) => void;
	t: TranslateFn;
}

function InstalledTab(props: InstalledTabProps) {
	const { models, current, t, hasQuery, deletingName, onSelect, onAskDelete } =
		props;
	const emptyBg = surfaceBg(Math.min(useSurface() + 1, 8));
	if (models.length === 0) {
		const key = hasQuery ? "noInstalledMatches" : "noInstalledModels";
		return (
			<p
				className={cn("rounded-md p-3 text-foreground-muted text-sm", emptyBg)}
			>
				{t(key)}
			</p>
		);
	}
	return (
		<div className="flex flex-col gap-2">
			{models.map((m) => (
				<InstalledRow
					current={m.name === current}
					deleting={deletingName === m.name}
					key={m.name}
					model={m}
					onDelete={onAskDelete}
					onSelect={onSelect}
					t={t}
				/>
			))}
		</div>
	);
}

export interface RecommendedTabProps {
	models: RecommendedOllamaModel[];
	onCancel: (name: string) => void;
	onPull: (name: string) => void;
	pulls: Record<string, OllamaPullProgress>;
	query: string;
	t: TranslateFn;
}

function RecommendedTab(props: RecommendedTabProps) {
	const { models, pulls, query, t, onPull, onCancel } = props;
	const emptyBg = surfaceBg(Math.min(useSurface() + 1, 8));
	const customPullName = query.trim();
	const customPull = customPullName ? pulls[customPullName] : undefined;
	if (models.length === 0 && !isCustomModelQuery(customPullName)) {
		return (
			<p
				className={cn("rounded-md p-3 text-foreground-muted text-sm", emptyBg)}
			>
				{t("noRecommendedMatches")}
			</p>
		);
	}
	return (
		<div className="flex flex-col gap-2">
			<CustomPullRow
				onCancel={onCancel}
				onPull={onPull}
				pull={customPull}
				query={query}
				t={t}
			/>
			{models.map((m) => (
				<RecommendedRow
					key={m.name}
					model={m}
					onCancel={onCancel}
					onPull={onPull}
					pull={pulls[m.name]}
					t={t}
				/>
			))}
		</div>
	);
}

export interface BodyProps {
	current: string;
	deletingName: string | null;
	installed: OllamaModel[];
	onAskDelete: (name: string) => void;
	onCancel: (name: string) => void;
	onPull: (name: string) => void;
	onSelect: (name: string) => void;
	pulls: Record<string, OllamaPullProgress>;
	query: string;
	recommended: RecommendedOllamaModel[];
	t: TranslateFn;
	tab: Tab;
}

export function DialogBody(props: BodyProps) {
	const {
		tab,
		t,
		installed,
		recommended,
		pulls,
		query,
		current,
		deletingName,
	} = props;
	if (tab === "installed") {
		return (
			<InstalledTab
				current={current}
				deletingName={deletingName}
				hasQuery={query.trim().length > 0}
				models={installed}
				onAskDelete={props.onAskDelete}
				onSelect={props.onSelect}
				t={t}
			/>
		);
	}
	return (
		<RecommendedTab
			models={recommended}
			onCancel={props.onCancel}
			onPull={props.onPull}
			pulls={pulls}
			query={query}
			t={t}
		/>
	);
}
