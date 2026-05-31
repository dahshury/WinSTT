# WinSTT Docs — Style Guide

> Distilled from `example-*.md` (epicenter, openwhispr, thewhisper, voicetypr, whisper.cpp) +
> the live theme in `docs/src/styles/app.css` + `12-principles-of-animation` and
> `web-interface-guidelines`. This governs voice, layout patterns, and the reusable MDX components
> to build for `docs/content/docs/`.

## 1. Voice & tone

- **Plain-spoken, technical-but-approachable** (thewhisper / epicenter). Explain *what* before *how*;
  explain the *benefit* before the *mechanism*.
- **Anti-jargon, anti-hype.** No "revolutionary / cutting-edge / blazing-fast". Let numbers speak
  (DirectML p50=85 ms vs CUDA p50=120 ms). Ban superlatives without data (openwhispr §6, whisper.cpp §6).
- **Privacy threaded throughout** (openwhispr §7) — "audio never leaves your machine" stated in the
  hero, repeated where cloud/LLM features could imply otherwise.
- **Honest about limits & gotchas** (voicetypr blockquotes). Surface STARTUP_ONLY, restart-required,
  and mutual-exclusion rules as callouts, not buried prose.
- **Imperative, second person** for tasks ("Press the hotkey, speak, release."). Use contractions.
- **Consistent terminology** — match the app's labels exactly (e.g. "Push-to-Talk", "Smart Endpoint",
  "Recording Overlay"). One name per concept across README + docs (epicenter anti-pattern #4).
- **Every section ends with an action or a `→` link** (epicenter progressive disclosure).

## 2. Page structure pattern (the template)

1. Frontmatter `title` + one-line `description`.
2. **Hero line** — what this page lets you do, in one sentence.
3. **`<Screenshot>`** of the relevant UI (framed in window chrome) — show before tell (thewhisper §5.3).
4. **Concept** — 1–2 short paragraphs.
5. **Controls / steps** — `StepFlow` for procedures, `ModelTable` for reference, `FeatureCard`/
   `BentoGrid` for options.
6. **Callouts** for gotchas (restart-required, mutual-exclusion, conditional visibility).
7. **`→` cards** to related pages.

Match depth across sibling pages (fix voicetypr's uneven-depth anti-pattern). Reference pages
(settings/*) are table-heavy + 1 screenshot; usage pages (dictation, quick-start) are step-heavy.

## 3. Color palette (already in `app.css` — reuse, don't reinvent)

Blue-tinted dark OKLch substrate (hue ~260–265). Accent = Docker Blue, matching the app.

| Token | Value | Use |
|---|---|---|
| `--brand-accent` | `oklch(62% 0.19 260)` | primary accent, links, active states, bar viz |
| `--brand-accent-hover` | `oklch(70% 0.155 255)` | hover |
| `--brand-accent-soft` | `oklch(62% 0.19 260 / 0.08)` | tinted fills, chip bg |
| `--brand-accent-glow` | `oklch(62% 0.19 260 / 0.15)` | card hover glow |
| `--brand-teal` | `oklch(71% 0.13 245)` | heatmap / secondary data |
| `--brand-success` | `oklch(68% 0.17 150)` | connection dot, "verified" pills |
| `--surface-0..4` | `oklch(7.5%→20% 0.015 265)` | elevation scale (0 = page bg) |
| `--fg-strong..dim` | `oklch(94%→38%)` blue-tinted whites | text hierarchy |
| `--border` / `--divider` | `oklch(19% …)` / `… /0.08` | borders, hairlines |

**Recording-mode accent chips** (from `inventory-hotkeys`, `shared/config/recording-mode-color.ts`):
PTT `#3b82f6`, Toggle `#facc15`, Listen `#22c55e`, Wakeword `#f97316`. Use these for mode badges so
docs match the app's mode coloring exactly.

Rules: never hardcode hex except the four mode colors; always go through `var(--*)`. Card surfaces use
`--surface-1`, in-card lifts use `--surface-2/3` (mirrors the app's surface-elevation convention).

## 4. Visual element rules

- **Screenshots:** always inside the `<Screenshot>` window-chrome frame; one per concept; add a
  `caption`. Prefer real UI over mockups, except the hero may use the animated `AppMock`. Keep PNGs
  in `docs/public/screenshots/`; reference by stem (`src="settings-model"`).
- **Callouts:** map type → meaning. `info` (tips/getting-started), `warn` (restart-required,
  STARTUP_ONLY, "removing the key breaks transcription"), `error`/danger (destructive: clear-all,
  reset-to-defaults — "no undo"). Keep to one idea each.
- **Tables:** the default for catalogs, defaults, quantizations, conditional visibility, restart
  matrices. Columns: control | what it does | default | gotcha. Use `ModelTable` for model/quant data
  so columns stay consistent site-wide.
- **Cards / BentoGrid:** feature overviews and "pick one of N" choices (recording modes, visualizer
  types, settings tabs). Each card = icon + bold title + 1 benefit sentence + `href`.
- **Kbd chips:** every hotkey rendered as `<Kbd>` chips (`Ctrl` `+` `Space`), accent-tinted like the
  AppMock hotkey chip. Build a `ShortcutLegend` from rows of these for the hotkey page.
- **Code blocks:** copy-paste-ready (whisper.cpp pattern) for CLI/dev-setup. Language-tagged.
- **Diagrams:** ASCII over SVG for architecture/pipelines (epicenter §3); or a numbered `StepFlow`
  for the VAD pipeline and dictation loop.

## 5. Animation & interaction (high-level)

Follow **12 Principles of Animation** + **web-interface-guidelines** at a light touch — docs are
read, not played with:

- **Slow in / slow out (easing):** all transitions `cubic-bezier(0.4, 0, 0.2, 1)`, matching the
  existing `.feature-card` + `.mock-bar` easing.
- **Staggering / follow-through:** AppMock bars already stagger (`animationDelay i*110ms`) — reuse for
  any reveal-on-scroll grid.
- **Appeal + secondary action:** card hover lifts border to `accent/0.25` + soft glow
  (`.feature-card:hover`) — keep this as the canonical hover.
- **Respect `prefers-reduced-motion`:** gate all looping animations (AppMock pulse, bar sway) so they
  freeze for users who opt out.
- **No layout shift, generous hit targets, visible focus rings** (`--color-fd-ring`) — web-interface
  guidelines baseline. Don't animate anything load-bearing for reading.
- **Subtle, not decorative.** Motion signals state (connection pulse = success) or guides the eye
  (staggered grid reveal); never gratuitous.

## 6. Reusable MDX components to build

Register these in `docs/src/components/` and expose via `getMDXComponents` in `mdx.tsx`. All consume
the `var(--brand-*)` / `var(--surface-*)` tokens.

| Component | Purpose | Prop sketch |
|---|---|---|
| **`Screenshot`** | Frame a PNG in WinSTT window chrome (titlebar dots, blue glow shadow like AppMock). | `{ src: string; alt: string; caption?: string; chrome?: "window" \| "pill" \| "none"; width?: number }` — resolves `src` against `/screenshots/`. |
| **`Hero`** | Landing hero: pitch + badges + CTA + slot for `AppMock`/`main`. | `{ title; tagline; badges?: {label;href;color}[]; cta?: {label;href}[]; children }` |
| **`BentoGrid`** + **`BentoCell`** | Asymmetric feature grid (index, settings/index, visualizer gallery). | grid: `{ cols?: 2\|3 }`; cell: `{ span?: 1\|2; title; icon?; href?; children }` |
| **`FeatureCard`** | Single linked card; reuse `.feature-card` hover glow. | `{ title; icon?; href?; accent?: string; children }` |
| **`ModelTable`** | Consistent catalog/quantization/defaults table with sticky header + monospace numerics. | `{ columns: {key;label;align?}[]; rows: Record<string,ReactNode>[]; dense?: boolean }` |
| **`Kbd`** | Single key chip (accent-tinted, like the AppMock hotkey chip). | `{ children }` — compose `<Kbd>Ctrl</Kbd> + <Kbd>Space</Kbd>` |
| **`ShortcutLegend`** | Table of action ↔ `Kbd` combo rows for the hotkey page. | `{ rows: {action; keys: string[]; note?}[] }` |
| **`StepFlow`** + **`Step`** | Numbered procedure (quick-start, VAD pipeline, dictation loop) with connecting rail + slow-in/out reveal. | flow: `{ children }`; step: `{ n?; title; screenshot?; children }` |
| **`ModeBadge`** | Recording-mode pill using the 4 canonical mode colors. | `{ mode: "ptt"\|"toggle"\|"listen"\|"wakeword" }` |
| **`SettingRow`** | Compact reference row for a single setting (label, key, default, restart/startup badge). | `{ label; settingKey; default?; restart?: boolean; startupOnly?: boolean; children }` |
| **`Callout`** (extend fumadocs) | Add a `restart`/`startup` variant + icon for the recurring gotcha class. | `{ type: "info"\|"warn"\|"error"\|"restart"; title?; children }` |

Existing assets to reuse as-is: **`AppMock`** (hero animation), the `.feature-card`, `.mock-*`,
`@keyframes` already in `app.css`, and fumadocs' built-in `Cards`/`Card`/`Callout`/`Tabs` where a
custom component isn't warranted.

## 7. Do / Don't quick reference

**Do:** lead with a framed screenshot · tables for any catalog · callouts for restart/startup/mutual-
exclusion gotchas · `→` cards at section ends · match the app's exact labels · numbers over adjectives ·
respect reduced-motion.

**Don't:** hardcode colors (except the 4 mode hexes) · use hype words · embed full API/architecture
in usage pages · let depth drift between sibling pages · ship dead/"coming soon" links (thewhisper §6.5) ·
animate anything required for reading.
