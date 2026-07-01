export function HomePrivacy() {
  return (
    <section className="w-full max-w-3xl px-6 pb-16">
      <div
        className="relative overflow-hidden rounded-xl p-6"
        style={{
          background:
            "linear-gradient(135deg, color-mix(in oklab, var(--brand-success) 35%, transparent) 0%, var(--surface-1) 100%)",
          border: "1px solid color-mix(in oklab, var(--brand-success) 20%, transparent)",
        }}
      >
        <div className="flex items-start gap-4">
          <div
            className="mt-0.5 shrink-0 rounded-lg p-2.5"
            style={{
              background: "color-mix(in oklab, var(--brand-success) 12%, transparent)",
              color: "color-mix(in oklab, var(--brand-success) 90%, transparent)",
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
              <path d="m9 12 2 2 4-4" />
            </svg>
          </div>
          <div>
            <h3
              className="mb-1.5 font-semibold text-sm"
              style={{ color: "color-mix(in oklab, var(--brand-success) 95%, transparent)" }}
            >
              Your voice stays on your machine
            </h3>
            <p
              className="text-sm leading-relaxed"
              style={{ color: "color-mix(in oklab, var(--fg-strong) 45%, transparent)" }}
            >
              Transcription runs entirely on your local hardware. Audio is
              processed in-memory by on-device AI models and never written to
              disk or sent anywhere - no usage analytics. Optional LLM cleanup
              is local (Ollama) unless you opt into OpenRouter. Anonymized crash
              reports are opt-out. You own your data.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
