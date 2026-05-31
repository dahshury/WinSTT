# WinSTT docs — MDX component contract

All components below are **registered globally** (see `docs/src/components/mdx.tsx`) — use
them in any `.mdx` page **without imports**. They consume the live app palette and are
styled in `docs/src/styles/docs-ui.css`. fumadocs' `Cards`/`Card`/`Tabs`/code-blocks are
also available globally.

> Author MDX the way `docs/content/docs/settings/model.mdx` and `index.mdx` do (read them
> first — they are the canonical examples). Match that depth and structure.

## Screenshot
Frame a PNG from `docs/public/screenshots/` in desktop-window chrome.
```mdx
<Screenshot src="settings-audio" alt="Required descriptive alt text." label="Settings — Audio" caption="Optional one-liner." />
```
- `src` — file **stem** (no extension, no path); resolves to `/screenshots/<stem>.png`.
- `alt` — **required**, descriptive.
- `chrome` — `"window"` (default, traffic-light titlebar), `"card"` (frame only — use for section/overlay/pill crops), `"none"`.
- `label` — window-title text shown in the chrome bar. `caption` — caption under the image.
- `maxWidth` — px cap for small images (e.g. overlay pills: `maxWidth={520}`).

## Callout
```mdx
<Callout type="info" title="Optional title">Body…</Callout>
```
- `type`: `"info"` (tips), `"warn"` (gotchas / STARTUP_ONLY / mutual-exclusion), `"error"` (destructive, no-undo), `"restart"` (needs a restart — auto-titled "Requires a restart"), `"success"` (privacy / verified).

## SettingRow — one setting in a reference list
```mdx
<SettingRow label="Silero Sensitivity" settingKey="audio.sileroSensitivity" default="0.7" startupOnly>
  What it does… options/range… gotcha.
</SettingRow>
```
- `startupOnly` → "Restart server" pill; `restart` → "Restart" pill.

## ModelTable — consistent reference table
```mdx
<ModelTable
  head={["Model", "Params", "WER", "Languages"]}
  numeric={[1, 2]}
  rows={[["Whisper Tiny", "38M", "24.5", "99"], ["Parakeet TDT v3", "627M", "6.0", "25"]]}
  caption="Optional footnote."
/>
```
`numeric` = column indexes to right-align as monospace tabular numbers. Cells are strings or JSX. For very large/simple tables a plain markdown table is fine too (fumadocs styles it).

## BentoGrid / BentoCell / FeatureCard — feature & choice grids
```mdx
<BentoGrid cols={3}>
  <BentoCell span={2} icon="mic" title="Title" href="/docs/...">Body sentence.</BentoCell>
  <BentoCell icon="brain" title="Title">No-href cell (not clickable).</BentoCell>
</BentoGrid>
```
- `cols`: 2|3|4. `span`: 1|2|3 (asymmetry — avoid 3 equal cells in a row). `href` optional (adds hover arrow).
- `icon` (string name): `mic waveform realtime brain llm tts volume file dictionary snippets transform history compute cpu languages privacy shield keyboard hotkey sparkles cloud integrations wakeword pipeline speed quality`.
- `FeatureCard` is a 1-span `BentoCell` alias.

## ModeBadge — recording-mode pill (colors match the app)
```mdx
<ModeBadge mode="ptt" /> <ModeBadge mode="toggle" /> <ModeBadge mode="listen" /> <ModeBadge mode="wakeword" />
```

## Kbd / Combo / ShortcutLegend — keyboard chips
```mdx
Press <Combo keys="LCtrl+LMeta" /> to start. A single key: <Kbd>Esc</Kbd>.

<ShortcutLegend rows={[
  { action: "Push-to-talk", keys: "LCtrl+LMeta", note: "Hold to record." },
  { action: "Re-paste last", keys: "LCtrl+LShift+V" },
]} />
```

## StepFlow / Step — numbered procedure (auto-numbered)
```mdx
<StepFlow>
  <Step title="Download the installer">Body — supports markdown/JSX.</Step>
  <Step title="Launch & onboard"><Screenshot src="onboarding" alt="…" /></Step>
</StepFlow>
```

## StatGrid / Stat — numeric highlights
```mdx
<StatGrid><Stat value="85 ms" label="DirectML p50" /><Stat value="40+" label="models" /></StatGrid>
```

## AppMock — animated main-window mock (hero only; no props).

---

## Available screenshot stems (in `docs/public/screenshots/`)
`main` · `tray-menu` · `onboarding` · `device-picker` ·
`settings-general` · `settings-general-listen` · `settings-general-wakeword` ·
`settings-model` · `model-dropdown` · `section-realtime` · `section-llm` · `section-tts` ·
`settings-audio` · `settings-quality` · `settings-dictionary` · `settings-snippets` ·
`settings-history` · `settings-integrations` · `settings-about` ·
`overlay-floating` · `overlay-dynamic-island` (use `chrome="card"` + `maxWidth={560}`) ·
`visualizer-bar` · `visualizer-grid` · `visualizer-radial` · `visualizer-wave` · `visualizer-aura`

## Frontmatter (every page)
```
---
title: Short Title
description: One sentence — used for SEO, OG, and the sub-title.
---
```
Do **not** start the body with an `# H1` (the title renders automatically). Lead with a
one-sentence hero line, then a `<Screenshot>`, then concept → controls → callouts → related `<Cards>`.

## Voice
Plain-spoken, second person, numbers over adjectives, no hype. Match the app's exact
labels. End pages with related `<Cards>`. See `_STYLE.md`.
