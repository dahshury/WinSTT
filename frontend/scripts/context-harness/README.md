# Context-awareness harness

Automates the "focus a real app's reply field → capture exactly what dictation's
context-awareness sees → screenshot → judge → fix `ax-prune.ts` → repeat" loop,
so we stop hand-copying the playground JSON.

It drives **your already-logged-in Chrome** over the Chrome DevTools Protocol
(CDP), seats the caret in each app's compose/reply field, and runs the **same
native UIA helper dictation uses** (`winstt-context.exe --tree` / `--selection`).
Per app it writes a screenshot plus the exact snapshot + LLM/ASR prompt strings.

Why CDP-to-real-Chrome (not a Playwright-launched browser): real sessions, no
re-login, dodges Google/Discord bot-detection, and captures the EXACT a11y tree
dictation sees. See `memory/reference_stt_context_awareness_field_survey.md`.

## One-time setup per run

1. **Fully quit Chrome** (check the tray — no lingering process).
2. Relaunch with remote debugging, reusing your real profile so you stay
   logged in everywhere (PowerShell):

   ```powershell
   & "C:\Program Files\Google\Chrome\Application\chrome.exe" `
     --remote-debugging-port=9222 `
     --user-data-dir="$env:LOCALAPPDATA\Google\Chrome\User Data"
   ```

3. Be logged into the apps you'll test; have a Discord channel/DM open.

## Run

```bash
bun run context:harness            # all registered apps (sequential)
bun run context:harness gmail      # just Gmail
bun run context:harness gmail discord
CDP_PORT=9333 bun run context:harness   # non-default port
```

Capture is **sequential** by design — only one OS window can be foreground at a
time, and the helper reads the foreground window. Analysis afterward can fan out
across agents in parallel.

## Output (`out/`, gitignored)

```
out/
  summary.json            # per-app: foregroundOk, focusError, char counts, ...
  gmail/
    screenshot.png        # what was on screen at capture
    rawSnapshot.json      # the WindowContextSnapshot (windowTitle, axHtml, ...)
    promptFragment.txt    # EXACT text formatContextForPrompt() feeds the LLM
    asrPromptTail.txt     # EXACT Whisper initial_prompt bias tail
    prunedTree.txt        # Tier-3 pruneAxHtmlForLlm() output ("" if it declined)
  discord/ ...
```

`foregroundOk: false` in the summary means `bringToFront` lost the race to
another OS window — the capture is of the wrong window; just re-run that app.

`focusError` non-null means the per-app `focus()` recipe in `apps.ts` couldn't
find the compose field (app layout changed, or you weren't in the expected
state). The capture still ran, so you can see what we get without focus — then
fix the selector in `apps.ts`.

## The iteration loop

1. Run the harness → artifacts in `out/`.
2. For each app, compare `screenshot.png` (truth) against `promptFragment.txt`
   (what the LLM gets): did we keep the reply target + thread and drop the
   chrome/inbox/nav?
3. Fix the global pruner in `electron/lib/ax-prune.ts` (NOT per-app parsers).
4. Capture the corrected snapshot as a regression fixture in
   `electron/lib/context-app-fixtures.ts`.
5. Re-run; repeat until the fragment is clean.

## Adding an app

Add an entry to `HARNESS_APPS` in `apps.ts`: `id`, `label`, `url`,
`expectWindowTitleIncludes`, and a `focus(page)` that leaves the caret in the
compose field. Prefer role/aria selectors; tolerate "already focused".

## Limits (current phase)

- **Web only** (Playwright/CDP). Native desktop apps (desktop Slack/Discord/
  Teams, VS Code, OneNote) need a separate Windows-UIA driver — a later phase.
- **Sequential capture** (foreground constraint). True parallel capture would
  need an `--hwnd` window-target flag added to `winstt-context.exe`.
- **Clipboard** here is read via PowerShell `Get-Clipboard` (the relay uses
  electron's clipboard, unavailable in a plain script). It's the lowest-signal
  field and not what we're tuning.
