import { ArrowRight01Icon, ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslations } from "use-intl";
import { useSettingsStore } from "@/entities/setting";
import type { RecordingMode } from "@/shared/config/recording-mode-color";
import { cn } from "@/shared/lib/cn";
import { formatKeyName } from "@/shared/lib/format-key-name";
import { SurfaceProvider, surfaceBg, useSurface } from "@/shared/lib/surface";

/**
 * Visual legend for the two hotkey combos detected in
 * `electron/ipc/hotkey.ts` while the global hotkey is held:
 *
 *   ┌── While the hotkey is held ────────────────────────────────────┐
 *   │                                                                │
 *   │  [hotkey] + [↑]   Cycle mode                                   │
 *   │  ┌─────┐ → ┌──────┐ → ┌──────┐ → ┌──────┐  ↻                  │
 *   │  │ PTT │   │TOGGLE│   │LISTEN│   │ WAKE │                     │
 *   │  └─────┘   └──────┘   └──────┘   └──────┘                     │
 *   │                                                                │
 *   │  [Esc]            Cancel transcription                         │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * The mode chain reads left-to-right as the actual `MODE_CYCLE` order in
 * `electron/main.ts` (ptt → toggle → listen → wakeword → ptt). The
 * currently-active mode is marked with the single app accent (the same
 * selection treatment the model cards use) so the legend doubles as a
 * "you are here" indicator; every other link stays neutral grayscale.
 *
 * Pure display surface: no interactive controls. The work happens in the
 * global hotkey listener; this just teaches the user what's possible.
 */

// Decorative, aria-hidden glyphs — pure visual symbols, not translatable copy.
// Held in constants so they aren't flagged as user-facing literal JSX text.
const PLUS_GLYPH = "＋";
const WRAP_GLYPH = "↻";
const BACKSPACE_GLYPH = "⌫";
const ESCAPE_LABEL = "Esc";

const MODE_CYCLE_ORDER: readonly RecordingMode[] = [
  "ptt",
  "toggle",
  "listen",
  "wakeword",
] as const;

type ModeLabelKey =
  | "shortcutPtt"
  | "shortcutToggle"
  | "shortcutListen"
  | "shortcutWakeword";

const MODE_LABEL_KEY: Record<RecordingMode, ModeLabelKey> = {
  ptt: "shortcutPtt",
  toggle: "shortcutToggle",
  listen: "shortcutListen",
  wakeword: "shortcutWakeword",
};

interface KeycapProps {
  children: React.ReactNode;
  emphasized?: boolean;
}

/**
 * Flat neutral keycap. A plain surface fill + a single hairline divider
 * ring — no 3D bevel shadow, no white rings — so it reads as a calm
 * grayscale chip. The emphasized variant (the user's actual hotkey) just
 * lifts a touch via a brighter surface + border.
 */
function Keycap({ children, emphasized = false }: KeycapProps) {
  // Surface-aware keycap that matches the hotkey recorder's idle chips: a
  // lifted surface + hairline ring rather than a hard-coded bg-surface-N. The
  // user's actual hotkey (emphasized) lifts one step further so it reads as the
  // "primary" cap. Resolves relative to the row's SurfaceProvider substrate.
  const level = useSurface();
  return (
    <span
      className={cn(
        "inline-flex h-6 min-w-[1.6rem] items-center justify-center rounded-[6px] px-1.5 font-mono text-[11px] leading-none tracking-tight ring-1",
        emphasized
          ? cn(
              surfaceBg(Math.min(level + 2, 8)),
              "text-foreground ring-divider-strong",
            )
          : cn(
              surfaceBg(Math.min(level + 1, 8)),
              "text-foreground-secondary ring-divider",
            ),
      )}
    >
      {children}
    </span>
  );
}

interface HotkeyPrefixProps {
  keys: readonly string[];
  placeholder: string;
  secondKey: React.ReactNode;
}

/**
 * Common "[Your hotkey] + [secondary]" prefix used on both shortcut
 * rows. Renders the user's actual hotkey as physical keycaps (or a
 * placeholder when unset) so the legend is literal — what you read is
 * what you press.
 */
function HotkeyPrefix({ keys, placeholder, secondKey }: HotkeyPrefixProps) {
  return (
    <span className="inline-flex items-center gap-1">
      {keys.length > 0 ? (
        keys.map((key, i) => (
          <span className="inline-flex items-center gap-1" key={key}>
            {i > 0 ? (
              <span aria-hidden className="text-[9px] text-foreground-dim">
                {PLUS_GLYPH}
              </span>
            ) : null}
            <Keycap emphasized>{formatKeyName(key)}</Keycap>
          </span>
        ))
      ) : (
        <Keycap emphasized>{placeholder}</Keycap>
      )}
      <span aria-hidden className="px-0.5 text-[10px] text-foreground-dim">
        {PLUS_GLYPH}
      </span>
      {secondKey}
    </span>
  );
}

interface ModeChipProps {
  isCurrent: boolean;
  label: string;
}

/**
 * One link in the cycle chain. The active mode gets the single app accent
 * — the same selection treatment the model cards use (accent tint + accent
 * ring + accent text/dot) — while every other link stays neutral grayscale
 * so the chain reads as "you're at X, ↑ takes you to the next one". No
 * per-mode hues, no colored glows.
 */
function ModeChip({ label, isCurrent }: ModeChipProps) {
  const level = useSurface();
  return (
    <span
      className={cn(
        "relative inline-flex items-center gap-1.5 rounded-md px-2 py-1 ring-1 transition-colors duration-200",
        isCurrent
          ? "bg-accent/[0.10] text-foreground ring-accent/30"
          : cn(
              surfaceBg(Math.min(level + 1, 8)),
              "text-foreground-secondary ring-divider",
            ),
      )}
      data-current={isCurrent || undefined}
    >
      {/* Status dot — accent when active, neutral/dim otherwise. */}
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          isCurrent ? "bg-accent" : "bg-foreground-dim/55",
        )}
      />
      <span className="font-medium font-mono text-[10.5px] uppercase leading-none tracking-[0.08em]">
        {label}
      </span>
    </span>
  );
}

interface ShortcutRowProps {
  children: React.ReactNode;
  hint: React.ReactNode;
  prefix: React.ReactNode;
}

/**
 * One row of the legend: hotkey prefix on the left, action hint, then
 * the per-action visual body (a mode chain, an explanatory caption,
 * etc.). The rounded surface gives each row its own card without
 * dominating the panel.
 */
function ShortcutRow({ prefix, hint, children }: ShortcutRowProps) {
  // Each row is its own lifted surface (the surfaces concept) and re-provides
  // that level downward, so the keycaps + mode chips inside lift relative to
  // the row — not the panel — and stay legible at any nesting depth.
  const rowLevel = Math.min(useSurface() + 1, 8);
  return (
    <SurfaceProvider value={rowLevel}>
      <div
        className={cn(
          "flex flex-col gap-2.5 rounded-lg px-3.5 py-3 ring-1 ring-divider",
          surfaceBg(rowLevel),
        )}
      >
        <div className="flex flex-wrap items-center gap-3">
          {prefix}
          <span className="font-mono text-[10.5px] text-foreground-secondary uppercase tracking-[0.08em]">
            {hint}
          </span>
        </div>
        {children}
      </div>
    </SurfaceProvider>
  );
}

interface HotkeyShortcutsLegendProps {
  disabled?: boolean;
}

export function HotkeyShortcutsLegend({
  disabled = false,
}: HotkeyShortcutsLegendProps) {
  const t = useTranslations("hotkey");
  const pushToTalkKey = useSettingsStore(
    (s) => s.settings.hotkey?.pushToTalkKey ?? "",
  );
  const recordingMode = useSettingsStore<RecordingMode>(
    (s) => (s.settings.general?.recordingMode as RecordingMode) ?? "ptt",
  );
  const ttsEnabled = useSettingsStore((s) => s.settings.tts?.enabled ?? false);
  const ttsHotkey = useSettingsStore((s) => s.settings.tts?.hotkey ?? "");

  const hotkeyParts = pushToTalkKey
    ? pushToTalkKey.split("+").filter(Boolean)
    : [];
  const ttsHotkeyParts = ttsHotkey ? ttsHotkey.split("+").filter(Boolean) : [];
  const placeholder = t("shortcutsLegendUnsetShort");

  return (
    <section
      aria-label={t("shortcutsLegendAriaLabel")}
      className={`flex flex-col gap-2.5 ${disabled ? "opacity-50" : ""}`}
    >
      {/* ── CYCLE MODE ROW ──────────────────────────────────────────
			    Visualises the cycle as a left-to-right chain. The active
			    mode is marked with the single app accent; arrows between
			    chips show the ↑ direction takes you forward one link; the
			    trailing ↺ glyph hints "wraps around". */}
      <ShortcutRow
        hint={t("shortcutCycleMode")}
        prefix={
          <HotkeyPrefix
            keys={hotkeyParts}
            placeholder={placeholder}
            secondKey={
              <Keycap>
                <HugeiconsIcon
                  className="text-foreground"
                  icon={ArrowUp01Icon}
                  size={11}
                  strokeWidth={2.5}
                />
              </Keycap>
            }
          />
        }
      >
        <div className="flex flex-wrap items-center gap-1.5">
          {MODE_CYCLE_ORDER.map((mode, i) => (
            <span className="inline-flex items-center gap-1.5" key={mode}>
              {i > 0 ? (
                // Flip the directional glyph under RTL: flexbox already reverses the
                // chip order (so the chain reads right-to-left), but the SVG arrow
                // keeps pointing right — i.e. back at the *previous* chip. Mirroring
                // it makes it point at the *next* link the way LTR does.
                <HugeiconsIcon
                  aria-hidden="true"
                  className="text-foreground-dim rtl:-scale-x-100"
                  icon={ArrowRight01Icon}
                  size={10}
                  strokeWidth={2}
                />
              ) : null}
              <ModeChip
                isCurrent={recordingMode === mode}
                label={t(MODE_LABEL_KEY[mode])}
              />
            </span>
          ))}
          {/* Wrap-around hint — small ↻ glyph in the dim foreground
					    so it reads as "the chain loops back to the start". Uses a
					    logical inline-start margin so the gap sits between it and
					    the chain in both directions, and mirrors under RTL to match
					    the flipped arrows. */}
          <span
            aria-hidden
            className="ms-1 text-[13px] text-foreground-dim leading-none rtl:-scale-x-100"
          >
            {WRAP_GLYPH}
          </span>
        </div>
      </ShortcutRow>

      {/* ── CANCEL ROW ──────────────────────────────────────────────
			    Escape cancels the active dictation pass on its own, including
			    transcription and post-processing after capture has stopped. */}
      <ShortcutRow
        hint={t("shortcutCancel")}
        prefix={<Keycap emphasized>{ESCAPE_LABEL}</Keycap>}
      >
        {null}
      </ShortcutRow>

      {/* ── TTS STOP ROW ─────────────────────────────────────────────
			    The Text-to-Speech hotkey is already configured above
			    ("Text-to-speech key" — it reads the active selection), so we
			    don't repeat a "read selection" row here. Held together with
			    Backspace it stops playback. Shown only when TTS is enabled so the legend stays
			    literal to what's actually armed. */}
      {ttsEnabled ? (
        <ShortcutRow
          hint={t("shortcutTtsStop")}
          prefix={
            <HotkeyPrefix
              keys={ttsHotkeyParts}
              placeholder={placeholder}
              secondKey={<Keycap>{BACKSPACE_GLYPH}</Keycap>}
            />
          }
        >
          {null}
        </ShortcutRow>
      ) : null}
    </section>
  );
}
