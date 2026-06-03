import { SparklesIcon } from "@hugeicons/core-free-icons";
import type { useTranslations } from "use-intl";
import {
  DEFAULT_SETTINGS,
  SettingField,
  useSettingsStore,
} from "@/entities/setting";
import { ElevatedSurface } from "@/shared/ui/elevated-surface";
import {
  SearchableSelect,
  type SelectOptionGroup,
} from "@/shared/ui/searchable-select";
import { Select, type SelectOption } from "@/shared/ui/select";
import { Slider } from "@/shared/ui/slider";
import { Toggle } from "@/shared/ui/toggle";
import { Tooltip } from "@/shared/ui/tooltip";
import { CLOUD_TTS_MODELS } from "../config/cloud-tts-models";
import { TtsPreviewButton } from "./TtsPreviewButton";

export interface CloudTtsControlsProps {
  /** Request id of the in-flight preview, used by the preview button to cancel. */
  activeRequestId: string | null;
  /** Classified fetch failure, or null when the voice list loaded fine. */
  error: string | null;
  /** Voices grouped by language for the picker (from `useCloudTtsVoices`). */
  groups: SelectOptionGroup[];
  /** True while a preview is synthesizing (before audio plays). */
  isLoading: boolean;
  /** True while the voice list is being fetched. */
  isLoadingVoices: boolean;
  /** True while a preview is audibly playing. */
  isSpeaking: boolean;
  /** Speak a sample in the given voice. Language is irrelevant for cloud — pass "". */
  previewVoice: (voiceId: string, lang: string) => void;
  /** Which voice the active preview belongs to (drives the play/stop affordance). */
  previewVoiceId: string | null;
  t: ReturnType<typeof useTranslations>;
}

// Build the model picker options from the curated catalog. The provider's
// display name leads; the latency/quality blurb rides along as a badge so the
// closed trigger stays compact while the popup still reads the trade-off.
const MODEL_OPTIONS: SelectOption[] = CLOUD_TTS_MODELS.map((m) => ({
  id: m.id,
  label: m.displayName,
  icon: SparklesIcon,
}));

// Shared formatter for the 0..1 voice-setting sliders shown as percentages.
const formatPercent = (v: number): string => `${Math.round(v * 100)}%`;

const CLOUD_DEFAULTS = DEFAULT_SETTINGS.tts.cloud;

// ElevenLabs upgrade page, opened from the "Premium" badge on a locked voice.
const ELEVENLABS_PRICING_URL = "https://elevenlabs.io/pricing";
// English-only on purpose (plain consts, not i18n keys) to avoid editing the 20
// locale files the cleanup sweep is actively touching — safe to localize later.
const PREMIUM_BADGE_TEXT = "Premium";
const PREMIUM_BADGE_TOOLTIP =
  "This voice needs an ElevenLabs subscription. Click to upgrade.";

interface CloudSliderFieldProps {
  formatValue?: (v: number) => string;
  isDefault: boolean;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  onReset: () => void;
  step: number;
  tooltip: string;
  value: number;
}

/**
 * Trailing "Premium" badge for a voice the current plan can't synthesize
 * (cloned / professional on a free key). The voice stays previewable (free
 * sample clip) but isn't selectable; hovering explains why and clicking opens
 * ElevenLabs' pricing page. Rendered inside the picker row's StopBubble, so the
 * click can't select/close the combobox.
 */
function PremiumVoiceBadge() {
  return (
    <Tooltip content={PREMIUM_BADGE_TOOLTIP} side="left">
      <button
        className="shrink-0 cursor-pointer rounded-xs border border-accent/40 bg-accent/10 px-1.5 py-0.5 font-semibold text-[9px] text-accent uppercase tracking-wider"
        onClick={() => window.open(ELEVENLABS_PRICING_URL, "_blank")}
        type="button"
      >
        {PREMIUM_BADGE_TEXT}
      </button>
    </Tooltip>
  );
}

function CloudSliderField({
  formatValue,
  isDefault,
  label,
  max,
  min,
  onChange,
  onReset,
  step,
  tooltip,
  value,
}: CloudSliderFieldProps) {
  return (
    <SettingField
      isDefault={isDefault}
      label={label}
      onReset={onReset}
      tooltip={tooltip}
    >
      <ElevatedSurface inline>
        <Slider
          aria-label={label}
          max={max}
          min={min}
          onChange={onChange}
          step={step}
          value={value}
          {...(formatValue ? { formatValue } : {})}
        />
      </ElevatedSurface>
    </SettingField>
  );
}

/**
 * ElevenLabs cloud TTS controls — the cloud-mode counterpart of `TtsControls`.
 * Voice + model pickers and the provider tuning knobs (stability / similarity
 * / style / speed / speaker boost). Every change persists immediately to
 * `tts.cloud.*`. `updateTtsSettings` shallow-merges, so each write spreads the
 * current cloud object and overrides one field.
 */
export function CloudTtsControls({
  activeRequestId,
  error,
  groups,
  isLoadingVoices,
  isLoading,
  isSpeaking,
  previewVoice,
  previewVoiceId,
  t,
}: CloudTtsControlsProps) {
  // Read the live cloud sub-object so persisted nested writes always carry
  // every required field (the store does a shallow merge on `tts`).
  const cloud = useSettingsStore(
    (s) => s.settings.tts?.cloud ?? CLOUD_DEFAULTS,
  );
  const update = useSettingsStore((s) => s.updateTtsSettings);

  const patchCloud = (next: Partial<typeof cloud>): void => {
    update({ cloud: { ...cloud, ...next } });
  };

  const hasVoices = groups.length > 0;
  let voicePlaceholder = t("cloudNoVoices");
  if (error) {
    voicePlaceholder = t("cloudError");
  } else if (isLoadingVoices) {
    voicePlaceholder = t("cloudLoadingVoices");
  }

  return (
    <>
      <SettingField
        isDefault={cloud.voice === CLOUD_DEFAULTS.voice}
        label={t("cloudVoice")}
        layout="row"
        onReset={() => patchCloud({ voice: CLOUD_DEFAULTS.voice })}
        tooltip={t("cloudVoiceCaption")}
      >
        <ElevatedSurface className="w-52" inline>
          <SearchableSelect
            groups={groups}
            inputTrailing={
              <TtsPreviewButton
                activeRequestId={activeRequestId}
                compact={true}
                isLoading={isLoading}
                isSpeaking={isSpeaking}
                langForVoice={() => ""}
                previewVoice={previewVoice}
                previewVoiceId={previewVoiceId}
                t={t}
                targetVoiceId={cloud.voice}
              />
            }
            onChange={(id) => patchCloud({ voice: id })}
            placeholder={voicePlaceholder}
            renderItemTrailing={(option) => (
              <>
                {option.disabled ? <PremiumVoiceBadge /> : null}
                <TtsPreviewButton
                  activeRequestId={activeRequestId}
                  compact={true}
                  isLoading={isLoading}
                  isSpeaking={isSpeaking}
                  langForVoice={() => ""}
                  previewVoice={previewVoice}
                  previewVoiceId={previewVoiceId}
                  t={t}
                  targetVoiceId={option.id}
                />
              </>
            )}
            value={hasVoices ? cloud.voice : ""}
          />
        </ElevatedSurface>
      </SettingField>
      <SettingField
        isDefault={cloud.model === CLOUD_DEFAULTS.model}
        label={t("cloudModel")}
        layout="row"
        onReset={() => patchCloud({ model: CLOUD_DEFAULTS.model })}
        tooltip={t("cloudModelCaption")}
      >
        <ElevatedSurface className="w-52" inline>
          <Select
            aria-label={t("cloudModel")}
            onChange={(id) => patchCloud({ model: id })}
            options={MODEL_OPTIONS}
            value={cloud.model}
          />
        </ElevatedSurface>
      </SettingField>
      <CloudSliderField
        formatValue={formatPercent}
        isDefault={cloud.stability === CLOUD_DEFAULTS.stability}
        label={t("stability")}
        max={1}
        min={0}
        onChange={(v) => patchCloud({ stability: v })}
        onReset={() => patchCloud({ stability: CLOUD_DEFAULTS.stability })}
        step={0.05}
        tooltip={t("stabilityCaption")}
        value={cloud.stability}
      />
      <CloudSliderField
        formatValue={formatPercent}
        isDefault={cloud.similarity === CLOUD_DEFAULTS.similarity}
        label={t("similarity")}
        max={1}
        min={0}
        onChange={(v) => patchCloud({ similarity: v })}
        onReset={() => patchCloud({ similarity: CLOUD_DEFAULTS.similarity })}
        step={0.05}
        tooltip={t("similarityCaption")}
        value={cloud.similarity}
      />
      <CloudSliderField
        formatValue={formatPercent}
        isDefault={cloud.style === CLOUD_DEFAULTS.style}
        label={t("style")}
        max={1}
        min={0}
        onChange={(v) => patchCloud({ style: v })}
        onReset={() => patchCloud({ style: CLOUD_DEFAULTS.style })}
        step={0.05}
        tooltip={t("styleCaption")}
        value={cloud.style}
      />
      <CloudSliderField
        formatValue={(v) => `${v.toFixed(2)}×`}
        isDefault={cloud.speed === CLOUD_DEFAULTS.speed}
        label={t("speed")}
        max={1.2}
        min={0.7}
        onChange={(v) => patchCloud({ speed: v })}
        onReset={() => patchCloud({ speed: CLOUD_DEFAULTS.speed })}
        step={0.05}
        tooltip={t("cloudSpeedCaption")}
        value={cloud.speed}
      />
      <SettingField
        isDefault={cloud.speakerBoost === CLOUD_DEFAULTS.speakerBoost}
        label={t("speakerBoost")}
        labelAddon={
          <Toggle
            aria-label={t("speakerBoost")}
            checked={cloud.speakerBoost}
            onCheckedChange={(v) => patchCloud({ speakerBoost: v })}
          />
        }
        onReset={() =>
          patchCloud({ speakerBoost: CLOUD_DEFAULTS.speakerBoost })
        }
        tooltip={t("speakerBoostCaption")}
      />
    </>
  );
}
