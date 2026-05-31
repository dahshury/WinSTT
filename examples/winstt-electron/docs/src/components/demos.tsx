/**
 * Demo registry for ComponentPreviewTooltip. Every entry is a short looping
 * .webm in /demos/:
 *   - viz-* and overlay-* are recorded from the REAL app (true 1:1) — see
 *     frontend/scripts/docs-shots/record.mjs.
 *   - the conceptual story flows (ptt, toggle, listen, wakeword, llm-*,
 *     auto-submit, dictionary, snippets) are frame-perfect Remotion renders —
 *     see tools/remotion-demos/.
 */
import type { ComponentType } from "react";

function DemoVideo({ src }: { src: string }) {
  return (
    <video
      className="demo-video"
      src={`/demos/${src}.webm`}
      autoPlay
      loop
      muted
      playsInline
      preload="metadata"
      tabIndex={-1}
    />
  );
}

const vid = (src: string) => () => <DemoVideo src={src} />;

export const DEMOS: Record<string, ComponentType> = {
  // Conceptual story flows — Remotion renders.
  ptt: vid("ptt"),
  toggle: vid("toggle"),
  listen: vid("listen"),
  wakeword: vid("wakeword"),
  "llm-dictation": vid("llm-dictation"),
  "llm-transform": vid("llm-transform"),
  "auto-submit": vid("auto-submit"),
  dictionary: vid("dictionary"),
  snippets: vid("snippets"),
  "transcribe-file": vid("transcribe-file"),
  // Real components, recorded live (true 1:1).
  "viz-bar": vid("viz-bar"),
  "viz-grid": vid("viz-grid"),
  "viz-radial": vid("viz-radial"),
  "viz-wave": vid("viz-wave"),
  "viz-aura": vid("viz-aura"),
  "overlay-floating": vid("overlay-floating"),
  "overlay-island": vid("overlay-island"),
};
