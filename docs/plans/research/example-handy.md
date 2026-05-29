# Example study — Handy (examples/Handy)

PRIMARY reference. Cross-platform (Tauri/Rust) open-source local STT; WinSTT borrowed many
settings, the overlay, and the recording-mode model from it. Studied `README.md` +
`AGENTS.md`/`BUILD.md`/`CONTRIBUTING.md` (no separate docs site in-repo; the marketing site
is the external handy.computer).

## Information architecture (README)
Title + Discord badge → one-line pitch → **Why Handy?** (value bullets) → **How It Works**
(numbered + local-pipeline explainer) → **Quick Start** (install methods w/ badges →
launch → permissions → shortcuts) → **Integrations** (Raycast) → **Architecture** (library
list) → **Debug Mode** + **CLI Parameters** → **Known Issues & Current Limitations**
(transparent, "Help Wanted").

## Stealable patterns
1. **Four-word value pillars** — "Free / Open Source / Private / Simple", each one line.
   WinSTT's "Why WinSTT" already mirrors this; keep it tight.
2. **Positioning line** — "not trying to be the best… the most forkable." A single sharp
   sentence that frames the project. WinSTT's equivalent = "local-first, 40+ models".
3. **Radical transparency** — a "Known Issues & Current Limitations… we believe in
   transparency" section with "Help Wanted" tags. WinSTT already has Known Issues; the
   "Help Wanted" framing is worth borrowing in CONTRIBUTING/Discussions.
4. **Install via package managers** — Homebrew/winget badges. WinSTT is Windows-portable
   only today; note winget as a roadmap item if desired.
5. **CLI parameters documented inline** with copy-paste blocks + a platform tip blockquote.
   WinSTT's `cli.mdx` covers the server; Handy documents *app* remote-control flags too.
6. **Integrations/community** section (Raycast) — signals an ecosystem. WinSTT has none yet
   → a Contributing/Discussions card is the cheap stand-in.

## To avoid
- No screenshots in Handy's README (relies on the external site) — WinSTT is *more* visual,
  which is a genuine advantage to lean into.
- No comparison table — every Handy-adjacent competitor (voicetypr, openwhispr, Wispr Flow)
  uses one; its absence is the clearest shared gap. WinSTT should add one.

## Net for WinSTT
WinSTT docs already exceed Handy's on visuals, settings depth, and structure. The two
borrow-worthy gaps: (a) a **competitor comparison table**, (b) the **economic ("free vs
cloud subscription")** angle alongside the privacy angle.
