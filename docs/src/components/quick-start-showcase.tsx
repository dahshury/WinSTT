/**
 * Quick-start "first run" flow showcase.
 *
 * Replaces the old baked `quick-start-flow.webm` (a pre-rendered clip whose
 * tiny, low-DPI font read as fuzzy and cramped) with a live, palette-driven
 * stepper rendered straight from the app's OKLch tokens. It summarises the five
 * steps documented below it — download, onboard, pick a model, hold & speak,
 * text at the cursor — as a single crisp hero that stays legible at any DPR and
 * matches the look of the landing/install showcases (`feature-showcases.tsx`,
 * `install-showcases.tsx`).
 *
 * Motion is transform/opacity + a connector sweep only, gated by
 * `prefers-reduced-motion` in `docs-ui.css` (the `.qs-*` block).
 */

import type { CSSProperties, ReactNode } from "react";

/* ── Step icons — small, self-contained line glyphs ──────────────── */

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="M12 3v11" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

function RocketIcon() {
  return (
    <svg viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  );
}

function LayersIcon() {
  return (
    <svg viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="m12 2 9 5-9 5-9-5 9-5Z" />
      <path d="m3 12 9 5 9-5" />
      <path d="m3 17 9 5 9-5" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}

function CursorTextIcon() {
  return (
    <svg viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <polyline points="4 7 4 4 20 4 20 7" />
      <line x1="9" x2="15" y1="20" y2="20" />
      <line x1="12" x2="12" y1="4" y2="20" />
    </svg>
  );
}

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/* ── The five-step path ──────────────────────────────────────────── */

interface QsStep {
  icon: ReactNode;
  title: string;
  desc: string;
  /** The closing step is teal — "done, text is in your app". */
  done?: boolean;
}

const STEPS: QsStep[] = [
  {
    icon: <DownloadIcon />,
    title: "Download",
    desc: "Portable build — no installer, no Python.",
  },
  {
    icon: <RocketIcon />,
    title: "Onboard",
    desc: "Pick local, choose a mic, run a quick test.",
  },
  {
    icon: <LayersIcon />,
    title: "Pick a model",
    desc: "The tiny model is bundled and ready.",
  },
  {
    icon: <MicIcon />,
    title: "Hold & speak",
    desc: "Press the hotkey and start talking.",
  },
  {
    icon: <CursorTextIcon />,
    title: "Text at cursor",
    desc: "Release — it pastes where you were typing.",
    done: true,
  },
];

export function QuickStartShowcase() {
  return (
    <figure className="shot not-prose qs-figure">
      <div
        className="shot-frame qs-frame"
        role="img"
        aria-label="The WinSTT first-run path in five steps: download the app, finish onboarding, pick a model, hold the hotkey and speak, then release to paste the text at your cursor."
      >
        <ol className="qs-rail">
          {STEPS.map((step, i) => (
            <li
              key={step.title}
              className={`qs-node ${step.done ? "qs-node--done" : ""}`}
              style={{ "--qs-i": i } as CSSProperties}
            >
              <span className="qs-badge">
                <span className="qs-num">{i + 1}</span>
                <span className="qs-ico">{step.icon}</span>
              </span>
              <span className="qs-text">
                <span className="qs-title">{step.title}</span>
                <span className="qs-desc">{step.desc}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
      <figcaption className="shot-cap">
        The whole first-run path — install, onboard, pick a model, then hold,
        speak, and release. Most people are dictating in under two minutes.
      </figcaption>
    </figure>
  );
}
