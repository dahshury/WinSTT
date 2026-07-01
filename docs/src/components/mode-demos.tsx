/**
 * Recording-mode demos.
 *
 * One always-on, looping mini-demo per recording mode — Push-to-Talk, Toggle,
 * Listen, and Wake Word — built live in the real app palette (the `--brand-*`
 * / `--surface-*` / `--fg-*` OKLch tokens from `app.css`) rather than as flat
 * screenshots or hover-only previews. Each one *shows how the trigger works*:
 * the held key, the latched session, the rolling loopback feed, the keyword
 * that arms recording.
 *
 * Motion is CSS-only (keyframes in `docs-ui.css`), transform/opacity, and
 * gated by `prefers-reduced-motion` — under reduced motion every scene falls
 * back to a legible static frame. Registered in `mdx.tsx` so docs pages drop
 * them in with `<ModeDemo mode="ptt" />`.
 */

import type { CSSProperties, ReactNode } from "react";
import { VoiceBars } from "@/components/feature-showcases";

/* The four modes, with the colors the app (and ModeBadge) use. */
const MODE_META: Record<
  string,
  { label: string; color: string; tagline: string }
> = {
  ptt: {
    label: "Push-to-Talk",
    color: "var(--brand-mode-ptt)",
    tagline: "Hold the key — record exactly as long as you hold it.",
  },
  toggle: {
    label: "Toggle",
    color: "var(--brand-mode-toggle)",
    tagline: "Tap on, tap off — a hands-free session in between.",
  },
  listen: {
    label: "Listen",
    color: "var(--brand-mode-listen)",
    tagline: "Passively captures your speakers into a live feed.",
  },
  wakeword: {
    label: "Wake Word",
    color: "var(--brand-mode-wakeword)",
    tagline: "Say the keyword — it arms recording the moment it hears it.",
  },
};

/* Shared "recording" cluster — the red dot, the live visualizer, and a label.
   Reused by PTT and Wake Word for the moment a turn is actually capturing. */
function RecCluster({ label }: { label: string }) {
  return (
    <span className="md-rec">
      <span className="md-rec-dot" />
      <span className="md-rec-bars">
        <VoiceBars count={13} width={2} gap={2} color="var(--mode)" />
      </span>
      <span className="md-rec-text">{label}</span>
    </span>
  );
}

/* ── Push-to-Talk ──────────────────────────────────────────────────
   A key chip presses down and holds; recording is live only while it's
   held; on release the text lands at the cursor. */
function PttScene() {
  return (
    <div className="md-ptt" aria-hidden="true">
      <div className="md-ptt-key">
        <span className="md-kcap">Ctrl</span>
        <span className="md-kplus">+</span>
        <span className="md-kcap">Win</span>
        <span className="md-ptt-ring" />
      </div>

      <div className="md-ptt-stack">
        <RecCluster label="Recording" />
        <span className="md-paste">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
          Pasted at your cursor
        </span>
      </div>

      <div className="md-phase">
        <span className="md-phase-step md-phase-hold">Hold</span>
        <span className="md-phase-step md-phase-release">
          Release → transcribe &amp; paste
        </span>
      </div>
    </div>
  );
}

/* ── Toggle ────────────────────────────────────────────────────────
   A switch latches ON, several turns stream in hands-free, then it
   latches OFF on the second tap. */
function ToggleScene() {
  return (
    <div className="md-toggle" aria-hidden="true">
      <div className="md-switch">
        <span className="md-switch-track">
          <span className="md-switch-knob" />
        </span>
        <span className="md-switch-state">
          <span className="md-switch-on">Session active</span>
          <span className="md-switch-off">Idle</span>
        </span>
      </div>

      <div className="md-utts">
        <span className="md-utt md-utt-1">
          <span className="md-rec-dot" />
          Draft the release notes
        </span>
        <span className="md-utt md-utt-2">
          <span className="md-rec-dot" />
          …then ping the team channel
        </span>
      </div>

      <div className="md-phase">
        <span className="md-phase-step md-tap-on">Tap to start</span>
        <span className="md-phase-step md-tap-mid">Turn after turn</span>
        <span className="md-phase-step md-tap-off">Tap to stop</span>
      </div>
    </div>
  );
}

/* ── Listen ────────────────────────────────────────────────────────
   No key — system audio streams into a rolling, speaker-labeled
   subtitle feed (a seamless vertical marquee). */
const FEED_LINES: { who: 1 | 2; text: string }[] = [
  { who: 1, text: "So the Q3 numbers came in ahead of plan." },
  { who: 2, text: "Nice — which region drove most of it?" },
  { who: 1, text: "EMEA, mostly. Enterprise renewals." },
  { who: 2, text: "Let's pull that into the board deck." },
];

const MARQUEE_FEED_LINES = [
  ...FEED_LINES.map((line) => ({
    ...line,
    key: `first-${line.who}-${line.text}`,
  })),
  ...FEED_LINES.map((line) => ({
    ...line,
    key: `second-${line.who}-${line.text}`,
  })),
];

function FeedLine({ who, text }: { who: 1 | 2; text: string }) {
  return (
    <span className="md-feed-line">
      <span className={`md-spk-tag md-spk-tag--${who}`}>Speaker {who}</span>
      <span className="md-feed-text">{text}</span>
    </span>
  );
}

function ListenScene() {
  return (
    <div className="md-listen" aria-hidden="true">
      <div className="md-source">
        <span className="md-source-ico">
          <svg
            width="14"
            height="14"
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
        <span className="md-source-label">System audio</span>
        <span className="md-source-live">
          <span className="md-live-dot" />
          Live
        </span>
      </div>

      <div className="md-feed">
        <div className="md-feed-track">
          {MARQUEE_FEED_LINES.map((line) => (
            <FeedLine key={line.key} who={line.who} text={line.text} />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Wake Word ─────────────────────────────────────────────────────
   Idle "listening" rings; the keyword lights up when heard; recording
   arms; then it returns to listening. */
function WakeScene() {
  return (
    <div className="md-wake" aria-hidden="true">
      <div className="md-ear">
        <span className="md-ear-ring" />
        <span className="md-ear-ring md-ear-ring--2" />
        <span className="md-ear-core">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="2.2" />
            <path d="M16.5 7.5a6 6 0 0 1 0 9" />
            <path d="M7.5 16.5a6 6 0 0 1 0-9" />
            <path d="M19.8 4.2a10 10 0 0 1 0 15.6" />
            <path d="M4.2 19.8a10 10 0 0 1 0-15.6" />
          </svg>
        </span>
      </div>

      <div className="md-word">
        <span className="md-word-pre">“Hey </span>
        <span className="md-word-hit">Alexa”</span>
      </div>

      <div className="md-wake-rec">
        <RecCluster label="Armed — recording" />
      </div>

      <div className="md-phase">
        <span className="md-phase-step md-wphase-idle">
          Listening for the keyword…
        </span>
        <span className="md-phase-step md-wphase-armed">
          Heard it — recording
        </span>
      </div>
    </div>
  );
}

const SCENES: Record<string, ReactNode> = {
  ptt: <PttScene />,
  toggle: <ToggleScene />,
  listen: <ListenScene />,
  wakeword: <WakeScene />,
};

export interface ModeDemoProps {
  /** Which mode to demonstrate. */
  mode: keyof typeof MODE_META | string;
  /** Optional caption under the framed demo. */
  caption?: ReactNode;
}

/**
 * A single framed, always-animating demo of one recording mode. The card
 * carries the descriptive `aria-label`; the animated scene inside is
 * `aria-hidden` (decorative motion).
 */
export function ModeDemo({ mode, caption }: ModeDemoProps) {
  const meta = MODE_META[mode] ?? {
    label: String(mode),
    color: "var(--brand-accent)",
    tagline: "",
  };
  const scene = SCENES[mode] ?? null;
  return (
    <figure
      className="md-fig not-prose"
      style={{ "--mode": meta.color } as CSSProperties}
    >
      <div
        className="md-card"
        aria-label={`${meta.label} — ${meta.tagline}`}
      >
        <div className="md-head">
          <span className="md-badge">
            <span className="md-badge-dot" />
            {meta.label}
          </span>
          <span className="md-tagline">{meta.tagline}</span>
        </div>
        <div className="md-stage">{scene}</div>
      </div>
      {caption ? <figcaption className="shot-cap">{caption}</figcaption> : null}
    </figure>
  );
}
