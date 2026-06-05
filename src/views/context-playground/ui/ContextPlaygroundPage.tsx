/* eslint-disable i18next/no-literal-string -- debug-only window, not user-facing/shipped */
import { Button as BaseButton } from "@base-ui/react/button";
import { useState } from "react";
import type {
  ContextDebugReport,
  ContextModeResult,
  ContextSnapshotView,
} from "@/shared/api/context-debug-types";
import { cn } from "@/shared/lib/cn";
import {
  type ContextPlaygroundController,
  useContextPlayground,
  useNow,
} from "../model/use-context-playground";

/**
 * DEBUG-ONLY context-awareness playground.
 *
 * Renders EXACTLY what dictation's context-awareness pulls from whatever input
 * field is focused in another app. English-only on purpose (developer tool — no
 * i18n keys, so it stays out of the locale-parity gate).
 */
export function ContextPlaygroundPage() {
  const ctl = useContextPlayground();
  const now = useNow();

  return (
    <div className="flex h-screen flex-col bg-surface text-foreground">
      <Header ctl={ctl} now={now} />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <Body ctl={ctl} />
      </div>
    </div>
  );
}

function Header({
  ctl,
  now,
}: {
  ctl: ContextPlaygroundController;
  now: number;
}) {
  const { report, live, deepArmed } = ctl;
  const age = report ? formatAge(now - report.capturedAt) : null;

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-border border-b bg-surface-primary px-3 py-2">
      <span className="font-semibold text-body-sm">Context Playground</span>
      <span className="rounded bg-warning-dim px-1.5 py-0.5 font-mono text-[10px] text-warning">
        DEBUG
      </span>

      <BaseButton
        className={cn(
          "flex items-center gap-1.5 rounded px-2 py-1 text-[11px] transition-colors",
          live
            ? "bg-success-dim text-success"
            : "bg-surface-tertiary text-foreground-muted",
        )}
        onClick={ctl.toggleLive}
        type="button"
      >
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            live ? "animate-pulse bg-success" : "bg-foreground-dim",
          )}
        />
        {live ? "LIVE" : "PAUSED"}
      </BaseButton>

      <BaseButton
        className={cn(
          "rounded px-2 py-1 text-[11px] transition-colors",
          deepArmed
            ? "bg-accent-glow-strong text-accent"
            : "bg-surface-tertiary text-foreground hover:bg-surface-hover",
        )}
        disabled={deepArmed}
        onClick={ctl.armDeep}
        type="button"
      >
        {deepArmed ? "Armed — focus target…" : "Deep capture (all modes)"}
      </BaseButton>

      <div className="ml-auto flex items-center gap-2 text-[11px] text-foreground-muted">
        {report ? (
          <>
            <span>{age}</span>
            <span className="text-foreground-dim">·</span>
            <span>{report.durationMs}ms</span>
            <CopyButton report={report} />
          </>
        ) : (
          <span className="text-foreground-dim">no capture yet</span>
        )}
      </div>
    </header>
  );
}

type CopyStatus = "copied" | "error" | "idle";

function CopyButton({ report }: { report: ContextDebugReport }) {
  const [status, setStatus] = useState<CopyStatus>("idle");

  const onCopy = async () => {
    const ok = await copyTextRobust(JSON.stringify(report, null, 2));
    setStatus(ok ? "copied" : "error");
    setTimeout(() => setStatus("idle"), 1500);
  };

  return (
    <BaseButton
      className={cn("rounded px-2 py-1 transition-colors", copyClass(status))}
      onClick={onCopy}
      type="button"
    >
      {copyLabel(status)}
    </BaseButton>
  );
}

function copyLabel(status: CopyStatus): string {
  switch (status) {
    case "copied":
      return "✓ Copied!";
    case "error":
      return "Copy failed — use Raw JSON below";
    default:
      return "Copy JSON";
  }
}

function copyClass(status: CopyStatus): string {
  switch (status) {
    case "copied":
      return "bg-success-dim text-success";
    case "error":
      return "bg-error-dim text-error";
    default:
      return "bg-surface-tertiary text-foreground hover:bg-surface-hover";
  }
}

/**
 * Copy text robustly from the reference renderer. The async Clipboard API works
 * when the document is focused (it is — the user just clicked our button); the
 * legacy textarea + execCommand path covers file:// where the async API can be
 * blocked. Returns whether either path succeeded.
 *
 * NOTE: the earlier `clipboardWriteText` route went through secure-IPC, whose
 * `invokeSecureOrDefault` swallows errors and returns a fake-success fallback —
 * that's why copy silently stopped working. Always copy directly in-renderer.
 */
async function copyTextRobust(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function Body({ ctl }: { ctl: ContextPlaygroundController }) {
  const { report, waiting } = ctl;

  if (!report) {
    return <EmptyHint waiting={waiting} />;
  }

  return (
    <>
      {waiting === "own-window-focused" && (
        <Banner tone="muted">
          Showing the last external capture. Click into a field in another app
          to refresh.
        </Banner>
      )}
      {!report.contextAwarenessEnabled && (
        <Banner tone="warning">
          Context awareness is <b>OFF</b> in settings; dictation won't use any
          of this. The playground still shows what <i>would</i> be captured.
        </Banner>
      )}
      {report.denied && (
        <Banner tone="error">
          Deny-listed{report.deniedReason ? ` by "${report.deniedReason}"` : ""}
          : sensitive fields stripped before the model sees them.
        </Banner>
      )}

      <Summary report={report} />
      <Section
        subtitle={`${report.metrics.promptFragmentChars} chars`}
        title="LLM prompt fragment"
      >
        <Pre value={report.promptFragment} />
      </Section>
      <Section
        subtitle={`${report.asrPromptTail.length} chars · what Whisper actually receives`}
        title="ASR (Whisper) prior-text bias"
      >
        <Pre value={report.asrPromptTail} />
        {report.asrPromptTailRaw !== report.asrPromptTail && (
          <div className="mt-2">
            <div className="mb-0.5 text-[10px] text-foreground-dim">
              raw textBefore — before sanitize + 250-char cap (
              {report.asrPromptTailRaw.length} chars)
            </div>
            <Pre value={report.asrPromptTailRaw} />
          </div>
        )}
      </Section>
      <RawSnapshot metrics={report.metrics} snapshot={report.rawSnapshot} />
      {report.modes && <ModesComparison modes={report.modes} />}
      <Metrics report={report} />
      <RawJsonBlock report={report} />
    </>
  );
}

/**
 * Always-available fallback for copying the report: a readonly textarea holding
 * the full JSON. Focusing it selects everything so the user can Ctrl+C even if
 * the Clipboard API and execCommand are both blocked. The "copy can never
 * silently fail" safety net.
 */
function RawJsonBlock({ report }: { report: ContextDebugReport }) {
  const json = JSON.stringify(report, null, 2);
  return (
    <Section
      subtitle={`${json.length} chars · click to select all, then Ctrl+C`}
      title="Raw JSON"
    >
      <textarea
        className="h-40 w-full resize-y rounded border border-border bg-surface px-2 py-1.5 font-mono text-[11px] text-foreground-secondary"
        onFocus={(e) => e.currentTarget.select()}
        readOnly
        value={json}
      />
    </Section>
  );
}

function EmptyHint({
  waiting,
}: {
  waiting: ContextPlaygroundController["waiting"];
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-foreground-muted">
      <div className="text-4xl">👆</div>
      <p className="max-w-sm text-body-sm">
        Click into any text field in another app (email body, browser input,
        your editor) to see exactly what WinSTT's context awareness captures
        from it.
      </p>
      {waiting === "live-off" && (
        <p className="text-[11px] text-foreground-dim">
          Live polling is paused.
        </p>
      )}
    </div>
  );
}

// --- Summary chips ------------------------------------------------------

function Summary({ report }: { report: ContextDebugReport }) {
  const s = report.rawSnapshot;
  return (
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
      <Chip label="App" value={s.appExe || "—"} />
      <Chip label="URL" value={s.url || "—"} />
      <Chip
        label="IDE"
        tone={report.isIde ? "accent" : "muted"}
        value={report.isIde ? "yes" : "no"}
      />
      <Chip
        label="Terminal"
        tone={report.isTerminal ? "warning" : "muted"}
        value={report.isTerminal ? "yes" : "no"}
      />
      <Chip
        className="col-span-2 sm:col-span-3"
        label="Window"
        value={s.windowTitle || "—"}
      />
      <Chip
        className="col-span-2 sm:col-span-3"
        label="Focused field"
        value={s.elementName || "—"}
      />
      <Chip
        label="Caret split"
        tone={report.hasCaret ? "success" : "muted"}
        value={report.hasCaret ? "yes" : "no"}
      />
      <Chip
        label="Denied"
        tone={report.denied ? "error" : "success"}
        value={report.denied ? "yes" : "no"}
      />
      <Chip
        label="Contentless"
        tone={report.contentless ? "warning" : "muted"}
        value={report.contentless ? "yes" : "no"}
      />
      <Chip
        label="OCR used"
        tone={report.ocrUsed ? "warning" : "muted"}
        value={report.ocrUsed ? "yes" : "no"}
      />
    </div>
  );
}

type ChipTone = "accent" | "error" | "muted" | "success" | "warning";

function Chip({
  label,
  value,
  tone,
  className,
}: {
  className?: string;
  label: string;
  tone?: ChipTone;
  value: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-0.5 rounded border border-border bg-surface-secondary px-2 py-1",
        className,
      )}
    >
      <span className="text-[10px] text-foreground-dim uppercase tracking-wide">
        {label}
      </span>
      <span
        className={cn("truncate font-mono text-[11px]", toneClass(tone))}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function toneClass(tone: ChipTone | undefined): string {
  switch (tone) {
    case "accent":
      return "text-accent";
    case "success":
      return "text-success";
    case "warning":
      return "text-warning";
    case "error":
      return "text-error";
    case "muted":
      return "text-foreground-muted";
    default:
      return "text-foreground";
  }
}

// --- Raw snapshot -------------------------------------------------------

function RawSnapshot({
  snapshot,
  metrics,
}: {
  metrics: ContextDebugReport["metrics"];
  snapshot: ContextSnapshotView;
}) {
  return (
    <Section title="Raw UIA snapshot (tree mode — the production path)">
      <div className="space-y-2">
        <Field label="Text before caret" value={snapshot.textBefore} />
        <Field label="Text after caret" value={snapshot.textAfter} />
        <Field label="Focused text" value={snapshot.focusedText} />
        <Field
          label={`axHtml (${metrics.axHtmlChars} / ${metrics.axHtmlCap} cap)`}
          tall
          value={snapshot.axHtml}
        />
        {snapshot.ocrText !== undefined && (
          <Field label="OCR text (fallback)" value={snapshot.ocrText} />
        )}
      </div>
    </Section>
  );
}

// --- Deep mode comparison ----------------------------------------------

function ModesComparison({ modes }: { modes: ContextModeResult[] }) {
  return (
    <Section title="All UIA modes (deep capture)">
      <div className="space-y-2">
        {modes.map((mode) => (
          <ModeCard key={mode.mode} result={mode} />
        ))}
      </div>
    </Section>
  );
}

function ModeCard({ result }: { result: ContextModeResult }) {
  const s = result.snapshot;
  return (
    <div className="rounded border border-border bg-surface-secondary p-2">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-mono font-semibold text-[11px]">
          {result.mode}
        </span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px]",
            result.ok
              ? "bg-success-dim text-success"
              : "bg-surface-tertiary text-foreground-dim",
          )}
        >
          {result.ok ? "content" : "empty"}
        </span>
        <span className="ml-auto text-[10px] text-foreground-muted">
          {result.durationMs}ms
        </span>
      </div>
      <div className="space-y-1">
        <MiniField label="focusedText" value={s.focusedText} />
        <MiniField label="textBefore" value={s.textBefore} />
        <MiniField label="textAfter" value={s.textAfter} />
      </div>
    </div>
  );
}

function MiniField({
  label,
  value,
}: {
  label: string;
  value: string | undefined;
}) {
  const text = (value ?? "").trim();
  return (
    <div className="flex gap-2 text-[11px]">
      <span className="w-20 shrink-0 text-foreground-dim">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-foreground-secondary">
        {text || <span className="text-foreground-dim">(empty)</span>}
      </span>
    </div>
  );
}

// --- Metrics ------------------------------------------------------------

function Metrics({ report }: { report: ContextDebugReport }) {
  const m = report.metrics;
  return (
    <Section title="Metrics">
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        <Stat label="focusedText" value={m.focusedTextChars} />
        <Stat label="textBefore" value={m.textBeforeChars} />
        <Stat label="textAfter" value={m.textAfterChars} />
        <Stat label="axHtml" value={m.axHtmlChars} />
        <Stat label="prompt frag" value={m.promptFragmentChars} />
        <Stat label="deny-list" value={m.denyListSize} />
      </div>
    </Section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-border bg-surface-secondary px-2 py-1">
      <div className="text-[10px] text-foreground-dim">{label}</div>
      <div className="font-mono text-body-sm">{value}</div>
    </div>
  );
}

// --- Primitives ---------------------------------------------------------

function Section({
  title,
  subtitle,
  children,
}: {
  children: React.ReactNode;
  subtitle?: string;
  title: string;
}) {
  return (
    <section className="rounded-md border border-border bg-surface-primary p-2">
      <div className="mb-1.5 flex items-baseline gap-2">
        <h2 className="font-semibold text-[11px] text-foreground-secondary uppercase tracking-wide">
          {title}
        </h2>
        {subtitle && (
          <span className="text-[10px] text-foreground-dim">{subtitle}</span>
        )}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  value,
  tall,
}: {
  label: string;
  tall?: boolean;
  value: string | undefined;
}) {
  return (
    <div>
      <div className="mb-0.5 text-[10px] text-foreground-dim">{label}</div>
      <Pre tall={tall ?? false} value={value} />
    </div>
  );
}

function Pre({ value, tall }: { tall?: boolean; value: string | undefined }) {
  const text = value ?? "";
  return (
    <pre
      className={cn(
        "overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-surface px-2 py-1.5 font-mono text-[11px] text-foreground-secondary",
        tall ? "max-h-64" : "max-h-40",
      )}
    >
      {text.length > 0 ? (
        text
      ) : (
        <span className="text-foreground-dim">(empty)</span>
      )}
    </pre>
  );
}

function Banner({
  tone,
  children,
}: {
  children: React.ReactNode;
  tone: "error" | "muted" | "warning";
}) {
  return (
    <div
      className={cn(
        "rounded border px-2.5 py-1.5 text-[11px]",
        bannerToneClass(tone),
      )}
    >
      {children}
    </div>
  );
}

function bannerToneClass(tone: "error" | "muted" | "warning"): string {
  switch (tone) {
    case "error":
      return "border-error/40 bg-error-dim text-error";
    case "warning":
      return "border-warning/40 bg-warning-dim text-warning";
    default:
      return "border-border bg-surface-secondary text-foreground-muted";
  }
}

// --- Helpers ------------------------------------------------------------

function formatAge(deltaMs: number): string {
  const secs = Math.max(0, Math.round(deltaMs / 1000));
  if (secs < 1) {
    return "just now";
  }
  if (secs < 60) {
    return `${secs}s ago`;
  }
  const mins = Math.floor(secs / 60);
  return `${mins}m ago`;
}
