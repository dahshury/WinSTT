/**
 * Install-page demonstrations.
 *
 * Two live, palette-driven mockups that show the two ways to get WinSTT on
 * Windows — the *portable* build (unzip a folder and double-click) and the
 * *installer* (run a setup that adds a Start-menu shortcut). Built from the
 * same OKLch app tokens as the landing-page showcases (`feature-showcases.tsx`)
 * so they read as the real product rather than a flat screenshot. Crisp at any
 * DPR, theme-matched, and deliberately jargon-free for non-technical readers.
 *
 * Motion is transform/opacity only and gated by `prefers-reduced-motion` in
 * `docs-ui.css` (the `.ins-*` block).
 */

import type { ReactNode } from "react";

/* ------------------------------------------------------------------ */
/* Card chrome — a desktop-window frame (traffic lights + a title),     */
/* matching the `Screenshot` window look but wrapping LIVE content.      */
/* ------------------------------------------------------------------ */

export function DesktopShowcaseCard({
  label,
  caption,
  tag,
  tagTone = "accent",
  children,
}: {
  label: string;
  caption: ReactNode;
  /** Small status pill shown at the right of the window title bar. */
  tag?: string;
  tagTone?: "accent" | "teal";
  children: ReactNode;
}) {
  return (
    <figure className="shot shot--thumb not-prose">
      <div
        className="shot-frame showcase-frame"
        role="img"
        aria-label={tag ? `${label} — ${tag}` : label}
      >
        <div className="shot-bar" aria-hidden="true">
          <span className="shot-dot shot-dot--r" />
          <span className="shot-dot shot-dot--y" />
          <span className="shot-dot shot-dot--g" />
          <span className="shot-title">{label}</span>
          {tag ? (
            <span className={`showcase-bar-tag showcase-bar-tag--${tagTone}`}>
              {tag}
            </span>
          ) : null}
        </div>
        <div className="showcase-stage">{children}</div>
      </div>
      <figcaption className="shot-cap">{caption}</figcaption>
    </figure>
  );
}

/* ── Small inline icons ──────────────────────────────────────────── */

function FolderIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 5h5l2 2.5h9A1.5 1.5 0 0 1 21 9v8.5A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5V6.5A1.5 1.5 0 0 1 4 5Z" />
    </svg>
  );
}

function ZipIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 5h5l2 2.5h9A1.5 1.5 0 0 1 21 9v8.5A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5V6.5A1.5 1.5 0 0 1 4 5Z" />
      <path d="M11.5 8v1.5M11.5 11v1.5M11.5 14v1.5" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

function AppIcon() {
  // The little "this is the program you run" tile — a window glyph with a
  // play-style accent so it reads as the launchable app.
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
      <path d="m10 13 4 2.5-4 2.5z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function CursorIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
    >
      <path d="M5 3l6.5 16 2.3-6.2 6.2-2.3z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m5 12 5 5 9-11" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* 1. Portable — unzip the folder, double-click the app.               */
/* ------------------------------------------------------------------ */

export function ShowcasePortable() {
  return (
    <div className="ins-portable">
      {/* The one-line story: a zip becomes a plain folder you can open. */}
      <div className="ins-flow" aria-hidden="true">
        <span className="ins-chip">
          <span className="ins-chip-ico">
            <ZipIcon />
          </span>
          WinSTT-portable.zip
        </span>
        <span className="ins-flow-arrow">
          <ArrowIcon />
        </span>
        <span className="ins-chip ins-chip--folder">
          <span className="ins-chip-ico">
            <FolderIcon />
          </span>
          WinSTT folder
        </span>
      </div>

      {/* The unzipped folder — double-click WinSTT to start. */}
      <div className="ins-win">
        <div className="ins-win-bar">
          <span className="ins-crumb">WinSTT</span>
        </div>
        <div className="ins-files">
          <div className="ins-file ins-file--app">
            <span className="ins-file-ico ins-file-ico--app">
              <AppIcon />
            </span>
            <span className="ins-file-name">WinSTT</span>
          </div>
          <div className="ins-file">
            <span className="ins-file-ico ins-file-ico--folder">
              <FolderIcon />
            </span>
            <span className="ins-file-name">resources</span>
          </div>
          <div className="ins-file">
            <span className="ins-file-ico ins-file-ico--folder">
              <FolderIcon />
            </span>
            <span className="ins-file-name">models</span>
          </div>
          <div className="ins-file">
            <span className="ins-file-ico">
              <FileIcon />
            </span>
            <span className="ins-file-name">README</span>
          </div>
        </div>
        <div className="ins-win-foot">
          <span className="ins-cursor">
            <CursorIcon />
          </span>
          Double-click <strong>WinSTT</strong> to open
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 2. Installer — run setup, get a Start-menu shortcut.                */
/* ------------------------------------------------------------------ */

export function ShowcaseInstaller() {
  return (
    <div className="ins-installer">
      <div className="ins-setup">
        <div className="ins-setup-head">
          <span className="ins-setup-logo">
            <AppIcon />
          </span>
          <div className="ins-setup-titles">
            <span className="ins-setup-title">Welcome to WinSTT Setup</span>
            <span className="ins-setup-sub">
              This will install WinSTT on your computer.
            </span>
          </div>
        </div>

        <div className="ins-progress">
          <span className="ins-progress-fill" />
        </div>

        <ul className="ins-checks">
          <li>
            <span className="ins-check">
              <CheckIcon />
            </span>
            Adds a Start-menu shortcut
          </li>
          <li>
            <span className="ins-check">
              <CheckIcon />
            </span>
            Opens automatically when it&apos;s done
          </li>
        </ul>

        <div className="ins-setup-actions" aria-hidden="true">
          <span className="ins-btn ins-btn--ghost">Back</span>
          <span className="ins-btn ins-btn--primary">
            Install
            <span className="ins-cursor ins-cursor--btn">
              <CursorIcon />
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
