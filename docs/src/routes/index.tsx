import appIconUrl from "@app-icon";
import { createFileRoute, Link } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { AppMock } from "@/components/app-mock";
import { MediaGrid, Screenshot } from "@/components/docs-ui";
import { baseOptions } from "@/lib/layout.shared";
import {
  latestDownloadReleaseUrl,
  repositoryUrl,
  withBasePath,
} from "@/lib/site";

export const Route = createFileRoute("/")({
  component: HomePage,
});

const features = [
  {
    icon: (
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
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" x2="12" y1="19" y2="22" />
      </svg>
    ),
    title: "Real-Time Preview",
    description:
      "See words appear as you speak. Dual-model architecture runs a fast model for live preview alongside a large model for final accuracy.",
    href: "/docs/settings/quality",
  },
  {
    icon: (
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
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        <polyline points="7.5 4.21 12 6.81 16.5 4.21" />
        <polyline points="7.5 19.79 7.5 14.6 3 12" />
        <polyline points="21 12 16.5 14.6 16.5 19.79" />
        <line x1="3.27" x2="12" y1="6.96" y2="12.01" />
        <line x1="12" x2="20.73" y1="12.01" y2="6.96" />
        <line x1="12" x2="12" y1="22.08" y2="12" />
      </svg>
    ),
    title: "40+ AI Models",
    description:
      "OpenAI Whisper, NVIDIA NeMo (Parakeet & Canary), Moonshine, Cohere, GigaAM, Vosk. Switch models from the UI — no restart.",
    href: "/docs/models",
  },
  {
    icon: (
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
        <path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z" />
      </svg>
    ),
    title: "Four Recording Modes",
    description:
      "Push-to-talk, toggle, passive listen mode (loopback capture), and wake-word activation.",
    href: "/docs/recording-modes",
  },
  {
    icon: (
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
        <path d="M6 18h8" />
        <path d="M3 22h18" />
        <path d="M14 22a7 7 0 1 0 0-14h-1" />
        <path d="M9 14h2" />
        <path d="M9 12a2 2 0 0 1-2-2V6h6v4a2 2 0 0 1-2 2Z" />
        <path d="M12 6V3a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v3" />
      </svg>
    ),
    title: "Platform-Native Packages",
    description:
      "Download a macOS Apple Silicon DMG, Linux AppImage/deb/rpm packages, or Windows portable builds from the same release.",
    href: "/docs/install",
  },
  {
    icon: (
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
        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" x2="8" y1="13" y2="13" />
        <line x1="16" x2="8" y1="17" y2="17" />
        <line x1="10" x2="8" y1="9" y2="9" />
      </svg>
    ),
    title: "File Transcription",
    description:
      "Drop audio files for batch transcription. Export as plain text or SRT subtitles with timestamps.",
    href: "/docs/file-transcription",
  },
  {
    icon: (
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
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
    ),
    title: "Dictionary & Snippets",
    description:
      "Fuzzy-match correction nudges misheard names to the right spelling. Trigger words expand into full text.",
    href: "/docs/dictionary",
  },
  {
    icon: (
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
        <path d="M3 3v18h18" />
        <rect x="7" y="12" width="3" height="6" rx="0.5" />
        <rect x="12" y="8" width="3" height="10" rx="0.5" />
        <rect x="17" y="5" width="3" height="13" rx="0.5" />
      </svg>
    ),
    title: "Transcription History",
    description:
      "A local dashboard of everything you've dictated — word stats, an activity heatmap, and a searchable log.",
    href: "/docs/transcription-history",
  },
  {
    icon: (
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
        <path d="M12 8V4H8" />
        <rect width="16" height="12" x="4" y="8" rx="2" />
        <path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
      </svg>
    ),
    title: "LLM Text Enhancement",
    description:
      "Clean up dictation or run custom hotkey-triggered transforms — local Ollama or, opt-in, OpenRouter.",
    href: "/docs/settings/llm",
  },
  {
    icon: (
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
        <path d="M11 4.7 7.6 8H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h3.6L11 19.3a1 1 0 0 0 1.7-.7V5.4a1 1 0 0 0-1.7-.7Z" />
        <path d="M16 9a5 5 0 0 1 0 6" />
        <path d="M19.4 6a10 10 0 0 1 0 12" />
      </svg>
    ),
    title: "Text-to-Speech",
    description:
      "Read selected text aloud with the bundled Kokoro-82M ONNX voice model — 54 voices across 9 languages.",
    href: "/docs/text-to-speech",
  },
  {
    icon: (
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
        <circle cx="12" cy="12" r="10" />
        <path d="M2 12h20" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    ),
    title: "Localized UI",
    description:
      "Interface available in English, Spanish, French, Chinese, Hindi, and Arabic.",
    href: "/docs",
  },
];

function GitHubIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function WifiOffIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h.01" />
      <path d="M8.5 16.429a5 5 0 0 1 7 0" />
      <path d="M5 12.859a10 10 0 0 1 5.17-2.69" />
      <path d="M19 12.859a10 10 0 0 0-2.007-1.523" />
      <path d="M2 8.82a15 15 0 0 1 4.177-2.643" />
      <path d="M22 8.82a15 15 0 0 0-11.288-3.764" />
      <path d="m2 2 20 20" />
    </svg>
  );
}

function CpuIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M15 2v2" />
      <path d="M15 20v2" />
      <path d="M2 15h2" />
      <path d="M2 9h2" />
      <path d="M20 15h2" />
      <path d="M20 9h2" />
      <path d="M9 2v2" />
      <path d="M9 20v2" />
    </svg>
  );
}

function HeartIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}

const privacyBadges = [
  { icon: <ShieldIcon />, label: "100% local" },
  { icon: <WifiOffIcon />, label: "Works offline" },
  { icon: <CpuIcon />, label: "On-device AI" },
  { icon: <HeartIcon />, label: "Free & open source" },
];

function HomePage() {
  return (
    <HomeLayout {...baseOptions()}>
      <div className="flex flex-col items-center flex-1 overflow-hidden">
        <section className="relative w-full flex flex-col items-center pt-5 pb-12 px-6">
          <div
            className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[500px] rounded-full blur-3xl pointer-events-none"
            style={{
              background:
                "radial-gradient(ellipse, oklch(62% 0.19 260 /0.06) 0%, transparent 70%)",
            }}
          />

          <div className="relative mb-10">
            <div className="relative z-10">
              <img
                src={appIconUrl}
                width={168}
                height={168}
                alt="WinSTT application icon"
                style={{ display: "block", borderRadius: "22px" }}
              />
            </div>
          </div>

          <a
            href={`${repositoryUrl}/blob/main/LICENSE`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full mb-4 transition-all hover:brightness-110"
            style={{
              background: "oklch(62% 0.19 260 / 0.1)",
              border: "1px solid oklch(62% 0.19 260 / 0.28)",
              color: "oklch(82% 0.13 260)",
              fontSize: "11.5px",
              fontWeight: 600,
              letterSpacing: "0.03em",
              textTransform: "uppercase",
            }}
          >
            <HeartIcon />
            100% Free · Open Source · MIT
          </a>

          <h1 className="text-5xl font-bold tracking-tight mb-4">WinSTT</h1>
          <p
            className="text-lg max-w-xl text-center leading-relaxed"
            style={{ color: "oklch(94% 0.015 265 /0.55)" }}
          >
            A complete local voice toolkit for macOS, Linux, and Windows.
            Speech-to-text, text-to-speech, wake-word detection, and LLM-powered
            text processing — powered by Whisper, NeMo, and 40+ AI models,
            completely offline and entirely on your hardware. Free forever,
            source on GitHub.
          </p>

          <div className="flex flex-wrap items-center justify-center gap-2 mt-6">
            {privacyBadges.map((badge) => (
              <div
                key={badge.label}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full"
                style={{
                  background: "oklch(68% 0.17 150 / 0.08)",
                  border: "1px solid oklch(68% 0.17 150 / 0.18)",
                  color: "oklch(82% 0.12 150 / 0.9)",
                  fontSize: "12px",
                  fontWeight: 500,
                }}
              >
                {badge.icon}
                {badge.label}
              </div>
            ))}
          </div>

          <div className="flex flex-wrap justify-center gap-3 mt-8">
            <a
              href={latestDownloadReleaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg font-medium text-sm transition-all hover:brightness-110"
              style={{
                background: "var(--brand-accent)",
                color: "var(--fg-strong)",
                boxShadow:
                  "inset 0 1px 0 0 oklch(100% 0 0 / 0.12), 0 0 24px oklch(62% 0.19 260 / 0.25)",
              }}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" x2="12" y1="15" y2="3" />
              </svg>
              Download latest
            </a>
            <Link
              to="/docs/$"
              params={{ _splat: "" }}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg font-medium text-sm transition-all hover:brightness-125"
              style={{
                background: "oklch(94% 0.015 265 /0.05)",
                border: "1px solid oklch(94% 0.015 265 /0.1)",
                color: "oklch(94% 0.015 265 /0.7)",
              }}
            >
              Documentation
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M5 12h14" />
                <path d="m12 5 7 7-7 7" />
              </svg>
            </Link>
            <a
              href={repositoryUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg font-medium text-sm transition-all hover:brightness-125"
              style={{
                background: "oklch(94% 0.015 265 /0.05)",
                border: "1px solid oklch(94% 0.015 265 /0.1)",
                color: "oklch(94% 0.015 265 /0.7)",
              }}
            >
              <GitHubIcon />
              GitHub
            </a>
          </div>
        </section>

        <section className="relative w-full flex flex-col items-center px-6 pt-4 pb-20">
          <div
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[400px] rounded-full blur-3xl pointer-events-none"
            style={{
              background:
                "radial-gradient(ellipse, oklch(62% 0.19 260 /0.04) 0%, transparent 70%)",
            }}
          />

          <AppMock />

          <p
            className="mt-4 text-center"
            style={{
              fontSize: "12px",
              color: "oklch(94% 0.015 265 /0.25)",
              fontFamily: '"Geist Mono", monospace',
              letterSpacing: "0.3px",
            }}
          >
            The main window — 9-band audio visualizer with live hotkey, mic and
            model chips
          </p>
        </section>

        <section className="w-full max-w-5xl px-6 pb-16">
          <div className="text-center mb-8">
            <h2
              className="text-2xl font-bold tracking-tight mb-2"
              style={{ color: "oklch(94% 0.015 265 /0.9)" }}
            >
              Choose the right model quickly
            </h2>
            <p
              className="text-sm"
              style={{ color: "oklch(94% 0.015 265 /0.35)" }}
            >
              Compare accuracy, speed, size, languages, and quantization before
              you switch.
            </p>
          </div>
          <MediaGrid cols={3}>
            <Screenshot
              src="feat-model"
              alt="The model picker open, showing STT models grouped by maker with accuracy and speed bars, sizes, and quantization badges."
              label="Model picker"
              caption="Browse 40+ STT models — accuracy and speed at a glance."
              aspect="3 / 2"
              focus="top"
              variant="thumb"
            />
            <Screenshot
              src="feat-stt"
              alt="The Model settings tab with the Source toggle between Local and Cloud, plus model, language, and device options."
              label="Speech-to-text"
              caption="Transcribe on-device, or switch to OpenAI or ElevenLabs in the cloud."
              aspect="3 / 2"
              focus="top"
              variant="thumb"
            />
            <Screenshot
              src="feat-tts"
              alt="The Text-to-Speech settings with a Local/Cloud source toggle, voice selector, and playback speed."
              label="Text-to-speech"
              caption="Read text aloud with local Kokoro or cloud ElevenLabs voices."
              aspect="3 / 2"
              focus="center"
              variant="thumb"
            />
            <Screenshot
              src="feat-llm"
              alt="The LLM post-processing settings with a local-Ollama / cloud-OpenRouter provider toggle, model, tone, and modifiers."
              label="LLM post-processing"
              caption="Clean up and reshape dictation — local Ollama or cloud OpenRouter."
              aspect="3 / 2"
              focus="top"
              variant="thumb"
            />
            <Screenshot
              src="feat-recording"
              alt="The Recording settings showing the mode selector: Push to Talk, Toggle, Listen, and Wake Word."
              label="Recording modes"
              caption="Push-to-talk, toggle, listen, or wake word."
              aspect="3 / 2"
              focus="top"
              variant="thumb"
            />
            <Screenshot
              src="feat-history"
              alt="The transcription history dashboard with stat tiles and a daily-activity heatmap."
              label="History"
              caption="Stats, an activity heatmap, and karaoke playback."
              aspect="3 / 2"
              focus="top"
              variant="thumb"
            />
          </MediaGrid>
        </section>

        <section className="w-full max-w-3xl px-6 pb-16">
          <div
            className="relative overflow-hidden rounded-xl p-6"
            style={{
              background:
                "linear-gradient(135deg, oklch(22% 0.06 155 / 0.35) 0%, var(--surface-1) 100%)",
              border: "1px solid oklch(60% 0.15 150 / 0.2)",
            }}
          >
            <div className="flex items-start gap-4">
              <div
                className="shrink-0 p-2.5 rounded-lg mt-0.5"
                style={{
                  background: "oklch(68% 0.17 150 / 0.12)",
                  color: "oklch(82% 0.12 150 / 0.9)",
                }}
              >
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
                  <path d="m9 12 2 2 4-4" />
                </svg>
              </div>
              <div>
                <h3
                  className="font-semibold text-sm mb-1.5"
                  style={{ color: "oklch(86% 0.1 150 / 0.95)" }}
                >
                  Your voice stays on your machine
                </h3>
                <p
                  className="text-sm leading-relaxed"
                  style={{ color: "oklch(94% 0.015 265 /0.45)" }}
                >
                  Transcription runs entirely on your local hardware. Audio is
                  processed in-memory by on-device AI models and never written
                  to disk or sent anywhere — no usage analytics. Optional LLM
                  cleanup is local (Ollama) unless you opt into OpenRouter.
                  Anonymized crash reports are opt-out. You own your data.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="w-full max-w-5xl px-6 pb-24">
          <div className="text-center mb-10">
            <h2
              className="text-2xl font-bold tracking-tight mb-2"
              style={{ color: "oklch(94% 0.015 265 /0.9)" }}
            >
              Everything you need
            </h2>
            <p
              className="text-sm"
              style={{ color: "oklch(94% 0.015 265 /0.35)" }}
            >
              A complete speech-to-text toolkit, running locally on your desktop
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {features.map((feature) => (
              <a
                key={feature.title}
                href={withBasePath(feature.href)}
                className="feature-card group p-5 rounded-xl"
                style={{
                  background: "var(--surface-2)",
                  border: "1px solid var(--divider)",
                }}
              >
                <div
                  className="feature-icon inline-flex p-2.5 rounded-lg mb-3 transition-all duration-300"
                  style={{
                    background: "oklch(62% 0.19 260 /0.08)",
                    color: "var(--brand-accent)",
                  }}
                >
                  {feature.icon}
                </div>
                <h3
                  className="font-semibold text-[13.5px] mb-1.5 transition-colors duration-200"
                  style={{ color: "oklch(94% 0.015 265 /0.9)" }}
                >
                  {feature.title}
                </h3>
                <p
                  className="text-[13px] leading-relaxed"
                  style={{ color: "oklch(94% 0.015 265 /0.4)" }}
                >
                  {feature.description}
                </p>
                <div
                  className="mt-3 flex items-center gap-1 text-xs font-medium opacity-0 group-hover:opacity-100 transition-opacity duration-200"
                  style={{ color: "var(--brand-accent)" }}
                >
                  Learn more
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M5 12h14" />
                    <path d="m12 5 7 7-7 7" />
                  </svg>
                </div>
              </a>
            ))}
          </div>
        </section>
      </div>
    </HomeLayout>
  );
}
