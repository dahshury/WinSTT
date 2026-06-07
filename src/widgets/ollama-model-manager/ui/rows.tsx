import { Button as BaseButton } from "@base-ui/react/button";
import {
  Cancel01Icon,
  CloudDownloadIcon,
  Delete02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  OllamaModel,
  OllamaPullProgress,
  RecommendedOllamaModel,
} from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { Button } from "@/shared/ui/button";
import { DialogActionButton } from "@/shared/ui/dialog";
import { Spinner } from "@/shared/ui/spinner";
import { formatGigabytes, isCustomModelQuery } from "../lib/filter";
import { computePullPercent } from "../lib/dialog-helpers";
import { localizePullStatus, type TranslateFn } from "./types";

const PULL_EXAMPLE = "qwen3:1.7b";

function PullProgressBar({
  progress,
  t,
}: {
  progress: OllamaPullProgress;
  t: TranslateFn;
}) {
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

export interface InstalledRowProps {
  current: boolean;
  deleting: boolean;
  model: OllamaModel;
  onDelete: (name: string) => void;
  onSelect: (name: string) => void;
  t: TranslateFn;
}

export interface DeleteButtonProps {
  deleting: boolean;
  modelName: string;
  onDelete: (name: string) => void;
  t: TranslateFn;
}

function DeleteButton({
  deleting,
  modelName,
  onDelete,
  t,
}: DeleteButtonProps) {
  const buttonBg = surfaceBg(Math.min(useSurface() + 2, 8));
  return (
    <Button
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-error text-xs transition-colors hover:bg-error/10 disabled:cursor-not-allowed disabled:opacity-40",
        buttonBg,
      )}
      disabled={deleting}
      onClick={(e) => {
        e.stopPropagation();
        onDelete(modelName);
      }}
    >
      {deleting ? (
        <Spinner className="size-3" />
      ) : (
        <HugeiconsIcon icon={Delete02Icon} size={13} />
      )}
      <span>{deleting ? t("deleting") : t("delete")}</span>
    </Button>
  );
}

export function InstalledRow({
  model,
  current,
  t,
  deleting,
  onSelect,
  onDelete,
}: InstalledRowProps) {
  const rowBg = surfaceBg(Math.min(useSurface() + 1, 8));
  return (
    <BaseButton
      className={cn(
        "flex w-full items-center gap-3 rounded-md border border-border px-3 py-2 text-left transition-colors hover:bg-surface-hover data-[current=true]:border-accent",
        rowBg,
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
        <div className="truncate font-medium text-body text-foreground">
          {model.name}
        </div>
        <div className="text-foreground-muted text-xs">
          {t("modelSizeLabel", { size: formatGigabytes(model.size ?? 0) })}
        </div>
      </div>
      <DeleteButton
        deleting={deleting}
        modelName={model.name}
        onDelete={onDelete}
        t={t}
      />
    </BaseButton>
  );
}

export interface RecommendedRowProps {
  model: RecommendedOllamaModel;
  onCancel: (name: string) => void;
  onPull: (name: string) => void;
  pull: OllamaPullProgress | undefined;
  t: TranslateFn;
}

export function RecommendedRow({
  model,
  t,
  pull,
  onPull,
  onCancel,
}: RecommendedRowProps) {
  const isPulling = pull != null;
  const sizeLabel = t("modelSizeLabel", {
    size: formatGigabytes(model.sizeBytes),
  });
  const paramsLabel = t("paramSizeLabel", { size: model.paramSize });
  const rowBg = surfaceBg(Math.min(useSurface() + 1, 8));
  return (
    <div className={cn("rounded-md border border-border px-3 py-2.5", rowBg)}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="font-medium text-body text-foreground">
              {model.displayName}
            </span>
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
          <DialogActionButton
            className="h-7 px-2.5 text-xs"
            onClick={() => onPull(model.name)}
            variant="accent"
          >
            <HugeiconsIcon icon={CloudDownloadIcon} size={13} />
            <span>{t("pull")}</span>
          </DialogActionButton>
        )}
      </div>
      {pull && <PullProgressBar progress={pull} t={t} />}
    </div>
  );
}

export interface CustomPullRowProps {
  onCancel: (name: string) => void;
  onPull: (name: string) => void;
  pull: OllamaPullProgress | undefined;
  query: string;
  t: TranslateFn;
}

export function CustomPullRow({
  t,
  query,
  pull,
  onPull,
  onCancel,
}: CustomPullRowProps) {
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
          <div className="font-medium text-body text-foreground">
            {t("pullCustomModel")}
          </div>
          <div className="text-foreground-muted text-xs">
            {t("pullCustomModelDescription", { example: PULL_EXAMPLE })}
          </div>
          <div className="mt-1 truncate font-mono text-accent text-xs">
            {trimmed}
          </div>
        </div>
        {isPulling ? (
          <Button
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-foreground-secondary text-xs transition-colors hover:bg-surface-hover",
              cancelBg,
            )}
            onClick={() => onCancel(trimmed)}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={13} />
            <span>{t("cancelPull")}</span>
          </Button>
        ) : (
          <DialogActionButton
            className="h-7 px-2.5 text-xs"
            onClick={() => onPull(trimmed)}
            variant="accent"
          >
            <HugeiconsIcon icon={CloudDownloadIcon} size={13} />
            <span>{t("pull")}</span>
          </DialogActionButton>
        )}
      </div>
      {pull && <PullProgressBar progress={pull} t={t} />}
    </div>
  );
}
