import appIconUrl from "@app-icon";
import { Link } from "@tanstack/react-router";
import { latestDownloadReleaseUrl, repositoryUrl } from "@/lib/site";

const heartIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
  </svg>
);

const githubIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
  </svg>
);

const privacyBadges = [
  {
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    ),
    label: "100% local",
  },
  {
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 20h.01" />
        <path d="M8.5 16.429a5 5 0 0 1 7 0" />
        <path d="M5 12.859a10 10 0 0 1 5.17-2.69" />
        <path d="M19 12.859a10 10 0 0 0-2.007-1.523" />
        <path d="M2 8.82a15 15 0 0 1 4.177-2.643" />
        <path d="M22 8.82a15 15 0 0 0-11.288-3.764" />
        <path d="m2 2 20 20" />
      </svg>
    ),
    label: "Works offline",
  },
  {
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
    ),
    label: "On-device AI",
  },
  { icon: heartIcon, label: "Free & open source" },
];

export function HomeHero() {
  return (
    <section className="relative flex w-full flex-col items-center px-6 pt-5 pb-12">
      <div
        className="pointer-events-none absolute top-0 left-1/2 h-[500px] w-[800px] -translate-x-1/2 rounded-full blur-3xl"
        style={{
          background:
            "radial-gradient(ellipse, color-mix(in oklab, var(--brand-accent) 6%, transparent) 0%, transparent 70%)",
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
        className="mb-4 inline-flex items-center gap-1.5 rounded-full px-3 py-1 transition-all hover:brightness-110"
        style={{
          background: "color-mix(in oklab, var(--brand-accent) 10%, transparent)",
          border: "1px solid color-mix(in oklab, var(--brand-accent) 28%, transparent)",
          color: "var(--brand-accent-hover)",
          fontSize: "12px",
          fontWeight: 600,
          letterSpacing: "0.03em",
          textTransform: "uppercase",
        }}
      >
        {heartIcon}
        100% Free / Open Source / MIT
      </a>
      <h1 className="mb-4 font-bold text-5xl tracking-tight">WinSTT</h1>
      <p
        className="max-w-xl text-justify text-lg leading-relaxed hyphens-auto"
        style={{ color: "color-mix(in oklab, var(--fg-strong) 55%, transparent)" }}
      >
        A complete local voice toolkit for macOS, Linux, and Windows.
        Speech-to-text, text-to-speech, wake-word detection, and LLM-powered
        text processing - powered by Whisper, NeMo, and 70+ AI models,
        completely offline and entirely on your hardware. Free forever, source
        on GitHub.
      </p>
      <div
        className="mt-6 inline-flex flex-col items-stretch overflow-hidden rounded-2xl sm:flex-row sm:rounded-full"
        style={{
          background: "color-mix(in oklab, var(--brand-success) 8%, transparent)",
          border: "1px solid color-mix(in oklab, var(--brand-success) 18%, transparent)",
        }}
        aria-label="Privacy guarantees"
      >
        {privacyBadges.map((badge, index) => (
          <div
            key={badge.label}
            className={`flex items-center justify-center gap-1.5 px-4 py-1.5${
              index > 0 ? " border-t sm:border-t-0 sm:border-l" : ""
            }`}
            style={{
              color: "color-mix(in oklab, var(--brand-success) 90%, transparent)",
              fontSize: "12px",
              fontWeight: 500,
              borderColor: "color-mix(in oklab, var(--brand-success) 18%, transparent)",
            }}
          >
            {badge.icon}
            {badge.label}
          </div>
        ))}
      </div>
      <nav
        aria-label="Get WinSTT"
        className="mt-8 inline-flex flex-col items-stretch overflow-hidden rounded-lg sm:flex-row"
        style={{
          gap: "1px",
          background: "color-mix(in oklab, var(--fg-strong) 12%, transparent)",
          border: "1px solid color-mix(in oklab, var(--fg-strong) 12%, transparent)",
        }}
      >
        <a
          href={latestDownloadReleaseUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-2 px-6 py-2.5 font-medium text-sm transition-all hover:brightness-110"
          style={{
            background: "var(--brand-accent)",
            color: "var(--fg-strong)",
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" x2="12" y1="15" y2="3" />
          </svg>
          Download latest
        </a>
        <Link
          to="/docs/$"
          params={{ _splat: "" }}
          className="inline-flex items-center justify-center gap-2 px-5 py-2.5 font-medium text-sm transition-all hover:brightness-150"
          style={{
            background: "var(--surface-1)",
            color: "color-mix(in oklab, var(--fg-strong) 70%, transparent)",
          }}
        >
          Documentation
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h14" />
            <path d="m12 5 7 7-7 7" />
          </svg>
        </Link>
        <a
          href={repositoryUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-2 px-5 py-2.5 font-medium text-sm transition-all hover:brightness-150"
          style={{
            background: "var(--surface-1)",
            color: "color-mix(in oklab, var(--fg-strong) 70%, transparent)",
          }}
        >
          {githubIcon}
          GitHub
        </a>
      </nav>
    </section>
  );
}
