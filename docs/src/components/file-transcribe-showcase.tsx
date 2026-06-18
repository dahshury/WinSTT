/**
 * File-transcription showcase — a live, looping animation of the real queue.
 *
 * A cursor drags a small stack of audio files into the drop box; on drop they
 * appear as queue rows and transcribe one after another, each welded progress
 * hairline filling to 100% (teal while working, green when done) and resolving
 * into the transcript file written beside the source — mirroring the real
 * `FileOverlay` / `QueueRow` UI (header `done / total`, status glyph, filename,
 * % text, 2px bottom-welded progress bar). Driven by one looping clock so the
 * whole sequence stays in sync; falls back to a static "all done" frame under
 * `prefers-reduced-motion`.
 */

import { type CSSProperties, useEffect, useState } from "react";

interface ShowFile {
  name: string;
  out: string;
  start: number; // loop fraction where this file starts transcribing
  end: number; // loop fraction where it completes
}

// Three files transcribe in a staggered cascade across the loop.
const FILES: ShowFile[] = [
  { name: "interview.mp3", out: "interview.srt", start: 0.22, end: 0.46 },
  { name: "standup.m4a", out: "standup.txt", start: 0.4, end: 0.64 },
  { name: "lecture.wav", out: "lecture.srt", start: 0.58, end: 0.82 },
];

const DROP_AT = 0.16; // cursor reaches the box / files drop in
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const ease = (n: number) => 1 - (1 - n) * (1 - n); // easeOutQuad

function initialLoopProgress(): number {
  const reduce =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  return reduce ? 0.95 : 0;
}

function FileGlyph({ color }: { color: string }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

function CursorGlyph() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="var(--fg-strong)"
      stroke="oklch(11% 0.015 265)"
      strokeWidth="1.2"
      aria-hidden="true"
      style={{ filter: "drop-shadow(0 2px 3px oklch(0% 0 0 / 0.6))" }}
    >
      <path d="M5 3l6.5 16 2.3-6.2 6.2-2.3z" />
    </svg>
  );
}

interface RowState {
  status: "queued" | "transcribing" | "complete";
  pct: number;
}

function rowState(f: ShowFile, t: number, dropped: boolean): RowState {
  if (!dropped || t < f.start) return { status: "queued", pct: 0 };
  if (t >= f.end) return { status: "complete", pct: 100 };
  const pct = Math.round(clamp01((t - f.start) / (f.end - f.start)) * 100);
  return { status: "transcribing", pct };
}

function QueueRowView({ f, st }: { f: ShowFile; st: RowState }) {
  const active = st.status === "transcribing";
  const done = st.status === "complete";
  const glyphColor = done
    ? "var(--brand-success)"
    : active
      ? "var(--brand-teal)"
      : "var(--fg-muted)";
  const fill = done ? "var(--brand-success)" : "var(--brand-teal)";
  return (
    <div
      className="ftx-row"
      style={{
        background: active ? "var(--surface-2)" : "transparent",
        boxShadow: active ? "inset 2px 0 0 0 var(--brand-teal)" : undefined,
      }}
    >
      <span className="ftx-row-glyph" style={{ color: glyphColor }}>
        {done ? (
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
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : active ? (
          <span className="ftx-spin">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M21 12a9 9 0 1 1-6.2-8.5" />
            </svg>
          </span>
        ) : (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
        )}
      </span>

      <span
        className="ftx-row-name"
        style={{
          color: done
            ? "var(--fg-dim)"
            : active
              ? "var(--fg-strong)"
              : "var(--fg-muted)",
        }}
      >
        {f.name}
      </span>

      {done ? (
        <span className="ftx-row-out">
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M5 12h14" />
            <path d="m13 6 6 6-6 6" />
          </svg>
          {f.out}
        </span>
      ) : active ? (
        <span className="ftx-row-pct">
          {st.pct}
          <span style={{ opacity: 0.45 }}>%</span>
        </span>
      ) : (
        <span className="ftx-row-status">Queued</span>
      )}

      {/* welded 2px progress hairline at the row bottom */}
      <span className="ftx-track">
        <span
          className="ftx-fill"
          style={{ width: `${st.pct}%`, background: fill }}
        />
      </span>
    </div>
  );
}

export function ShowcaseFileTranscribe() {
  // Single looping clock (0→1). Falls back to a static "done" frame for
  // reduced-motion. Loop ≈ 7s.
  const [t, setT] = useState(initialLoopProgress);

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      return;
    }
    let frame = 0;
    const id = window.setInterval(() => {
      frame = (frame + 1) % 175; // 175 * 40ms = 7s
      setT(frame / 175);
    }, 40);
    return () => window.clearInterval(id);
  }, []);

  const dropped = t >= DROP_AT;
  const rows = FILES.map((file) => ({ file, state: rowState(file, t, dropped) }));
  const states = rows.map((r) => r.state);
  const done = states.filter((s) => s.status === "complete").length;
  const anyActive = states.some((s) => s.status === "transcribing");
  const header = anyActive
    ? "Transcribing…"
    : done === FILES.length && dropped
      ? "All done"
      : "Queued";

  // Cursor + dragged stack travel from outside into the box, then vanish.
  const dragP = ease(clamp01(t / DROP_AT));
  const showCursor = t < DROP_AT + 0.03;
  const cursorStyle: CSSProperties = {
    left: `${88 - dragP * 42}%`,
    top: `${92 - dragP * 52}%`,
    opacity: showCursor ? 1 : 0,
  };

  return (
    <figure className="shot not-prose my-7">
      <div className="shot-frame showcase-frame" aria-label="WinSTT transcribing dropped files">
        <div className="shot-bar" aria-hidden="true">
          <span className="shot-dot shot-dot--r" />
          <span className="shot-dot shot-dot--y" />
          <span className="shot-dot shot-dot--g" />
          <span className="shot-title">WinSTT — file transcription</span>
          <span className="showcase-bar-tag showcase-bar-tag--accent">
            Drag · transcribe · write
          </span>
        </div>

        <div className="showcase-stage ftx-stage">
          <div className={`ftx-box ${dropped ? "ftx-box--filled" : "ftx-box--open"}`}>
            {/* Queue header */}
            <div className="ftx-head" style={{ opacity: dropped ? 1 : 0.35 }}>
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                style={{ color: "var(--fg-muted)" }}
              >
                <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                <path d="M14 3v5h5" />
              </svg>
              <span className="ftx-head-label">{header}</span>
              <span className="ftx-head-count">
                {done}
                <span style={{ opacity: 0.35 }}> / </span>
                {FILES.length}
              </span>
            </div>

            {/* Rows (after drop) OR the empty drop prompt (before) */}
            {dropped ? (
              <div className="ftx-rows">
                {rows.map(({ file, state }) => (
                  <QueueRowView f={file} key={file.name} st={state} />
                ))}
              </div>
            ) : (
              <div className="ftx-prompt">
                <svg
                  width="26"
                  height="26"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  style={{ color: "var(--brand-accent)" }}
                >
                  <path d="M12 13v8" />
                  <path d="m8 17 4 4 4-4" />
                  <path d="M20 16.7A5 5 0 0 0 18 7h-1.3A8 8 0 1 0 4 15.2" />
                </svg>
                <span>Drop audio or video files</span>
              </div>
            )}
          </div>

          {/* Dragged file stack + cursor */}
          {showCursor ? (
            <div className="ftx-drag" style={cursorStyle} aria-hidden="true">
              <span className="ftx-drag-stack">
                <span className="ftx-drag-file ftx-drag-file--3" />
                <span className="ftx-drag-file ftx-drag-file--2" />
                <span className="ftx-drag-file ftx-drag-file--1">
                  <FileGlyph color="var(--brand-accent)" />3
                </span>
              </span>
              <span className="ftx-cursor">
                <CursorGlyph />
              </span>
            </div>
          ) : null}
        </div>
      </div>
      <figcaption className="shot-cap">
        Drag in a batch of recordings — each one transcribes on-device and a
        timestamped <code>.srt</code> or plain <code>.txt</code> is written right
        beside it.
      </figcaption>
    </figure>
  );
}
