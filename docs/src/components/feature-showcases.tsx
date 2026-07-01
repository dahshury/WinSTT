/**
 * Landing-page feature showcases.
 *
 * Each card foregrounds ONE distinct, recognisable feature — live dictation,
 * the model picker, the LLM clean-up diff, multilingual TTS voices, the
 * recording modes, and the redesigned History dashboard — rendered live in the
 * real app palette (the `--brand-*` / `--surface-*` / `--fg-*` OKLch tokens
 * from `app.css`) rather than as flat settings screenshots. Crisp at any DPR,
 * theme-matched, and pointed at the thing the user actually sees.
 *
 * All data shown is real (model names + sizes, Kokoro voices, post-processing
 * tones, History labels) so the mock reads as the product, not a placeholder.
 * Motion is transform/opacity only and gated by `prefers-reduced-motion`.
 */

import type { CSSProperties, ReactNode } from "react";
import { withBasePath } from "@/lib/site";

/* ------------------------------------------------------------------ */
/* Card chrome — a browser-window frame (traffic lights, nav arrows,    */
/* and a secure address bar) styled with the app palette. See `.bw-*`   */
/* in docs-ui.css.                                                      */
/* ------------------------------------------------------------------ */

function BrowserBar({ url }: { url: string }) {
  // Split host from path so the host reads bright and the path dims, the
  // way Chrome de-emphasises everything after the domain.
  const slash = url.indexOf("/");
  const host = slash === -1 ? url : url.slice(0, slash);
  const path = slash === -1 ? "" : url.slice(slash);
  return (
    <div className="bw-bar" aria-hidden="true">
      <span className="bw-dots">
        <span className="shot-dot shot-dot--r" />
        <span className="shot-dot shot-dot--y" />
        <span className="shot-dot shot-dot--g" />
      </span>

      <span className="bw-nav">
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m15 18-6-6 6-6" />
        </svg>
        <svg
          className="bw-fwd"
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
      </span>

      <span className="bw-address">
        <svg
          className="bw-lock"
          width="9"
          height="9"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect width="18" height="11" x="3" y="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        <span className="bw-url">
          <span className="bw-host">{host}</span>
          {path ? <span className="bw-path">{path}</span> : null}
        </span>
        <svg
          className="bw-reload"
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
          <path d="M21 3v5h-5" />
        </svg>
      </span>
    </div>
  );
}

export function ShowcaseCard({
  label,
  url,
  caption,
  children,
}: {
  label: string;
  url: string;
  caption: ReactNode;
  children: ReactNode;
}) {
  return (
    <figure className="shot shot--thumb not-prose">
      <div
        className="shot-frame shot-frame--browser showcase-frame"
        aria-label={label}
      >
        <BrowserBar url={url} />
        <div className="showcase-stage">{children}</div>
      </div>
      <figcaption className="shot-cap">{caption}</figcaption>
    </figure>
  );
}

const MONO = "var(--font-mono)";

/* A center-weighted, animated "voice" waveform reusing the hero bar keyframes
   (mock-bar-speak-a/b). Phases are scattered (non-monotonic) so it shimmers
   like speech instead of travelling left to right. Exported so the mode demos
   (mode-demos.tsx) reuse the exact same live visualizer. */
export function VoiceBars({
  count = 18,
  width = 2.5,
  gap = 2,
  color = "var(--brand-accent)",
  amp = 1,
}: {
  count?: number;
  width?: number;
  gap?: number;
  color?: string;
  amp?: number;
}) {
  const center = (count - 1) / 2;
  return (
    <div
      className="showcase-voice"
      style={{ display: "flex", alignItems: "center", gap, height: "100%" }}
      aria-hidden="true"
    >
      {Array.from({ length: count }, (_, i) => {
        const peak = (1 - (Math.abs(i - center) / center) * 0.72) * amp;
        const phase = (((i * 37) % 11) / 11) * -0.22;
        const barKey = `${peak.toFixed(3)}-${phase.toFixed(3)}`;
        return (
          <span
            key={barKey}
            className={`mock-bar mock-bar--${i % 2 === 0 ? "a" : "b"}`}
            style={
              {
                width,
                height: "100%",
                borderRadius: 9,
                background: color,
                "--peak": peak,
                animationDelay: `${phase.toFixed(3)}s`,
              } as CSSProperties
            }
          />
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 1. Live dictation — the real-time preview / floating pill.          */
/* ------------------------------------------------------------------ */

export function ShowcaseDictation() {
  return (
    <div className="sc-dictation">
      {/* Target editor the words are landing in */}
      <div className="sc-editor">
        <div className="sc-editor-bar">
          <span className="sc-traffic" />
          <span className="sc-traffic" />
          <span className="sc-traffic" />
          <span className="sc-editor-name">message.txt</span>
        </div>
        <p className="sc-editor-text">
          Can you send over the meeting notes from{" "}
          <span className="sc-ins">this morning</span>
          <span className="sc-caret" />
        </p>
      </div>

      {/* The floating overlay pill — words stream in and paste at the cursor */}
      <div className="sc-pill">
        <span className="sc-pill-rec" />
        <div className="sc-pill-wave">
          <VoiceBars count={16} width={2} gap={2} />
        </div>
        <span className="sc-pill-text">…this morning</span>
        <span className="sc-pill-chip">large-v3</span>
      </div>

      <div className="sc-tag sc-tag--accent">Pastes as you speak</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 2. Model picker — the catalogue the user liked, rebuilt live.       */
/* ------------------------------------------------------------------ */

// The real maker logos shipped with the app (public/provider-icons/*),
// copied into the docs public folder so the picker reads as the product.
function MakerLogo({ src, alt }: { src: string; alt: string }) {
  return (
    <span className="sc-maker" aria-hidden="true">
      <img
        className="sc-logo"
        src={withBasePath(src)}
        alt={alt}
        width={14}
        height={14}
        decoding="async"
      />
    </span>
  );
}

function QuantBadge({ children, on }: { children: ReactNode; on?: boolean }) {
  return (
    <span className={`sc-quant ${on ? "sc-quant--on" : ""}`}>{children}</span>
  );
}

function ModelRow({
  mark,
  maker,
  name,
  size,
  quant,
  selected,
}: {
  mark: ReactNode;
  maker: string;
  name: string;
  size: string;
  quant: string;
  selected?: boolean;
}) {
  return (
    <div className={`sc-row ${selected ? "sc-row--on" : ""}`}>
      {mark}
      <div className="sc-row-main">
        <span className="sc-row-name">{name}</span>
        <span className="sc-row-sub">{maker}</span>
      </div>
      <span className="sc-row-size">{size}</span>
      <QuantBadge on={selected}>{quant}</QuantBadge>
    </div>
  );
}

export function ShowcaseModelPicker() {
  return (
    <div className="sc-picker">
      <div className="sc-search">
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <span>Search transcription models</span>
        <span className="sc-search-count">70+</span>
      </div>

      <div className="sc-rows">
        <ModelRow
          mark={<MakerLogo src="/provider-icons/nvidia.svg" alt="NVIDIA" />}
          maker="NVIDIA · NeMo"
          name="Parakeet TDT"
          size="600M"
          quant="int8"
          selected
        />
        <ModelRow
          mark={<MakerLogo src="/provider-icons/nvidia.svg" alt="NVIDIA" />}
          maker="NVIDIA · NeMo"
          name="Canary 1B"
          size="1B"
          quant="fp16"
        />
        <ModelRow
          mark={<MakerLogo src="/provider-icons/openai.svg" alt="OpenAI" />}
          maker="OpenAI · Whisper"
          name="large-v3-turbo"
          size="809M"
          quant="fp16"
        />
        <ModelRow
          mark={
            <MakerLogo
              src="/provider-icons/moonshine.png"
              alt="Useful Sensors"
            />
          }
          maker="Useful Sensors"
          name="Moonshine"
          size="190M"
          quant="int8"
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 3. LLM clean-up — the before → after dictation diff.                */
/* ------------------------------------------------------------------ */

export function ShowcaseLLM() {
  return (
    <div className="sc-llm">
      <div className="sc-llm-head">
        <span className="sc-chip sc-chip--soft">Ollama · Qwen 2.5</span>
        <span className="sc-chip sc-chip--accent">Professional</span>
        <span className="sc-chip sc-chip--mod">Polite</span>
      </div>

      <div className="sc-diff sc-diff--raw">
        <span className="sc-diff-tag">RAW</span>
        <p>
          <span className="sc-del">yeah no</span> i'm not gonna get the report
          done today<span className="sc-del"> its taking forever</span>
        </p>
      </div>

      <div className="sc-diff-arrow" aria-hidden="true">
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 5v14" />
          <path d="m6 13 6 6 6-6" />
        </svg>
      </div>

      <div className="sc-diff sc-diff--clean">
        <span className="sc-diff-tag sc-diff-tag--on">CLEAN</span>
        <p>
          <span className="sc-add">Unfortunately,</span> the report{" "}
          <span className="sc-add">won't be ready</span> today
          <span className="sc-add"> — it's taking longer than expected.</span>
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 4. Text-to-speech — select any text and hear it read aloud.         */
/* ------------------------------------------------------------------ */

export function ShowcaseTTS() {
  return (
    <div className="sc-tts">
      {/* A passage with the phrase the user highlighted to hear aloud */}
      <div className="sc-read">
        <p className="sc-read-text">
          The quarterly review went well.{" "}
          <span className="sc-sel">
            Revenue grew <span className="sc-sel-now">twenty-four percent</span>{" "}
            year over year
          </span>
          , so let's keep the momentum going.
        </p>
      </div>

      {/* …and the selection is read aloud — voice, live waveform, speed */}
      <div className="sc-speak-bar">
        <span className="sc-speak-ico" aria-hidden="true">
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M11 4.7 7.6 8H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h3.6L11 19.3a1 1 0 0 0 1.7-.7V5.4a1 1 0 0 0-1.7-.7Z" />
            <path d="M16 9a5 5 0 0 1 0 6" />
            <path d="M19.4 6a10 10 0 0 1 0 12" />
          </svg>
        </span>
        <span className="sc-speak-voice">
          <span className="sc-lang sc-lang--on">US</span>
          Heart
        </span>
        <span className="sc-speak-wave">
          <VoiceBars count={18} width={2} gap={2} color="var(--brand-teal)" />
        </span>
        <span className="sc-speed">1.0×</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 5. Recording modes — the four activation modes, app colours.        */
/* ------------------------------------------------------------------ */

const MODES = [
  {
    key: "ptt",
    label: "Push-to-Talk",
    color: "var(--brand-mode-ptt)",
    sub: "Ctrl + Space",
    on: true,
    icon: (
      <>
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" x2="12" y1="19" y2="22" />
      </>
    ),
  },
  {
    key: "toggle",
    label: "Toggle",
    color: "var(--brand-mode-toggle)",
    sub: "Tap on · tap off",
    icon: (
      <>
        <rect x="2" y="6" width="20" height="12" rx="6" />
        <circle cx="16" cy="12" r="3" />
      </>
    ),
  },
  {
    key: "listen",
    label: "Listen",
    color: "var(--brand-mode-listen)",
    sub: "Loopback capture",
    icon: (
      <>
        <path d="M2 12h3l3-8 4 16 3-8h4" />
      </>
    ),
  },
  {
    key: "wakeword",
    label: "Wake Word",
    color: "var(--brand-mode-wakeword)",
    sub: '"Hey WinSTT"',
    icon: (
      <>
        <circle cx="12" cy="12" r="2.5" />
        <path d="M16.5 7.5a6 6 0 0 1 0 9" />
        <path d="M7.5 16.5a6 6 0 0 1 0-9" />
        <path d="M19.8 4.2a10 10 0 0 1 0 15.6" />
        <path d="M4.2 19.8a10 10 0 0 1 0-15.6" />
      </>
    ),
  },
];

export function ShowcaseRecordingModes() {
  return (
    <div className="sc-modes">
      {MODES.map((m) => (
        <div
          key={m.key}
          className={`sc-mode ${m.on ? "sc-mode--on" : ""}`}
          style={{ "--mode": m.color } as CSSProperties}
        >
          <span className="sc-mode-icon">
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {m.icon}
            </svg>
          </span>
          <span className="sc-mode-label">{m.label}</span>
          <span className="sc-mode-sub">{m.sub}</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 6. History dashboard — the redesigned hero + contribution graph.    */
/* ------------------------------------------------------------------ */

function WpmGauge({ value, max = 160 }: { value: number; max?: number }) {
  const filled = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <svg viewBox="0 0 112 64" className="sc-gauge" aria-hidden="true">
      <path
        d="M 12 56 A 44 44 0 0 1 100 56"
        fill="none"
        strokeLinecap="round"
        strokeWidth={8}
        stroke="var(--surface-4)"
      />
      <path
        d="M 12 56 A 44 44 0 0 1 100 56"
        fill="none"
        pathLength={100}
        strokeDasharray={`${filled} 100`}
        strokeLinecap="round"
        strokeWidth={8}
        stroke="var(--brand-teal)"
      />
      <text
        x={56}
        y={50}
        textAnchor="middle"
        style={{ fill: "var(--fg-strong)", fontSize: 22, fontFamily: MONO }}
        fontWeight={600}
      >
        {value}
      </text>
    </svg>
  );
}

// A deterministic year of activity intensity (0–3) for the mini contribution
// graph — a believable mix of dense streaks and quiet gaps.
const HEAT_WEEKS = 32;
const HEAT_ROWS = 7;
function heatLevel(col: number, row: number): number {
  const n = (col * 7 + row * 3 + ((col * row) % 5)) % 11;
  if (col > HEAT_WEEKS - 4 && n < 7) return 0; // recent quiet tail
  if (n >= 9) return 3;
  if (n >= 6) return 2;
  if (n >= 3) return 1;
  return 0;
}
const HEAT_BG = [
  "var(--surface-3)",
  "color-mix(in oklab, var(--brand-teal) 30%, transparent)",
  "color-mix(in oklab, var(--brand-teal) 55%, transparent)",
  "var(--brand-teal)",
];

export function ShowcaseHistory() {
  return (
    <div className="sc-history">
      <div className="sc-hist-top">
        <div className="sc-stat sc-stat--gauge">
          <span className="sc-stat-label">Overall WPM</span>
          <WpmGauge value={134} />
        </div>
        <div className="sc-stat">
          <span className="sc-stat-label">AI Impact</span>
          <span className="sc-stat-big">248</span>
          <span className="sc-stat-sub">fixes made</span>
        </div>
        <div className="sc-stat">
          <span className="sc-stat-label">Total Words</span>
          <span className="sc-stat-big">24,318</span>
          <span className="sc-streak">
            <span className="sc-fire" aria-hidden="true">
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M12 2c1 3-1 4-2 6s0 4 2 4 3-2 2-4c2 1 4 4 4 7a6 6 0 1 1-12 0c0-4 4-6 6-13z" />
              </svg>
            </span>
            12 day streak
          </span>
        </div>
      </div>

      <div className="sc-heat-card">
        <div className="sc-heat-head">
          <span className="sc-heat-title">Activity</span>
          <span className="sc-heat-legend" aria-hidden="true">
            Less
            {HEAT_BG.map((bg) => (
              <span
                key={bg}
                className="sc-heat-key"
                style={{ background: bg }}
              />
            ))}
            More
          </span>
        </div>
        <div className="sc-heat" aria-hidden="true">
          {Array.from({ length: HEAT_WEEKS }, (_, col) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed positional heatmap grid
            <div key={`hc-${col}`} className="sc-heat-col">
              {Array.from({ length: HEAT_ROWS }, (_, row) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed positional heatmap grid
                  key={`hr-${col}-${row}`}
                  className="sc-heat-cell"
                  style={{ background: HEAT_BG[heatLevel(col, row)] }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
