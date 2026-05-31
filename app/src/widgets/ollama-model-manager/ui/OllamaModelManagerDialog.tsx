import {
	Cancel01Icon,
	CloudDownloadIcon,
	Delete02Icon,
	Search01Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/react/shallow";
import { RECOMMENDED_OLLAMA_MODELS, useLlmCatalogStore } from "@/entities/llm-catalog";
import type { OllamaModel, OllamaPullProgress, RecommendedOllamaModel } from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { Modal } from "@/shared/ui/modal";
import { Spinner } from "@/shared/ui/spinner";
import { Switcher } from "@/shared/ui/switcher";
import { TextField } from "@/shared/ui/text-field";
import { buildPullsMap, computePullPercent, pullStatusToI18nKey } from "../lib/dialog-helpers";
import {
	filterInstalledModels,
	filterRecommendedModels,
	formatGigabytes,
	isCustomModelQuery,
} from "../lib/filter";
import { buildTabOptions, createHandlePull } from "../lib/ollama-model-manager-test-helpers";

type TranslateFn = ReturnType<typeof useTranslations>;

type Tab = "installed" | "recommended";

export interface OllamaModelManagerDialogProps {
	currentModel: string;
	isOpen: boolean;
	onClose: () => void;
	onModelInstalled?: (model: string) => void;
}

const PULL_EXAMPLE = "qwen3:1.7b";
const OLLAMA_LIBRARY_URL = "https://ollama.com/library";

function localizePullStatus(progress: OllamaPullProgress, t: TranslateFn): string {
	// pullStatusToI18nKey returns a string key that is always valid in the "llm" namespace.
	// We cast through unknown to satisfy next-intl's strict key type.
	return t(pullStatusToI18nKey(progress.status) as Parameters<TranslateFn>[0]);
}

function PullProgressBar({ progress, t }: { progress: OllamaPullProgress; t: TranslateFn }) {
	const trackBg = surfaceBg(Math.min(useSurface() + 1, 8));
	const percent = computePullPercent(progress);
	const label = t("pullProgress", {
		percent,
		status: localizePullStatus(progress, t),
	});
	return (
		<div className="mt-2 flex flex-col gap-1">
			<div className={cn("h-1.5 w-full overflow-hidden rounded-full", trackBg)}>
				<output
					aria-label={label}
					className="block h-full bg-accent transition-all duration-150"
					style={{ width: `${percent}%` }}
				/>
			</div>
			<span className="text-foreground-muted text-xs">{label}</span>
		</div>
	);
}

interface InstalledRowProps {
	current: boolean;
	deleting: boolean;
	model: OllamaModel;
	onDelete: (name: string) => void;
	onSelect: (name: string) => void;
	t: TranslateFn;
}

interface DeleteButtonProps {
	deleting: boolean;
	modelName: string;
	onDelete: (name: string) => void;
	t: TranslateFn;
}

function DeleteButton({ deleting, modelName, onDelete, t }: DeleteButtonProps) {
	const buttonBg = surfaceBg(Math.min(useSurface() + 2, 8));
	return (
		<Button
			className={cn(
				"flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-error text-xs transition-colors hover:bg-error/10 disabled:cursor-not-allowed disabled:opacity-40",
				buttonBg
			)}
			disabled={deleting}
			onClick={(e) => {
				e.stopPropagation();
				onDelete(modelName);
			}}
		>
			{deleting ? <Spinner className="size-3" /> : <HugeiconsIcon icon={Delete02Icon} size={13} />}
			<span>{deleting ? t("deleting") : t("delete")}</span>
		</Button>
	);
}

function InstalledRow({ model, current, t, deleting, onSelect, onDelete }: InstalledRowProps) {
	const rowBg = surfaceBg(Math.min(useSurface() + 1, 8));
	return (
		<button
			className={cn(
				"flex w-full items-center gap-3 rounded-md border border-border px-3 py-2 text-left transition-colors hover:bg-surface-hover data-[current=true]:border-accent",
				rowBg
			)}
			data-current={current}
			onClick={() => onSelect(model.name)}
			type="button"
		>
			<HugeiconsIcon
				className={current ? "text-accent" : "text-foreground-muted"}
				icon={Tick02Icon}
				size={16}
			/>
			<div className="min-w-0 flex-1">
				<div className="truncate font-medium text-body text-foreground">{model.name}</div>
				<div className="text-foreground-muted text-xs">
					{t("modelSizeLabel", { size: formatGigabytes(model.size ?? 0) })}
				</div>
			</div>
			<DeleteButton deleting={deleting} modelName={model.name} onDelete={onDelete} t={t} />
		</button>
	);
}

interface RecommendedRowProps {
	model: RecommendedOllamaModel;
	onCancel: (name: string) => void;
	onPull: (name: string) => void;
	pull: OllamaPullProgress | undefined;
	t: TranslateFn;
}

function RecommendedRow({ model, t, pull, onPull, onCancel }: RecommendedRowProps) {
	const isPulling = pull != null;
	const sizeLabel = t("modelSizeLabel", { size: formatGigabytes(model.sizeBytes) });
	const paramsLabel = t("paramSizeLabel", { size: model.paramSize });
	const rowBg = surfaceBg(Math.min(useSurface() + 1, 8));
	return (
		<div className={cn("rounded-md border border-border px-3 py-2.5", rowBg)}>
			<div className="flex items-start gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
						<span className="font-medium text-body text-foreground">{model.displayName}</span>
						<span className="text-foreground-muted text-xs">{model.name}</span>
					</div>
					<div className="text-foreground-muted text-xs">
						{paramsLabel} · {sizeLabel}
					</div>
					<p className="mt-1 line-clamp-2 text-foreground-secondary text-xs leading-snug">
						{model.description}
					</p>
				</div>
				{isPulling ? (
					<Button
						className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface-secondary px-2.5 text-foreground-secondary text-xs transition-colors hover:bg-surface-hover"
						onClick={() => onCancel(model.name)}
					>
						<HugeiconsIcon icon={Cancel01Icon} size={13} />
						<span>{t("cancelPull")}</span>
					</Button>
				) : (
					<Button
						className="flex h-7 items-center gap-1.5 rounded-md border border-accent bg-accent px-2.5 text-white text-xs transition-colors hover:bg-accent-dim"
						onClick={() => onPull(model.name)}
					>
						<HugeiconsIcon icon={CloudDownloadIcon} size={13} />
						<span>{t("pull")}</span>
					</Button>
				)}
			</div>
			{pull && <PullProgressBar progress={pull} t={t} />}
		</div>
	);
}

interface CustomPullRowProps {
	onCancel: (name: string) => void;
	onPull: (name: string) => void;
	pull: OllamaPullProgress | undefined;
	query: string;
	t: TranslateFn;
}

function CustomPullRow({ t, query, pull, onPull, onCancel }: CustomPullRowProps) {
	const cancelBg = surfaceBg(Math.min(useSurface() + 2, 8));
	const trimmed = query.trim();
	if (!isCustomModelQuery(trimmed)) {
		return null;
	}
	const isPulling = pull != null;
	return (
		<div className="rounded-md border border-accent/30 border-dashed bg-surface-tertiary/40 px-3 py-2.5">
			<div className="flex items-start gap-3">
				<div className="min-w-0 flex-1">
					<div className="font-medium text-body text-foreground">{t("pullCustomModel")}</div>
					<div className="text-foreground-muted text-xs">
						{t("pullCustomModelDescription", { example: PULL_EXAMPLE })}
					</div>
					<div className="mt-1 truncate font-mono text-accent text-xs">{trimmed}</div>
				</div>
				{isPulling ? (
					<Button
						className={cn(
							"flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-foreground-secondary text-xs transition-colors hover:bg-surface-hover",
							cancelBg
						)}
						onClick={() => onCancel(trimmed)}
					>
						<HugeiconsIcon icon={Cancel01Icon} size={13} />
						<span>{t("cancelPull")}</span>
					</Button>
				) : (
					<Button
						className="flex h-7 items-center gap-1.5 rounded-md border border-accent bg-accent px-2.5 text-white text-xs transition-colors hover:bg-accent-dim"
						onClick={() => onPull(trimmed)}
					>
						<HugeiconsIcon icon={CloudDownloadIcon} size={13} />
						<span>{t("pull")}</span>
					</Button>
				)}
			</div>
			{pull && <PullProgressBar progress={pull} t={t} />}
		</div>
	);
}

interface InstalledTabProps {
	current: string;
	deletingName: string | null;
	hasQuery: boolean;
	models: OllamaModel[];
	onAskDelete: (name: string) => void;
	onSelect: (name: string) => void;
	t: TranslateFn;
}

function InstalledTab(props: InstalledTabProps) {
	const { models, current, t, hasQuery, deletingName, onSelect, onAskDelete } = props;
	const emptyBg = surfaceBg(Math.min(useSurface() + 1, 8));
	if (models.length === 0) {
		const key = hasQuery ? "noInstalledMatches" : "noInstalledModels";
		return <p className={cn("rounded-md p-3 text-foreground-muted text-sm", emptyBg)}>{t(key)}</p>;
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

interface RecommendedTabProps {
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
			<p className={cn("rounded-md p-3 text-foreground-muted text-sm", emptyBg)}>
				{t("noRecommendedMatches")}
			</p>
		);
	}
	return (
		<div className="flex flex-col gap-2">
			<CustomPullRow onCancel={onCancel} onPull={onPull} pull={customPull} query={query} t={t} />
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

interface DialogState {
	deletingName: string | null;
	pendingDelete: string | null;
	query: string;
	tab: Tab;
}

interface DialogActions {
	setDeletingName: (n: string | null) => void;
	setPendingDelete: (n: string | null) => void;
	setQuery: (q: string) => void;
	setTab: (t: Tab) => void;
}

function useDialogState(): [DialogState, DialogActions] {
	const [tab, setTab] = useState<Tab>("installed");
	const [query, setQuery] = useState("");
	const [deletingName, setDeletingName] = useState<string | null>(null);
	const [pendingDelete, setPendingDelete] = useState<string | null>(null);
	return [
		{ tab, query, deletingName, pendingDelete },
		{ setTab, setQuery, setDeletingName, setPendingDelete },
	];
}

interface DialogHeaderProps {
	onClose: () => void;
	t: TranslateFn;
	tc: TranslateFn;
}

function DialogHeader({ t, tc, onClose }: DialogHeaderProps) {
	const closeBg = surfaceBg(Math.min(useSurface() + 2, 8));
	return (
		<div className="flex items-start justify-between gap-3">
			<div className="min-w-0 flex-1">
				<h2 className="font-semibold text-foreground text-lg">{t("manageModelsTitle")}</h2>
				<p className="mt-1 text-foreground-secondary text-sm">{t("manageModelsDescription")}</p>
			</div>
			<Button
				aria-label={tc("close")}
				className={cn(
					"size-8 shrink-0 rounded-md border border-border text-foreground-secondary transition-colors hover:bg-surface-hover",
					closeBg
				)}
				onClick={onClose}
			>
				<HugeiconsIcon icon={Cancel01Icon} size={14} />
			</Button>
		</div>
	);
}

function DialogSearch({
	query,
	t,
	onChange,
}: {
	query: string;
	t: TranslateFn;
	onChange: (v: string) => void;
}) {
	return (
		<div className="relative">
			<TextField
				className="pl-8"
				onChange={(e) => onChange(e.target.value)}
				placeholder={t("modelSearchPlaceholder")}
				value={query}
			/>
			<HugeiconsIcon
				className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-foreground-muted"
				icon={Search01Icon}
				size={14}
			/>
		</div>
	);
}

function DialogFooter({ t }: { t: TranslateFn }) {
	return (
		<div className="border-border border-t pt-3">
			<a
				className="inline-flex items-center gap-1.5 text-accent text-xs hover:underline"
				href={OLLAMA_LIBRARY_URL}
				rel="noreferrer"
				target="_blank"
			>
				{t("openLibrary")} →
			</a>
		</div>
	);
}

interface BodyProps {
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

function DialogBody(props: BodyProps) {
	const { tab, t, installed, recommended, pulls, query, current, deletingName } = props;
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

export function OllamaModelManagerDialog(props: OllamaModelManagerDialogProps) {
	const { isOpen, onClose, currentModel, onModelInstalled } = props;
	const t = useTranslations("llm");
	const tc = useTranslations("common");

	const { models, pulls, pullModel, cancelPull, deleteModel } = useLlmCatalogStore(
		useShallow((s) => ({
			models: s.models,
			pulls: s.pulls,
			pullModel: s.pullModel,
			cancelPull: s.cancelPull,
			deleteModel: s.deleteModel,
		}))
	);

	const [state, actions] = useDialogState();
	const { tab, query, deletingName, pendingDelete } = state;

	const installed = filterInstalledModels(models, query);
	const installedNames = new Set(models.map((m) => m.name));
	const recommended = filterRecommendedModels(RECOMMENDED_OLLAMA_MODELS, installedNames, query);
	const pullProgress = buildPullsMap(pulls);

	const handlePull = createHandlePull(pullModel, onModelInstalled);

	const handleConfirmDelete = async () => {
		if (!pendingDelete) {
			return;
		}
		const target = pendingDelete;
		actions.setPendingDelete(null);
		actions.setDeletingName(target);
		// React Compiler can't lower try/finally without a catch
		// (BuildHIR::lowerStatement TODO), so we capture and rethrow.
		let caught: unknown;
		try {
			await deleteModel(target);
		} catch (err) {
			caught = err;
		}
		actions.setDeletingName(null);
		if (caught !== undefined) {
			throw caught;
		}
	};

	const handleSelect = (name: string) => {
		if (onModelInstalled) {
			onModelInstalled(name);
		}
		onClose();
	};

	return (
		<>
			<Modal isOpen={isOpen} onClose={onClose}>
				<div className="flex w-[640px] max-w-[90vw] flex-col gap-4 p-6">
					<DialogHeader onClose={onClose} t={t} tc={tc} />
					<DialogSearch onChange={actions.setQuery} query={query} t={t} />
					<Switcher
						fullWidth={true}
						onChange={actions.setTab}
						options={buildTabOptions(t)}
						value={tab}
					/>
					<div className="max-h-[420px] overflow-y-auto pr-1">
						<DialogBody
							current={currentModel}
							deletingName={deletingName}
							installed={installed}
							onAskDelete={actions.setPendingDelete}
							onCancel={cancelPull}
							onPull={handlePull}
							onSelect={handleSelect}
							pulls={pullProgress}
							query={query}
							recommended={recommended}
							t={t}
							tab={tab}
						/>
					</div>
					<DialogFooter t={t} />
				</div>
			</Modal>

			<ConfirmDialog
				cancelLabel={tc("cancel")}
				confirmLabel={t("delete")}
				description={t("deleteConfirmDescription", { model: pendingDelete ?? "" })}
				onConfirm={handleConfirmDelete}
				onOpenChange={(open) => {
					if (!open) {
						actions.setPendingDelete(null);
					}
				}}
				open={pendingDelete != null}
				title={t("deleteConfirmTitle")}
			/>
		</>
	);
}
