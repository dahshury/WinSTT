# WinSTT Docs

This folder contains the TanStack Start + Fumadocs documentation site for
WinSTT.

## Run Locally

From the repository root:

```powershell
bun run docs:dev
bun run docs:build
bun run docs:videos
```

Or from this folder:

```powershell
bun run dev
bun run build
```

The development server defaults to Vite's local URL. The root `docs:dev` script
is the preferred entry point when working from the main WinSTT checkout.

## Content Layout

| Path | Purpose |
| --- | --- |
| `content/docs/` | MDX pages and sidebar metadata |
| `public/screenshots/` | Static screenshots used by README and docs pages |
| `public/demos/` | Short looping WebM clips used by docs media components |
| `../tools/remotion-demos/` | Remotion compositions that render docs demo clips |
| `src/components/docs-ui.tsx` | Shared MDX components such as `Screenshot`, `Video`, and `MediaGrid` |
| `src/styles/docs-ui.css` | Shared media, card, table, callout, and docs component styling |
| `src/routes/docs.$.tsx` | TanStack route that renders Fumadocs pages |

## Media Guidelines

- Use `Screenshot` for PNG/WebP assets in `public/screenshots`.
- Use `Video` for WebM clips in `public/demos`.
- Use `MediaGrid` for side-by-side media so captions, spacing, and mobile
  stacking stay consistent.
- Prefer `variant="panel"` for tall settings windows, `variant="section"` for
  narrow settings sections, `variant="strip"` for overlay bars, and
  `variant="thumb"` for gallery cards.
- Regenerate demo clips from the repository root with `bun run docs:videos`.
- README media should be static PNGs, not WebM, because repository viewers do
  not render videos consistently.
