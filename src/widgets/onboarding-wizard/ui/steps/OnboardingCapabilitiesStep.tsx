import {
  AiVoiceGeneratorIcon,
  CalendarAnalysisIcon,
  ClipboardPasteIcon,
  FileScriptIcon,
  MagicWand01Icon,
  PictureInPictureOnIcon,
  RecordIcon,
  SparklesIcon,
  TextSquareIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import { useTranslations } from "use-intl";
import { useSettingsStore } from "@/entities/setting";
import { cn } from "@/shared/lib/cn";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import { Toggle } from "@/shared/ui/toggle";

type PillTone = "accent" | "muted" | "success" | "warning";

interface FeatureTile {
  description: string;
  icon: IconSvgElement;
  status: string;
  statusTone: PillTone;
  title: string;
}

const CARD_SPRING = {
  type: "spring",
  stiffness: 360,
  damping: 32,
  mass: 0.8,
} as const;

export function OnboardingCapabilitiesStep() {
  const tOnboarding = useTranslations("onboarding");
  const tSettings = useTranslations("settings");
  const tGeneral = useTranslations("general");
  const tHistory = useTranslations("history");
  const tLlm = useTranslations("llm");
  const tTts = useTranslations("tts");
  const general = useSettingsStore((s) => s.settings.general);
  const ttsEnabled = useSettingsStore((s) => s.settings.tts.enabled);
  const llmDictationEnabled = useSettingsStore(
    (s) => s.settings.llm.dictation.enabled,
  );
  const transformsEnabled = useSettingsStore(
    (s) => s.settings.llm.transforms.enabled,
  );
  const updateGeneral = useSettingsStore((s) => s.updateGeneralSettings);
  const reduceMotion = useReducedMotion();

  const dynamicIslandEnabled =
    (general.showRecordingOverlay ?? true) &&
    general.overlayMode === "dynamic-island";
  const reviewEnabled = general.previewBeforePasting ?? false;

  const featureTiles: readonly FeatureTile[] = [
    {
      icon: RecordIcon,
      title: tGeneral("recordingMode"),
      description: tSettings("tabRecordingTooltip"),
      status: tOnboarding("capabilitiesStatusReady"),
      statusTone: "success",
    },
    {
      icon: SparklesIcon,
      title: tLlm("title"),
      description: tLlm("subDictationCaption"),
      status: llmDictationEnabled
        ? tOnboarding("capabilitiesStatusEnabled")
        : tOnboarding("capabilitiesStatusNextStep"),
      statusTone: llmDictationEnabled ? "success" : "accent",
    },
    {
      icon: MagicWand01Icon,
      title: tLlm("subTransformTitle"),
      description: tLlm("subTransformCaption"),
      status: transformsEnabled
        ? tOnboarding("capabilitiesStatusEnabled")
        : tOnboarding("capabilitiesStatusSettings"),
      statusTone: transformsEnabled ? "success" : "muted",
    },
    {
      icon: AiVoiceGeneratorIcon,
      title: tTts("title"),
      description: tTts("description"),
      status: ttsEnabled
        ? tOnboarding("capabilitiesStatusEnabled")
        : tOnboarding("capabilitiesStatusOptional"),
      statusTone: ttsEnabled ? "success" : "warning",
    },
    {
      icon: FileScriptIcon,
      title: tGeneral("fileTranscription"),
      description: tGeneral("fileTranscriptionSaveLocationTooltip"),
      status: tOnboarding("capabilitiesStatusReady"),
      statusTone: "success",
    },
    {
      icon: CalendarAnalysisIcon,
      title: tHistory("pageTitle"),
      description: tSettings("tabHistoryTooltip"),
      status: tOnboarding("capabilitiesStatusOnByDefault"),
      statusTone: "success",
    },
    {
      icon: TextSquareIcon,
      title: tSettings("tabVocabulary"),
      description: tSettings("tabVocabularyTooltip"),
      status: tOnboarding("capabilitiesStatusSettings"),
      statusTone: "muted",
    },
  ];

  const itemInitial = reduceMotion
    ? false
    : { opacity: 0, y: 8, filter: "blur(2px)" };
  const itemAnimate = { opacity: 1, y: 0, filter: "blur(0px)" };

  return (
    <LazyMotion features={domAnimation} strict>
      <div className="grid gap-3 lg:grid-cols-[0.9fr_1.1fr]">
        <m.div
          animate={itemAnimate}
          className="flex flex-col gap-3"
          initial={itemInitial}
          transition={reduceMotion ? { duration: 0 } : CARD_SPRING}
        >
          <ElevatedSurface className="overflow-hidden">
            <div className="relative flex min-h-[8.5rem] flex-col justify-between gap-3 px-4 py-3">
              <div>
                <div className="font-medium font-mono text-foreground-secondary text-xs-tight uppercase tracking-[0.16em]">
                  {tOnboarding("capabilitiesOverview")}
                </div>
                <p className="mt-2 max-w-[48ch] text-body-sm text-foreground-muted leading-relaxed">
                  {tOnboarding("capabilitiesOverviewBody")}
                </p>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <PreviewMetric
                  label={tOnboarding("capabilitiesMetricDictate")}
                  value="STT"
                />
                <PreviewMetric
                  label={tOnboarding("capabilitiesMetricRefine")}
                  value="LLM"
                />
                <PreviewMetric
                  label={tOnboarding("capabilitiesMetricRecall")}
                  value={tHistory("pageTitle")}
                />
              </div>
            </div>
          </ElevatedSurface>

          <QuickOption
            checked={dynamicIslandEnabled}
            description={tOnboarding("capabilitiesDynamicIslandBody")}
            icon={PictureInPictureOnIcon}
            onToggle={(next) =>
              updateGeneral(
                next
                  ? {
                      showRecordingOverlay: true,
                      overlayMode: "dynamic-island",
                      overlayPosition: "auto",
                      liveTranscriptionDisplay: "both",
                    }
                  : { overlayMode: "floating-bottom" },
              )
            }
            title={tGeneral("overlayModeDynamicIsland")}
          />

          <QuickOption
            checked={reviewEnabled}
            description={tOnboarding("capabilitiesPreviewBody")}
            icon={ClipboardPasteIcon}
            onToggle={(next) =>
              updateGeneral(
                next
                    ? {
                        previewBeforePasting: true,
                        wordByWordPasting: false,
                        showRecordingOverlay: true,
                        overlayPosition: "auto",
                        liveTranscriptionDisplay: "both",
                    }
                  : { previewBeforePasting: false },
              )
            }
            title={tGeneral("previewBeforePasting")}
          />
        </m.div>

        <div className="grid gap-2 sm:grid-cols-2">
          {featureTiles.map((feature, index) => (
            <m.div
              animate={itemAnimate}
              initial={itemInitial}
              key={feature.title}
              transition={
                reduceMotion
                  ? { duration: 0 }
                  : { ...CARD_SPRING, delay: 0.03 + index * 0.025 }
              }
            >
              <FeatureCard feature={feature} />
            </m.div>
          ))}
        </div>
      </div>
    </LazyMotion>
  );
}

interface PreviewMetricProps {
  label: string;
  value: string;
}

function PreviewMetric({ label, value }: PreviewMetricProps) {
  return (
    <div className="rounded-md bg-surface-4 px-2 py-1.5 ring-1 ring-divider">
      <div className="font-mono text-2xs text-foreground-dim uppercase tracking-[0.14em]">
        {label}
      </div>
      <div className="mt-0.5 truncate font-semibold text-body-sm text-foreground">
        {value}
      </div>
    </div>
  );
}

interface QuickOptionProps {
  checked: boolean;
  description: string;
  icon: IconSvgElement;
  onToggle: (next: boolean) => void;
  title: string;
}

function QuickOption({
  checked,
  description,
  icon,
  title,
  onToggle,
}: QuickOptionProps) {
  return (
    <ElevatedSurface className="overflow-hidden">
      <div
        className={cn(
          "relative flex min-h-[5.75rem] items-start gap-3 px-4 py-3 transition-colors duration-200",
          checked && "bg-accent/[0.06]",
        )}
      >
        {checked ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/55 to-transparent"
          />
        ) : null}
        <span
          aria-hidden
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md ring-1",
            checked
              ? "bg-accent/15 text-accent ring-accent/30"
              : "bg-surface-2 text-foreground-muted ring-divider",
          )}
        >
          <HugeiconsIcon icon={icon} size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold text-body text-foreground leading-snug">
              {title}
            </h2>
            <Toggle
              aria-label={title}
              checked={checked}
              onCheckedChange={onToggle}
            />
          </div>
          <p className="mt-1 text-body-sm text-foreground-muted leading-snug">
            {description}
          </p>
        </div>
      </div>
    </ElevatedSurface>
  );
}

function FeatureCard({ feature }: { feature: FeatureTile }) {
  return (
    <ElevatedSurface className="h-full overflow-hidden">
      <div className="flex min-h-[7.25rem] flex-col gap-2 px-3.5 py-3">
        <div className="flex items-start justify-between gap-2">
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-foreground-muted ring-1 ring-divider"
          >
            <HugeiconsIcon icon={feature.icon} size={15} />
          </span>
          <StatusPill tone={feature.statusTone}>{feature.status}</StatusPill>
        </div>
        <div className="min-w-0">
          <h2 className="font-semibold text-body text-foreground leading-snug">
            {feature.title}
          </h2>
          <p className="mt-1 line-clamp-3 text-body-sm text-foreground-muted leading-snug">
            {feature.description}
          </p>
        </div>
      </div>
    </ElevatedSurface>
  );
}

function StatusPill({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: PillTone;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-sm px-1.5 py-0.5 font-medium text-2xs uppercase tracking-wider ring-1",
        tone === "accent" && "bg-accent/12 text-accent ring-accent/30",
        tone === "muted" && "bg-surface-3 text-foreground-muted ring-divider",
        tone === "success" && "bg-success/12 text-success ring-success/25",
        tone === "warning" && "bg-warning/12 text-warning ring-warning/25",
      )}
    >
      {children}
    </span>
  );
}
