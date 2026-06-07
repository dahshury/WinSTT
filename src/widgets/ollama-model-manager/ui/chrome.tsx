import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import {
  DialogDescription,
  DialogTitle,
} from "@/shared/ui/dialog";
import { IconButton } from "@/shared/ui/icon-button";
import { ClearableTextField } from "@/shared/ui/text-field";
import type { TranslateFn } from "./types";

export type Tab = "installed" | "recommended";

const OLLAMA_LIBRARY_URL = "https://ollama.com/library";

export interface DialogState {
  deletingName: string | null;
  pendingDelete: string | null;
  query: string;
  tab: Tab;
}

export interface DialogActions {
  setDeletingName: (n: string | null) => void;
  setPendingDelete: (n: string | null) => void;
  setQuery: (q: string) => void;
  setTab: (t: Tab) => void;
}

export function useDialogState(): [DialogState, DialogActions] {
  const [tab, setTab] = useState<Tab>("installed");
  const [query, setQuery] = useState("");
  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  return [
    { tab, query, deletingName, pendingDelete },
    { setTab, setQuery, setDeletingName, setPendingDelete },
  ];
}

export interface DialogHeaderProps {
  onClose: () => void;
  t: TranslateFn;
  tc: TranslateFn;
}

export function DialogHeader({ t, tc, onClose }: DialogHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <DialogTitle>{t("manageModelsTitle")}</DialogTitle>
        <DialogDescription className="mt-1">
          {t("manageModelsDescription")}
        </DialogDescription>
      </div>
      <IconButton
        aria-label={tc("close")}
        className="shrink-0"
        icon={<HugeiconsIcon icon={Cancel01Icon} size={14} />}
        onClick={onClose}
      />
    </div>
  );
}

export function DialogSearch({
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
      <ClearableTextField
        clearLabel="Clear search"
        leadingIcon={
          <HugeiconsIcon aria-hidden="true" icon={Search01Icon} size={14} />
        }
        onValueChange={onChange}
        placeholder={t("modelSearchPlaceholder")}
        value={query}
      />
    </div>
  );
}

export function DialogFooter({ t }: { t: TranslateFn }) {
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
