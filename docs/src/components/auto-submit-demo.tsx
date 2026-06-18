/**
 * Auto-submit-after-paste demo.
 *
 * An always-looping mini chat window that shows the whole auto-submit cycle:
 * a dictated message streams into the message field, then WinSTT presses Enter
 * and the message sends on its own — landing as an outgoing bubble in the
 * thread while the field clears.
 *
 * CSS-only motion (keyframes `as-*` in `docs-ui.css`), transform/opacity, gated
 * by `prefers-reduced-motion` (the static fallback is the just-sent state).
 * Registered in `mdx.tsx` as `<AutoSubmitDemo />`.
 */

import type { ReactNode } from "react";
import { VoiceBars } from "@/components/feature-showcases";

export function AutoSubmitDemo({ caption }: { caption?: ReactNode }) {
  return (
    <figure className="as-fig not-prose">
      <div
        className="as-card"
        aria-label="Auto-submit after paste — a dictated message streams into a chat field, then WinSTT presses Enter and the message sends on its own."
      >
        <div className="as-chat" aria-hidden="true">
          <div className="as-chat-head">
            <span className="as-avatar" />
            <span className="as-chat-name">Team chat</span>
            <span className="as-chat-meta">#general</span>
          </div>

          <div className="as-thread">
            <span className="as-msg as-msg--in">Are we still on for 3pm?</span>
            <span className="as-msg as-msg--out">
              Sounds good — see you at 3.
              <span className="as-check">
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </span>
            </span>
          </div>

          <div className="as-inputbar">
            <div className="as-input">
              <span className="as-ph">Message #general…</span>
              <span className="as-typed">
                Sounds good — see you at 3.
                <span className="as-caret" />
              </span>
              <span className="as-mic">
                <span className="as-mic-dot" />
                <span className="as-mic-bars">
                  <VoiceBars
                    count={9}
                    width={1.7}
                    gap={1.7}
                    color="var(--brand-accent)"
                  />
                </span>
              </span>
            </div>
            <span className="as-send">
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
                <path d="m21.854 2.147-10.94 10.939" />
              </svg>
            </span>
            <span className="as-enter">
              Enter
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m9 10-5 5 5 5" />
                <path d="M20 4v7a4 4 0 0 1-4 4H4" />
              </svg>
            </span>
          </div>
        </div>
      </div>
      {caption ? <figcaption className="shot-cap">{caption}</figcaption> : null}
    </figure>
  );
}
