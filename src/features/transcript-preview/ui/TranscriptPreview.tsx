import {
  AiMagicIcon,
  ArrowLeft01Icon,
  Cancel01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { useSettingsStore } from "@/entities/setting";
import {
  cancelPreview,
  confirmPaste,
  type LlmPreviewConfig,
  runLlmPreview,
} from "@/shared/api/ipc-client";
import { cn } from "@/shared/lib/cn";
import { useEscapeToClose } from "@/shared/lib/window-effects";
import {
  ALL_PRESET_KEYS,
  type CustomModifier,
  type PresetEntry,
  type PresetKey,
} from "@/shared/lib/preset-prompts";
import { Button } from "@/shared/ui/button";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { IconButton } from "@/shared/ui/icon-button";
import { Switcher, type SwitcherOption } from "@/shared/ui/switcher";
import { ThinkingIndicator } from "@/shared/ui/thinking-indicator";
import {
  type EnhanceScope,
  type EnhanceSource,
  useTranscriptPreviewStore,
} from "../model/preview-store";

/** Built-in preset key → `llm` i18n label key (matches the LLM settings panel). */
const PRESET_LABEL_KEY = {
  neutral: "presetNeutral",
  formal: "presetFormal",
  friendly: "presetFriendly",
  technical: "presetTechnical",
  concise: "presetConcise",
  summarize: "presetSummarize",
  reorder: "presetReorder",
  restructure: "presetRestructure",
  rewordForClarity: "presetRewordForClarity",
  translate: "presetTranslate",
} as const satisfies Record<PresetKey, string>;

type AppSettings = ReturnType<typeof useSettingsStore.getState>["settings"];
type LlmSettings = AppSettings["llm"];

function hasRunnableDictationPreviewLlm(llm: LlmSettings | undefined): boolean {
  const dictation = llm?.dictation;
  if (!dictation) {
    return false;
  }
  if (dictation.provider === "apple-intelligence") {
    return true;
  }
  if (dictation.provider === "openrouter") {
    return (
      (llm?.openrouterApiKey ?? "").trim().length > 0 &&
      dictation.openrouterModel.trim().length > 0
    );
  }
  return dictation.model.trim().length > 0;
}

function selectedCustomModifierToRuntime(
  modifier: CustomModifier,
): CustomModifier {
  const base: CustomModifier = {
    enabled: modifier.enabled,
    id: modifier.id,
    levelsEnabled: modifier.levelsEnabled,
    name: modifier.name,
    prompt: modifier.prompt,
  };
  return modifier.level === undefined
    ? base
    : { ...base, level: modifier.level };
}

/** Plays the transitions.dev stagger reveal once on mount (and on `key` change,
 *  which React turns into a remount). Wrap text lines as `.t-stagger-line`. */
function StaggerReveal({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div className={cn("t-stagger", shown && "is-shown", className)}>
      {children}
    </div>
  );
}

/** A toggle chip for a preset / custom modifier (selected = accent ring). */
function ModifierChip({
  active,
  label,
  onToggle,
}: {
  active: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <Button
      aria-pressed={active}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs transition-colors",
        active
          ? "border-accent/60 bg-accent/15 text-foreground"
          : "border-border bg-surface-2 text-foreground-muted hover:text-foreground",
      )}
      onClick={onToggle}
      type="button"
    >
      {label}
    </Button>
  );
}

/** The magic-button post-process configurator (enhance view). */
function EnhanceView() {
  const tp = useTranslations("preview");
  const tl = useTranslations("llm");
  const store = useTranscriptPreviewStore();
  const dictation = useSettingsStore((s) => s.settings.llm?.dictation);
  const customModifiers = dictation?.customModifiers ?? [];
  const hasSelection = store.selEnd > store.selStart;

  const sourceOptions: SwitcherOption<EnhanceSource>[] = [
    { value: "current", label: tp("sourceCurrent") },
    { value: "original", label: tp("sourceOriginal") },
  ];
  const scopeOptions: SwitcherOption<EnhanceScope>[] = [
    { value: "whole", label: tp("scopeWhole") },
    { value: "selection", label: tp("scopeSelection") },
  ];
  // Selection scope indexes into the editable text, so it only applies to the
  // "current" source with a live selection.
  const scopeEnabled = hasSelection && store.source === "current";

  const runEnhance = async () => {
    const s = useTranscriptPreviewStore.getState();
    const sourceText = s.source === "original" ? s.original : s.text;
    let range: { start: number; end: number } | null = null;
    let input = sourceText;
    if (
      s.scope === "selection" &&
      s.source === "current" &&
      s.selEnd > s.selStart
    ) {
      range = { start: s.selStart, end: s.selEnd };
      input = s.text.slice(range.start, range.end);
    }
    // Build the dictation-config override from the toggled modifiers + the
    // free-text instruction. Built-in entries reuse the dictation config's
    // entry (preserving level / targetLang) when present.
    const presets: PresetEntry[] = s.selectedPresetKeys.map((key) => {
      const existing = dictation?.presets?.find((p) => p.key === key);
      return existing ?? { key };
    });
    const mods: CustomModifier[] = s.selectedModifierIds
      .map((id) => customModifiers.find((m) => m.id === id))
      .filter((m): m is CustomModifier => m !== undefined)
      .map(selectedCustomModifierToRuntime);
    const instruction = s.customInstruction.trim();
    if (instruction) {
      mods.push({
        id: "__preview_custom__",
        enabled: true,
        name: "custom",
        prompt: instruction,
        levelsEnabled: false,
      });
    }
    const config: LlmPreviewConfig = {
      provider: dictation?.provider ?? "ollama",
      model: dictation?.model ?? "",
      openrouterModel: dictation?.openrouterModel ?? "",
      openrouterFallbackModel: dictation?.openrouterFallbackModel ?? "",
      reasoningEffort: dictation?.reasoningEffort ?? "medium",
      verbosity: dictation?.verbosity ?? "medium",
      maxOutputTokens: dictation?.maxOutputTokens ?? null,
      thinkingEffort: dictation?.thinkingEffort ?? "medium",
      presets,
      customModifiers: mods,
    };
    s.beginProcessing(range);
    try {
      const result = await runLlmPreview(input, "dictation", config);
      useTranscriptPreviewStore.getState().finishProcessing(result ?? null);
    } catch (error) {
      console.error("[preview] LLM preview failed:", error);
      useTranscriptPreviewStore.getState().finishProcessing(null);
    }
  };

  if (store.isProcessing) {
    return (
      <StaggerReveal className="px-1 py-2">
        <ThinkingIndicator
          fluidWidth
          reasoning={store.reasoning}
          startedAt={store.processStartedAt}
        />
      </StaggerReveal>
    );
  }

  return (
    <div className="flex flex-col gap-2.5 px-1">
      <div className="flex items-center gap-2">
        <IconButton
          aria-label={tp("back")}
          icon={<HugeiconsIcon icon={ArrowLeft01Icon} size={16} />}
          onClick={() => store.setView("edit")}
        />
        <span className="font-medium text-foreground text-sm">
          {tp("enhanceTitle")}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <ElevatedSurface>
          <Switcher
            onChange={(v) => store.setSource(v)}
            options={sourceOptions}
            value={store.source}
          />
        </ElevatedSurface>
        <ElevatedSurface
          className={cn(
            "transition-opacity",
            !scopeEnabled && "pointer-events-none opacity-40",
          )}
        >
          <Switcher
            onChange={(v) => store.setScope(v)}
            options={scopeOptions}
            value={scopeEnabled ? store.scope : "whole"}
          />
        </ElevatedSurface>
      </div>

      <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
        {ALL_PRESET_KEYS.map((key) => (
          <ModifierChip
            active={store.selectedPresetKeys.includes(key)}
            key={key}
            label={tl(PRESET_LABEL_KEY[key] ?? key)}
            onToggle={() => store.togglePreset(key)}
          />
        ))}
        {customModifiers.map((m) => (
          <ModifierChip
            active={store.selectedModifierIds.includes(m.id)}
            key={m.id}
            label={m.name || tl("modifierUnnamed")}
            onToggle={() => store.toggleModifier(m.id)}
          />
        ))}
      </div>

      <textarea
        className="min-h-[2.25rem] w-full resize-none rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-foreground text-sm placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-accent/60"
        dir="auto"
        onChange={(e) => store.setCustomInstruction(e.currentTarget.value)}
        placeholder={tp("customInstructionPlaceholder")}
        rows={2}
        value={store.customInstruction}
      />

      <div className="flex justify-end">
        <Button
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 font-medium text-sm text-white transition-colors hover:bg-accent-hover"
          onClick={runEnhance}
        >
          <HugeiconsIcon icon={AiMagicIcon} size={15} />
          {tp("run")}
        </Button>
      </div>
    </div>
  );
}

/** The LLM result awaiting approve/discard. */
function ReviewView() {
  const tp = useTranslations("preview");
  const store = useTranscriptPreviewStore();
  if (store.isProcessing) {
    return (
      <StaggerReveal className="px-1 py-2">
        <ThinkingIndicator
          fluidWidth
          reasoning={store.reasoning}
          startedAt={store.processStartedAt}
        />
      </StaggerReveal>
    );
  }
  return (
    <div className="flex flex-col gap-2.5 px-1">
      <span className="font-medium text-foreground text-sm">
        {tp("reviewTitle")}
      </span>
      <ElevatedSurface className="rounded-md">
        <StaggerReveal className="max-h-40 overflow-y-auto px-3 py-2">
          <p
            className="t-stagger-line whitespace-pre-wrap text-foreground text-sm leading-snug"
            dir="auto"
          >
            {store.candidate}
          </p>
        </StaggerReveal>
      </ElevatedSurface>
      <div className="flex justify-end gap-2">
        <Button
          className="rounded-md border border-border px-3 py-1.5 text-foreground-muted text-sm transition-colors hover:text-foreground"
          onClick={() => store.discard()}
        >
          {tp("discard")}
        </Button>
        <Button
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 font-medium text-sm text-white transition-colors hover:bg-accent-hover"
          onClick={() => store.approve()}
        >
          <HugeiconsIcon icon={Tick02Icon} size={15} />
          {tp("approve")}
        </Button>
      </div>
    </div>
  );
}

/** The transcript review + toolbar (default view). */
function EditView() {
  const tp = useTranslations("preview");
  const store = useTranscriptPreviewStore();
  const llm = useSettingsStore((s) => s.settings.llm);
  const dictation = llm?.dictation;
  const enhanceEnabled = hasRunnableDictationPreviewLlm(llm);

  const send = () => {
    const text = useTranscriptPreviewStore.getState().text;
    void confirmPaste(text);
    store.reset();
  };

  const openEnhance = () => {
    const presetKeys = (dictation?.presets ?? [])
      .map((p) => p.key)
      .filter((key): key is PresetKey =>
        (ALL_PRESET_KEYS as readonly string[]).includes(key),
      );
    const modifierIds = (dictation?.customModifiers ?? [])
      .filter((m) => m.enabled)
      .map((m) => m.id);
    store.seedEnhance(presetKeys, modifierIds);
    store.setView("enhance");
  };

  return (
    <div className="flex flex-col gap-2 px-1">
      <StaggerReveal>
        <textarea
          className="t-stagger-line max-h-56 min-h-[3rem] w-full resize-none rounded-md border border-border bg-surface-2 px-2.5 py-2 text-foreground text-sm leading-snug placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-accent/60"
          dir="auto"
          onChange={(e) => {
            store.setText(e.currentTarget.value);
            store.setSelection(
              e.currentTarget.selectionStart,
              e.currentTarget.selectionEnd,
            );
          }}
          onSelect={(e) =>
            store.setSelection(
              e.currentTarget.selectionStart,
              e.currentTarget.selectionEnd,
            )
          }
          placeholder={tp("placeholder")}
          value={store.text}
        />
      </StaggerReveal>
      <div className="flex items-center justify-between gap-2">
        <Button
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-foreground-muted text-sm transition-colors hover:text-foreground"
          disabled={!enhanceEnabled}
          onClick={openEnhance}
          title={enhanceEnabled ? undefined : tp("enhanceDisabled")}
        >
          <HugeiconsIcon icon={AiMagicIcon} size={15} />
          {tp("enhance")}
        </Button>
        <Button
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-1.5 font-medium text-sm text-white transition-colors hover:bg-accent-hover"
          onClick={send}
        >
          <HugeiconsIcon icon={Tick02Icon} size={15} />
          {tp("send")}
        </Button>
      </div>
    </div>
  );
}

/**
 * The preview-before-pasting pill content. Rendered inside both the dynamic
 * island and the floating-bottom bubble when `isPreviewActive`. A small
 * view state machine (edit → enhance → review) that morphs the pill height
 * (the shells animate height as a CSS property — no `layout` distortion) and
 * staggers text in via the transitions.dev `.t-stagger` recipe.
 */
export function TranscriptPreview() {
  const tp = useTranslations("preview");
  const view = useTranscriptPreviewStore((s) => s.view);
  const reset = useTranscriptPreviewStore((s) => s.reset);

  const dismiss = useCallback(() => {
    void cancelPreview();
    reset();
  }, [reset]);
  useEscapeToClose(dismiss);

  return (
    <div className="pointer-events-auto relative w-[520px] max-w-full px-3 pt-2 pb-3 text-left">
      <div className="absolute top-1.5 right-2 z-raised">
        <IconButton
          aria-label={tp("dismiss")}
          icon={<HugeiconsIcon icon={Cancel01Icon} size={14} />}
          onClick={dismiss}
        />
      </div>
      {/* `key={view}` remounts on view change → the StaggerReveal replays and
			    the shell's fitContent height tweens to the new content. */}
      <div key={view}>
        {view === "edit" ? <EditView /> : null}
        {view === "enhance" ? <EnhanceView /> : null}
        {view === "review" ? <ReviewView /> : null}
      </div>
    </div>
  );
}
