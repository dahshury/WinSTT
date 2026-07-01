import type { ReactNode } from "react";
import { withBasePath } from "@/lib/site";

const featureIcon = (children: ReactNode) => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

const features = [
  {
    icon: featureIcon(
      <>
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" x2="12" y1="19" y2="22" />
      </>,
    ),
    title: "Real-Time Preview",
    description:
      "See words appear as you speak. Dual-model architecture runs a fast model for live preview alongside a large model for final accuracy.",
    href: "/docs/settings/quality",
  },
  {
    icon: featureIcon(
      <>
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        <polyline points="7.5 4.21 12 6.81 16.5 4.21" />
        <polyline points="7.5 19.79 7.5 14.6 3 12" />
        <polyline points="21 12 16.5 14.6 16.5 19.79" />
        <line x1="3.27" x2="12" y1="6.96" y2="12.01" />
        <line x1="12" x2="20.73" y1="12.01" y2="6.96" />
        <line x1="12" x2="12" y1="22.08" y2="12" />
      </>,
    ),
    title: "70+ AI Models",
    description:
      "OpenAI Whisper, NVIDIA NeMo (Parakeet & Canary), Moonshine, Cohere, GigaAM, Vosk. Switch models from the UI - no restart.",
    href: "/docs/models",
  },
  {
    icon: featureIcon(
      <path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z" />,
    ),
    title: "Four Recording Modes",
    description:
      "Push-to-talk, toggle, passive listen mode (loopback capture), and wake-word activation.",
    href: "/docs/dictation",
  },
  {
    icon: featureIcon(
      <>
        <path d="M6 18h8" />
        <path d="M3 22h18" />
        <path d="M14 22a7 7 0 1 0 0-14h-1" />
        <path d="M9 14h2" />
        <path d="M9 12a2 2 0 0 1-2-2V6h6v4a2 2 0 0 1-2 2Z" />
        <path d="M12 6V3a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v3" />
      </>,
    ),
    title: "Platform-Native Packages",
    description:
      "Download a macOS Apple Silicon DMG, Linux AppImage/deb/rpm packages, or Windows portable builds from the same release.",
    href: "/docs/install",
  },
  {
    icon: featureIcon(
      <>
        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" x2="8" y1="13" y2="13" />
        <line x1="16" x2="8" y1="17" y2="17" />
        <line x1="10" x2="8" y1="9" y2="9" />
      </>,
    ),
    title: "File Transcription",
    description:
      "Drop audio files for batch transcription. Export as plain text or SRT subtitles with timestamps.",
    href: "/docs/file-transcription",
  },
  {
    icon: featureIcon(
      <>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
      </>,
    ),
    title: "Dictionary & Snippets",
    description:
      "Fuzzy-match correction nudges misheard names to the right spelling. Trigger words expand into full text.",
    href: "/docs/dictionary",
  },
  {
    icon: featureIcon(
      <>
        <path d="M3 3v18h18" />
        <rect x="7" y="12" width="3" height="6" rx="0.5" />
        <rect x="12" y="8" width="3" height="10" rx="0.5" />
        <rect x="17" y="5" width="3" height="13" rx="0.5" />
      </>,
    ),
    title: "Transcription History",
    description:
      "A local dashboard of everything you've dictated - word stats, an activity heatmap, and a searchable log.",
    href: "/docs/transcription-history",
  },
  {
    icon: featureIcon(
      <>
        <path d="M12 8V4H8" />
        <rect width="16" height="12" x="4" y="8" rx="2" />
        <path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
      </>,
    ),
    title: "LLM Text Enhancement",
    description:
      "Clean up dictation or run custom hotkey-triggered transforms - local Ollama or, opt-in, OpenRouter.",
    href: "/docs/settings/quality#llm-cleanup",
  },
  {
    icon: featureIcon(
      <>
        <path d="M11 4.7 7.6 8H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h3.6L11 19.3a1 1 0 0 0 1.7-.7V5.4a1 1 0 0 0-1.7-.7Z" />
        <path d="M16 9a5 5 0 0 1 0 6" />
        <path d="M19.4 6a10 10 0 0 1 0 12" />
      </>,
    ),
    title: "Text-to-Speech",
    description:
      "Read selected text aloud with the bundled Kokoro-82M ONNX voice model - 54 voices across 9 languages.",
    href: "/docs/text-to-speech",
  },
  {
    icon: featureIcon(
      <>
        <circle cx="12" cy="12" r="10" />
        <path d="M2 12h20" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </>,
    ),
    title: "Localized UI",
    description:
      "Interface available in English, Spanish, French, Chinese, Hindi, and Arabic.",
    href: "/docs",
  },
];

export function HomeFeatures() {
  return (
    <section className="w-full max-w-5xl px-6 pb-24">
      <div className="mb-10 text-center">
        <h2
          className="mb-2 font-bold text-2xl tracking-tight"
          style={{ color: "color-mix(in oklab, var(--fg-strong) 90%, transparent)" }}
        >
          Everything you need
        </h2>
        <p className="text-sm" style={{ color: "color-mix(in oklab, var(--fg-strong) 35%, transparent)" }}>
          A complete speech-to-text toolkit, running locally on your desktop
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {features.map((feature) => (
          <a
            key={feature.title}
            href={withBasePath(feature.href)}
            className="feature-card group rounded-xl p-5"
            style={{
              background: "var(--surface-2)",
              border: "1px solid var(--divider)",
            }}
          >
            <div
              className="feature-icon mb-3 inline-flex rounded-lg p-2.5 transition-all duration-300"
              style={{
                background: "color-mix(in oklab, var(--brand-accent) 8%, transparent)",
                color: "var(--brand-accent)",
              }}
            >
              {feature.icon}
            </div>
            <h3
              className="mb-1.5 font-semibold text-[13.5px] transition-colors duration-200"
              style={{ color: "color-mix(in oklab, var(--fg-strong) 90%, transparent)" }}
            >
              {feature.title}
            </h3>
            <p
              className="text-[13px] leading-relaxed"
              style={{ color: "color-mix(in oklab, var(--fg-strong) 40%, transparent)" }}
            >
              {feature.description}
            </p>
            <div
              className="mt-3 flex items-center gap-1 font-medium text-xs opacity-0 transition-opacity duration-200 group-hover:opacity-100"
              style={{ color: "var(--brand-accent)" }}
            >
              Learn more about {feature.title}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12h14" />
                <path d="m12 5 7 7-7 7" />
              </svg>
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}
