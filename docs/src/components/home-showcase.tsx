import { MediaGrid } from "@/components/docs-ui";
import {
  ShowcaseCard,
  ShowcaseDictation,
  ShowcaseHistory,
  ShowcaseLLM,
  ShowcaseModelPicker,
  ShowcaseRecordingModes,
  ShowcaseTTS,
} from "@/components/feature-showcases";

export function HomeShowcase() {
  return (
    <section className="w-full max-w-5xl px-6 pb-16">
      <div className="mb-8 text-center">
        <h2
          className="mb-2 font-bold text-2xl tracking-tight"
          style={{
            color: "color-mix(in oklab, var(--fg-strong) 90%, transparent)",
          }}
        >
          See it in action
        </h2>
        <p
          className="text-sm"
          style={{
            color: "color-mix(in oklab, var(--fg-strong) 35%, transparent)",
          }}
        >
          A focused look at the features you reach for every day - each one
          running locally on your machine.
        </p>
      </div>
      <MediaGrid cols={3}>
        <ShowcaseCard
          label="Live dictation"
          url="winstt.app/dictation"
          caption="Words land as you speak - a fast model previews live while the accurate model finalizes."
        >
          <ShowcaseDictation />
        </ShowcaseCard>
        <ShowcaseCard
          label="Model picker"
          url="winstt.app/models"
          caption="Browse 70+ speech models - maker, size, and quantization at a glance."
        >
          <ShowcaseModelPicker />
        </ShowcaseCard>
        <ShowcaseCard
          label="AI clean-up"
          url="winstt.app/enhance"
          caption="Strip filler and fix punctuation with a local LLM - and see exactly what changed."
        >
          <ShowcaseLLM />
        </ShowcaseCard>
        <ShowcaseCard
          label="Recording modes"
          url="winstt.app/modes"
          caption="Push-to-talk, toggle, passive listen, or wake-word activation."
        >
          <ShowcaseRecordingModes />
        </ShowcaseCard>
        <ShowcaseCard
          label="Text-to-speech"
          url="winstt.app/speech"
          caption="Read any text aloud with Kokoro - 54 voices across 9 languages."
        >
          <ShowcaseTTS />
        </ShowcaseCard>
        <ShowcaseCard
          label="History"
          url="winstt.app/history"
          caption="Words-per-minute, AI-fix impact, streaks, and a year-long activity graph."
        >
          <ShowcaseHistory />
        </ShowcaseCard>
      </MediaGrid>
    </section>
  );
}
