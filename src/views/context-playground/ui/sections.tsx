/* eslint-disable i18next/no-literal-string -- debug-only window, not user-facing/shipped */
import type {
  ContextDebugReport,
  ContextModeResult,
  ContextSnapshotView,
} from "@/shared/api/context-debug-types";
import { cn } from "@/shared/lib/cn";
import type { ContextPlaygroundController } from "../model/use-context-playground";
import { Field, Pre, Section } from "./primitives";

/**
 * Always-available fallback for copying the report: a readonly textarea holding
 * the full JSON. Focusing it selects everything so the user can Ctrl+C even if
 * the Clipboard API and execCommand are both blocked. The "copy can never
 * silently fail" safety net.
 */
export function RawJsonBlock({ report }: { report: ContextDebugReport }) {
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

export function EmptyHint({
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

// --- Raw snapshot -------------------------------------------------------

export function RawSnapshot({
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

export function ModesComparison({ modes }: { modes: ContextModeResult[] }) {
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

export function Metrics({ report }: { report: ContextDebugReport }) {
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
