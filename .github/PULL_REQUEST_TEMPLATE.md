<!--
Thanks for sending a PR! Please fill in BOTH sections below.
Reviewers get the human "why" + the AI-assistance disclosure in one place, and the
Community Feedback link makes the case for the change visible to everyone.

If you're an AI coding assistant landing this PR on behalf of a human:
DO NOT remove these sections. Fill them in honestly. Reviewers prioritise PRs
that match this template.
-->

## Human-Written Description

<!--
Write this section yourself, even if the code was AI-assisted.

Tell us:
- What user-facing problem this solves (or what internal cleanup it does).
- Why this approach over alternatives — one or two sentences.
- Any architectural or compatibility implications reviewers should know about.
- Test plan: how did you verify this works? Manual steps, automated checks, both?

If this is a refactor or test-only PR, "no user-facing change; refactor for X reason" is fine.
-->



## Community Feedback

<!--
Link the GitHub Discussion or Issue this PR addresses.

- For features: a link to the Discussion where this was proposed and the
  shape was agreed. Features without prior discussion are usually closed
  with a polite "please open a Discussion first".
- For bug fixes: the Issue number being fixed (e.g. "Closes #123").
- For tiny / obvious fixes (typo, broken link, lint config): you can write
  "No prior discussion — small obvious fix."
-->



---

## Checklist

<!-- Mark with [x]. Empty boxes are fine — reviewers will help. -->

- [ ] Code change has tests (renderer: `bun test` / property tests where it makes sense; backend: Rust unit tests where it makes sense).
- [ ] Renderer gates pass: `bun run lint`, `bun run build` (tsgo + Vite), `bun test`, `bun run check:i18n`.
- [ ] Backend gates pass in `src-tauri/` (via `rust-migration\cargo-env.bat`): `cargo fmt -- --check`, `cargo clippy --all-targets -- -D warnings`, `cargo check`.
- [ ] If Tauri commands or shared types changed: `src/bindings.ts` regenerated (tauri-specta).
- [ ] FSD layer/import contract preserved.
- [ ] No new `useMemo` / `useCallback` (React Compiler memoizes for us).
- [ ] User-facing strings wrapped in `t()` / `use-intl`; new keys added to every locale in `messages/`.

## AI Assistance Disclosure

<!--
Required. Pick one. If you used multiple tools, list them.
This is not judgement — it's transparency so reviewers can calibrate.
-->

- [ ] No AI tools were used to write this PR.
- [ ] AI tools were used: <!-- e.g. Claude Code, Cursor, Copilot --> for <!-- scope: boilerplate / debugging help / most of the code -->.

## Screenshots / recordings (UI changes)

<!-- Drop a screen recording or before/after screenshots here for any renderer change. -->
