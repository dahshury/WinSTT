<!--
Thanks for sending a PR! Please fill in BOTH sections below.
The template mirrors the one Handy uses (examples/Handy/.github/PULL_REQUEST_TEMPLATE.md)
because it works: reviewers get the human "why" + the AI-assistance disclosure in one place,
and the Community Feedback link makes the case for the change visible to everyone.

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

- [ ] Code change has tests (server: pytest 100 % coverage; frontend: bun test / property tests where it makes sense; e2e via Playwright for UI flows).
- [ ] `make` passes in `server/` (format + lint + mypy + pytest).
- [ ] `bun typecheck && bun lint && bun test` pass in `frontend/`.
- [ ] If the WebSocket contract or settings schema changed: `spec/openapi.yaml` edited first, then `bun --cwd frontend run generate`.
- [ ] If shared types changed: Python `domain/` models updated to match the new schema.
- [ ] FSD layer/import contract preserved (`bun check:fsd` clean).
- [ ] No new `useMemo` / `useCallback` (React Compiler memoizes for us; see AGENTS.md §3).
- [ ] No new `electron` import outside `electron/preload.ts`.
- [ ] User-facing strings wrapped in `t()` / `use-intl`; new keys added to every locale in `frontend/messages/`.

## AI Assistance Disclosure

<!--
Required. Pick one. If you used multiple tools, list them.
This is not judgement — it's transparency so reviewers can calibrate.
-->

- [ ] No AI tools were used to write this PR.
- [ ] AI tools were used: <!-- e.g. Claude Code, Cursor, Copilot --> for <!-- scope: boilerplate / debugging help / most of the code -->.

## Screenshots / recordings (UI changes)

<!-- Drop a screen recording or before/after screenshots here for any renderer change. -->
