/**
 * Visual mock of the WinSTT desktop app. Frameless 420×150 window matching
 * the real `mainWindow` (see `frontend/electron/main.ts` createWindow) and
 * the real `MainPage` layout — `AudioDisplay` (centered bar visualizer)
 * over the footer `StatusBar` (connection dot + hotkey + device + model).
 * Non-functional — purely decorative for docs/landing page.
 */

// 9 bars matches the real AudioVisualizerBar default (size="md", barCount
// resolved to 9). Sway delays are staggered so the row reads like a live
// sequenced waveform rather than a synced pulse.
const BAR_COUNT = 9;
const BAR_BASE_HEIGHT_PX = 80;
const BAR_SWAY_DELAY_MS = (i: number): number => i * 110;

function MicIcon() {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}

function ModelIcon() {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0Z" />
      <path d="M12 3a14 14 0 0 1 0 18" />
      <path d="M12 3a14 14 0 0 0 0 18" />
      <path d="M3 12h18" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg
      width="7"
      height="7"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ opacity: 0.55 }}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function AppMock() {
  return (
    <div
      className="relative mx-auto select-none overflow-hidden rounded-lg"
      style={{
        // Match the real Electron mainWindow: 420×150, frameless, #09090b.
        width: "min(100%, 420px)",
        aspectRatio: "14 / 5",
        background: "#09090b",
        border: "1px solid var(--border)",
        boxShadow:
          "0 0 0 1px hsla(0,0%,0%,0.6), 0 25px 70px -12px hsla(0,0%,0%,0.7), 0 0 60px oklch(62% 0.19 260 / 0.05)",
        fontFamily: '"Geist", system-ui, -apple-system, sans-serif',
      }}
    >
      {/* ── AudioDisplay region ── */}
      <div
        className="absolute"
        style={{ top: 6, right: 6, left: 6, bottom: 28 }}
      >
        <div
          className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-md"
          style={{
            background: "oklch(9.5% 0.015 265)",
            border: "1px solid oklch(94% 0.015 265 / 0.04)",
          }}
        >
          {/* Faint accent glow behind the bars */}
          <div
            className="mock-glow-pulse pointer-events-none absolute"
            style={{
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              width: 220,
              height: 80,
              borderRadius: "50%",
              background:
                "radial-gradient(ellipse, oklch(62% 0.19 260 / 0.18) 0%, transparent 70%)",
              filter: "blur(14px)",
            }}
          />

          {/* Bar visualizer — mirrors AudioVisualizerBar size="md" (9 bars,
              16px wide, 8px gap) with per-bar staggered sway delays. */}
          <div
            className="relative flex items-center justify-center"
            style={{ gap: 8 }}
          >
            {Array.from({ length: BAR_COUNT }, (_, i) => i).map((i) => (
              <div
                key={`bar-${i}`}
                className="mock-bar rounded-full"
                style={{
                  width: 16,
                  height: BAR_BASE_HEIGHT_PX,
                  background: "var(--brand-accent)",
                  animationDelay: `${BAR_SWAY_DELAY_MS(i)}ms`,
                }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* ── StatusBar footer ── */}
      <div
        className="absolute right-0 bottom-0 left-0 flex items-center justify-between"
        style={{
          height: 28,
          background: "oklch(9.5% 0.015 265)",
          borderTop: "1px solid var(--border)",
          padding: "0 8px",
          fontFamily: '"Geist Mono", ui-monospace, monospace',
          fontSize: 10,
        }}
      >
        {/* Left — ConnectionIndicator (green dot) */}
        <span
          className="mock-status-pulse rounded-full"
          style={{
            width: 6,
            height: 6,
            background: "#22c55e",
            boxShadow: "0 0 6px #22c55e",
          }}
          aria-hidden="true"
        />

        {/* Right — hotkey chip · device chip · model chip */}
        <div className="flex items-center gap-1.5">
          <span
            className="rounded-xs"
            style={{
              padding: "1px 5px",
              background: "oklch(62% 0.19 260 / 0.1)",
              border: "1px solid oklch(62% 0.19 260 / 0.2)",
              color: "oklch(76% 0.14 260 / 0.95)",
              fontSize: 9,
              fontWeight: 500,
            }}
          >
            Ctrl+Space
          </span>

          <span
            aria-hidden="true"
            style={{
              width: 1,
              height: 10,
              background: "oklch(94% 0.015 265 / 0.12)",
            }}
          />

          <span
            className="flex items-center gap-1"
            style={{ color: "oklch(94% 0.015 265 / 0.5)" }}
          >
            <MicIcon />
            Default
            <Chevron />
          </span>

          <span
            aria-hidden="true"
            style={{
              width: 1,
              height: 10,
              background: "oklch(94% 0.015 265 / 0.12)",
            }}
          />

          <span
            className="flex items-center gap-1"
            style={{ color: "oklch(94% 0.015 265 / 0.5)" }}
          >
            <ModelIcon />
            large-v3-turbo
            <Chevron />
          </span>
        </div>
      </div>
    </div>
  );
}
