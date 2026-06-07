import { useTranslations } from "use-intl";
import { useShallow } from "zustand/react/shallow";
import {
  RECOMMENDED_OLLAMA_MODELS,
  useLlmCatalogStore,
} from "@/entities/llm-catalog";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { Modal } from "@/shared/ui/modal";
import { Switcher } from "@/shared/ui/switcher";
import {
  buildPullsMap,
} from "../lib/dialog-helpers";
import {
  filterInstalledModels,
  filterRecommendedModels,
} from "../lib/filter";
import {
  buildTabOptions,
  createHandlePull,
} from "../lib/ollama-model-manager-test-helpers";
import {
  DialogFooter,
  DialogHeader,
  DialogSearch,
  useDialogState,
} from "./chrome";
import { DialogBody } from "./tabs";

export interface OllamaModelManagerDialogProps {
  currentModel: string;
  isOpen: boolean;
  onClose: () => void;
  onModelInstalled?: (model: string) => void;
}

export function OllamaModelManagerDialog(props: OllamaModelManagerDialogProps) {
  const { isOpen, onClose, currentModel, onModelInstalled } = props;
  const t = useTranslations("llm");
  const tc = useTranslations("common");

  const { models, pulls, pullModel, cancelPull, deleteModel } =
    useLlmCatalogStore(
      useShallow((s) => ({
        models: s.models,
        pulls: s.pulls,
        pullModel: s.pullModel,
        cancelPull: s.cancelPull,
        deleteModel: s.deleteModel,
      })),
    );

  const [state, actions] = useDialogState();
  const { tab, query, deletingName, pendingDelete } = state;

  const installed = filterInstalledModels(models, query);
  const installedNames = new Set(models.map((m) => m.name));
  const recommended = filterRecommendedModels(
    RECOMMENDED_OLLAMA_MODELS,
    installedNames,
    query,
  );
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
        description={t("deleteConfirmDescription", {
          model: pendingDelete ?? "",
        })}
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
