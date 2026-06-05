import { Button as BaseButton } from "@base-ui/react/button";
import {
  ArrowRight02Icon,
  ArrowUpRight01Icon,
  CheckmarkCircle02Icon,
  Cursor01Icon,
  Download04Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import {
  findRecommendedModel,
  useLlmCatalogStore,
} from "@/entities/llm-catalog";
import { useSettingsStore } from "@/entities/setting";
import { useLlmModelPickerStore } from "@/features/llm-model-picker";
import {
  detectOllama,
  type OllamaDetectResult,
  startOllama,
} from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { FormControl } from "@/shared/ui/form-control";
import { PulseDot } from "@/shared/ui/pulse-dot";
import { Toggle } from "@/shared/ui/toggle";

const OLLAMA_HOMEPAGE = "https://ollama.com/download";
const START_BUTTON_MOTION_PROPS = {
  whileHover: { y: -1 },
  whileTap: { scale: 0.97 },
} as const;
const MotionBaseButton = m.create(BaseButton);

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
  const t = useTranslations("onboarding");
  const reduceMotion = useReducedMotion();
  const [detect, setDetect] = useState<OllamaDetectResult | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const openModelPicker = useLlmModelPickerStore((s) => s.openFor);
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
      <AnimatePresence initial={false} mode="wait">
        <m.div
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          className="flex items-center gap-2 px-1 py-1.5 text-body-sm text-foreground-muted"
          exit={{ opacity: 0, y: -4, filter: "blur(2px)" }}
          initial={
            reduceMotion ? false : { opacity: 0, y: 4, filter: "blur(2px)" }
          }
          key="detecting"
          transition={{
            duration: reduceMotion ? 0 : 0.18,
            ease: [0.22, 1, 0.36, 1],
          }}
        >
          <PulseDot className="size-2" />
          <span>{t("lookingForOllama")}</span>
        </m.div>
      </AnimatePresence>
    );
  }

  if (!detect.installed) {
    return (
      <AnimatePresence initial={false} mode="wait">
        <m.div
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: -5, filter: "blur(2px)" }}
          initial={
            reduceMotion ? false : { opacity: 0, y: 6, filter: "blur(3px)" }
          }
          key="not-installed"
          transition={{
            duration: reduceMotion ? 0 : 0.2,
            ease: [0.22, 1, 0.36, 1],
          }}
        >
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
                  setStartError(result.error ?? t("couldNotStartOllama"));
                  return;
                })
                .finally(() => setStarting(false));
            }}
            starting={starting}
          />
        </m.div>
      </AnimatePresence>
    );
  }

  const enabled = llmDictation.enabled;
  const selectedModel = llmDictation.model;
  const displayName = formatModelLabel(selectedModel, installedModels, t);
  const isInstalled =
    !!selectedModel && installedModels.some((m) => m.name === selectedModel);

  const handleToggle = (next: boolean) => {
    if (!next) {
      updateLlmDictation({ enabled: false });
      return;
    }
    // Never enable without a real, installed model (feedback_capability_must_have_model).
    // If the current pick is installed, enable immediately; otherwise open the
    // picker and let the install commit `enabled` (OnboardingPage wires the
    // model-installed callback through the shared llm-model-picker store).
    // Dismissing the picker without installing leaves the toggle off.
    if (isInstalled) {
      updateLlmDictation({
        enabled: true,
        model: selectedModel,
        provider: "ollama",
      });
      return;
    }
    openModelPicker("dictation", true);
  };

  return (
    <AnimatePresence initial={false} mode="wait">
      <m.div
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        className="flex flex-col gap-3"
        exit={{ opacity: 0, y: -5, filter: "blur(2px)" }}
        initial={
          reduceMotion ? false : { opacity: 0, y: 6, filter: "blur(3px)" }
        }
        key="installed"
        transition={{
          duration: reduceMotion ? 0 : 0.2,
          ease: [0.22, 1, 0.36, 1],
        }}
      >
        <m.div
          animate={{ opacity: 1, scale: 1, y: 0 }}
          className="flex items-center gap-2 rounded-md bg-success/10 px-3 py-2 text-body-sm text-success ring-1 ring-success/25"
          initial={reduceMotion ? false : { opacity: 0, scale: 0.98, y: 4 }}
          transition={{ type: "spring", stiffness: 580, damping: 34 }}
        >
          <m.span
            animate={{ rotate: 0, scale: 1 }}
            className="inline-flex"
            initial={reduceMotion ? false : { rotate: -28, scale: 0.55 }}
            transition={{ type: "spring", stiffness: 700, damping: 26 }}
          >
            <HugeiconsIcon icon={CheckmarkCircle02Icon} size={13} />
          </m.span>
          <span className="font-medium">{t("ollamaRunning")}</span>
        </m.div>

        <FormControl
          caption={t("modelCaption")}
          label={t("modelLabel")}
          layout="stacked"
        >
          <ElevatedSurface inline>
            <MotionBaseButton
              className={cn(
                "flex h-8 w-full items-center justify-between gap-2 rounded-lg bg-transparent px-3 text-left outline-none transition-colors duration-150",
                "hover:bg-foreground/[0.04]",
                "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1",
              )}
              onClick={() => openModelPicker("dictation", false)}
              whileHover={{ y: -1 }}
              whileTap={{ scale: 0.985 }}
              type="button"
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                {selectedModel ? (
                  <>
                    <span className="sr-only">
                      {isInstalled
                        ? t("modelInstalled")
                        : t("modelNotInstalledShort")}
                    </span>
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        isInstalled ? "bg-teal" : "bg-warning",
                      )}
                    />
                  </>
                ) : null}
                <span
                  className={cn(
                    "truncate text-body",
                    selectedModel ? "text-foreground" : "text-foreground-muted",
                  )}
                >
                  {displayName}
                </span>
              </span>
              <span className="inline-flex items-center gap-1 font-mono text-accent text-xs-tight uppercase tracking-[0.14em]">
                {t("browse")}
                <HugeiconsIcon icon={ArrowRight02Icon} size={10} />
              </span>
            </MotionBaseButton>
          </ElevatedSurface>
        </FormControl>

        <FormControl
          caption={t("cleanUpDictationCaption")}
          label={t("cleanUpDictation")}
          layout="row"
        >
          <Toggle
            aria-label={t("cleanUpDictationAria")}
            checked={enabled}
            onCheckedChange={handleToggle}
          />
        </FormControl>
      </m.div>
    </AnimatePresence>
  );
}

type OnboardingT = ReturnType<typeof useTranslations<"onboarding">>;

/** Human-readable label for the currently-selected model. */
function formatModelLabel(
  modelId: string,
  installed: readonly { name: string }[],
  t: OnboardingT,
): string {
  if (!modelId) {
    return t("noModelSelected");
  }
  const recommended = findRecommendedModel(modelId);
  if (recommended) {
    return `${recommended.displayName} · ${recommended.paramSize}`;
  }
  const isInstalled = installed.some((m) => m.name === modelId);
  return isInstalled ? modelId : t("modelNotInstalled", { model: modelId });
}

interface NotInstalledPanelProps {
  error: string | null;
  onStart: () => void;
  starting: boolean;
}

function NotInstalledPanel({
  error,
  starting,
  onStart,
}: NotInstalledPanelProps) {
  const t = useTranslations("onboarding");
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md bg-surface-2 px-4 py-3 ring-1 ring-divider">
        <div className="flex items-center gap-2 font-medium text-body text-foreground">
          <HugeiconsIcon
            className="text-foreground-muted"
            icon={Download04Icon}
            size={14}
          />
          {t("ollamaNotRunning")}
        </div>
        <p className="mt-1.5 text-body-sm text-foreground-muted leading-snug">
          {t("ollamaNotRunningBody")}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2.5">
          <MotionBaseButton
            className={cn(
              "inline-flex h-7 items-center justify-center rounded-md bg-accent px-3 font-medium text-body-sm text-white outline-none transition-[background-color,box-shadow] duration-150",
              "shadow-elevated hover:bg-accent-hover",
              "focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1",
              "disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none",
            )}
            disabled={starting}
            onClick={onStart}
            whileHover={START_BUTTON_MOTION_PROPS.whileHover}
            whileTap={START_BUTTON_MOTION_PROPS.whileTap}
            type="button"
          >
            <AnimatePresence initial={false} mode="wait">
              <m.span
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, y: -3, filter: "blur(2px)" }}
                initial={{ opacity: 0, y: 3, filter: "blur(2px)" }}
                key={starting ? "starting" : "start"}
                transition={{ duration: 0.14, ease: "easeInOut" }}
              >
                {starting ? t("startingOllama") : t("tryStartOllama")}
              </m.span>
            </AnimatePresence>
          </MotionBaseButton>
          <a
            className="inline-flex items-center gap-1 font-mono text-foreground-muted text-xs-tight uppercase tracking-[0.16em] underline-offset-4 transition-colors hover:text-foreground-secondary hover:underline"
            href={OLLAMA_HOMEPAGE}
            rel="noreferrer noopener"
            target="_blank"
          >
            <HugeiconsIcon icon={Cursor01Icon} size={10} />
            {t("installOllama")}
            <HugeiconsIcon icon={ArrowUpRight01Icon} size={10} />
          </a>
        </div>
        <AnimatePresence initial={false}>
          {error ? (
            <m.p
              animate={{ opacity: 1, x: 0 }}
              className="mt-2 text-body-sm text-error"
              exit={{ opacity: 0, x: -4 }}
              initial={{ opacity: 0, x: 4 }}
              transition={{ duration: 0.16, ease: "easeInOut" }}
            >
              {error}
            </m.p>
          ) : null}
        </AnimatePresence>
      </div>
      <p className="text-body-sm text-foreground-dim">
        {t("finishWithoutOllama")}
      </p>
    </div>
  );
}
