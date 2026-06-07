/* eslint-disable i18next/no-literal-string -- debug-only window, not user-facing/shipped */
import {
  type ContextPlaygroundController,
  useContextPlayground,
  useNow,
} from "../model/use-context-playground";
import { Header } from "./Header";
import { Banner, Pre, Section } from "./primitives";
import {
  EmptyHint,
  Metrics,
  ModesComparison,
  RawJsonBlock,
  RawSnapshot,
} from "./sections";
import { Summary } from "./Summary";

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
