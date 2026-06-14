/**
 * Read-aloud (TTS) process showcase — a clear three-step pipeline that shows
 * exactly what happens: text is SELECTED in any app, captured and synthesized
 * on-device by Kokoro-82M, and played back through your output device. Replaces
 * the old vague clip that only showed "a small text". The output waveform is the
 * live `VoiceBars` visualizer (shared with the landing showcases).
 */

import { VoiceBars } from "./feature-showcases";

function Arrow({ label }: { label?: string }) {
  return (
    <div className="tts-arrow" aria-hidden="true">
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M5 12h14" />
        <path d="m13 6 6 6-6 6" />
      </svg>
      {label ? <span className="tts-arrow-cap">{label}</span> : null}
    </div>
  );
}

export function ShowcaseReadAloud() {
  return (
    <figure className="shot not-prose my-7">
      <div
        className="shot-frame showcase-frame"
        role="img"
        aria-label="How read-aloud works: select text, synthesize on-device, play through your output device"
      >
        <div className="shot-bar" aria-hidden="true">
          <span className="shot-dot shot-dot--r" />
          <span className="shot-dot shot-dot--y" />
          <span className="shot-dot shot-dot--g" />
          <span className="shot-title">WinSTT — Read Aloud</span>
          <span className="showcase-bar-tag showcase-bar-tag--teal">
            100% on-device
          </span>
        </div>

        <div className="showcase-stage tts-stage">
          <div className="tts-flow">
            {/* Step 1 — selected text in any app */}
            <div className="tts-step">
              <div className="tts-doc">
                <div className="tts-doc-bar">
                  <span className="sc-traffic" />
                  <span className="sc-traffic" />
                  <span className="sc-traffic" />
                  <span className="tts-doc-name">report.txt</span>
                </div>
                <p className="tts-doc-text">
                  The quarterly numbers are in —{" "}
                  <span className="tts-sel">
                    revenue is up 18% and churn fell
                  </span>
                  .
                </p>
              </div>
              <span className="tts-cap">
                <span className="tts-cap-n">1</span> Select text in any app,
                press your hotkey
              </span>
            </div>

            <Arrow label="captures the selection" />

            {/* Step 2 — synthesized on-device */}
            <div className="tts-step">
              <div className="tts-synth">
                <span className="tts-synth-ico">
                  <svg
                    width="22"
                    height="22"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M2 12h2l3-8 4 16 3-10 2 2h6" />
                  </svg>
                </span>
                <div className="tts-synth-name">Kokoro-82M</div>
                <div className="tts-voice">
                  <span className="sc-lang sc-lang--on">US</span>
                  Heart
                </div>
              </div>
              <span className="tts-cap">
                <span className="tts-cap-n">2</span> Synthesized on your machine
                — no cloud
              </span>
            </div>

            <Arrow label="plays the audio" />

            {/* Step 3 — plays through the output device */}
            <div className="tts-step">
              <div className="tts-out">
                <span className="tts-out-ico">
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M11 4.7 7.6 8H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h3.6L11 19.3a1 1 0 0 0 1.7-.7V5.4a1 1 0 0 0-1.7-.7Z" />
                    <path d="M16 9a5 5 0 0 1 0 6" />
                    <path d="M19.4 6a10 10 0 0 1 0 12" />
                  </svg>
                </span>
                <div className="tts-out-wave">
                  <VoiceBars
                    count={22}
                    width={2.5}
                    gap={2}
                    color="var(--brand-teal)"
                  />
                </div>
                <div className="tts-out-dev">Speakers (default)</div>
              </div>
              <span className="tts-cap">
                <span className="tts-cap-n">3</span> Plays through your output
                device
              </span>
            </div>
          </div>
        </div>
      </div>
      <figcaption className="shot-cap">
        Highlight text in any app, press your read-aloud hotkey, and WinSTT
        speaks it back — captured, synthesized, and played entirely on your
        device.
      </figcaption>
    </figure>
  );
}
