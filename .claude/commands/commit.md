### Role

You are a Git commit autopilot. Run all repository fixers/checks until clean before attempting any commit. Then inspect the staged diff, auto-generate a high-quality Conventional Commit message, and perform the commit.

### Context

- Repo root is the working directory.
- Git shell is non-interactive (Git Bash on Windows is available).
- The repo uses `simple-git-hooks` to run `node scripts/ci/pre-commit.mjs` on pre-commit. That hook runs in this order:
  0\) Security: `gitleaks protect --staged --redact`
  1. Markdown formatting (if any staged `*.md`): `uv run --with mdformat --with mdformat-gfm --with mdformat-frontmatter --with mdformat-ruff mdformat <markdownFiles>` then re-add only those markdown files
  2. Frontend TypeScript (if any staged under `app/frontend`): `bun -C app/frontend tsc --noEmit`
  3. Frontend lint: `bun -C app/frontend biome check --fix --unsafe --staged` then `bun -C app/frontend biome check --staged`
  4. Frontend unused code info: `bun -C app/frontend knip --no-config-hints` (non-blocking)
  - For Python files (outside `app/frontend`):
    1. `uv run ruff check --fix --unsafe-fixes <pythonFiles>`
    2. `uv run ruff format <pythonFiles>`
       - Then re-add formatted files
- If any blocking step fails (e.g., GitLeaks, TypeScript, Biome, Ruff), the hook exits non-zero and the commit fails.

### Inputs

- Commit message: automatically generated from the staged diff. If a user-provided message exists, prefer it; otherwise generate one.

### High-level algorithm

1. Ensure repo root. If no staged changes, stop and ask to stage files first.
2. Persist the originally staged file sets (null-delimited) to safely re-add only those files:
   - `frontend-staged.zlst`: `git diff --cached --name-only --diff-filter=ACMR -z | grep -z '^app/frontend/'`
   - `python-staged.zlst`: `git diff --cached --name-only --diff-filter=ACMR -z | grep -z -E '\\.py$' | grep -z -v '^app/frontend/'`
   - `markdown-staged.zlst`: `git diff --cached --name-only --diff-filter=ACMR -z | grep -z -E '\\.md$'`
3. Run fixers/checks BEFORE any commit, looping until clean or the max number of passes is reached (e.g., 3):
   - Markdown (if `markdown-staged.zlst` is non-empty):
     1. `uv run --with mdformat --with mdformat-gfm --with mdformat-frontmatter --with mdformat-ruff mdformat <markdownFiles>`
     2. Re-add ONLY the originally staged markdown files from `markdown-staged.zlst`
   - Frontend (if `frontend-staged.zlst` is non-empty):
     1. TypeScript check: `bun -C app/frontend tsc --noEmit`
     2. Biome fix: `bun -C app/frontend biome check --fix --unsafe --staged`
     3. Biome check: `bun -C app/frontend biome check --staged`
     4. Knip (informational): `bun -C app/frontend knip --no-config-hints` (do not block)
     5. Re-add ONLY the originally staged frontend files from `frontend-staged.zlst` in safe batches
   - Python (if `python-staged.zlst` is non-empty):
     1. `uv run ruff check --fix --unsafe-fixes <pythonFiles>`
     2. `uv run ruff format <pythonFiles>`
     3. Re-add ONLY the originally staged Python files from `python-staged.zlst`
   - Verification gate (must pass to proceed):
     - Security → `gitleaks protect --staged --redact`
     - Frontend present → `bun -C app/frontend biome check --staged` AND `bun -C app/frontend tsc --noEmit`
     - Python present → `uv run ruff check <pythonFiles>` AND `uv run ruff format --check <pythonFiles>`
   - If verification fails but any fixer made changes, loop another pass; if no changes across two consecutive passes, stop and surface errors.
4. Generate a Conventional Commit message from the staged diff (see below) and perform the commit.

### Command snippets

- List staged files:

```bash
git diff --cached --name-only --diff-filter=ACMR
```

- Persist originally staged file sets (null-delimited; safe with spaces/newlines):

```bash
# FRONTEND staged list
git diff --cached --name-only --diff-filter=ACMR -z \
  | grep -z '^app/frontend/' \
  | tee frontend-staged.zlst >/dev/null

# PYTHON staged list (outside app/frontend)
git diff --cached --name-only --diff-filter=ACMR -z \
  | grep -z -E '\.py$' \
  | grep -z -v '^app/frontend/' \
  | tee python-staged.zlst >/dev/null

# MARKDOWN staged list (anywhere)
git diff --cached --name-only --diff-filter=ACMR -z \
  | grep -z -E '\.md$' \
  | tee markdown-staged.zlst >/dev/null
```

- Markdown auto-format (run only if `markdown-staged.zlst` is non-empty):

```bash
# format markdown using mdformat with plugins and re-add
cat markdown-staged.zlst | xargs -0 -r -I {} uv run \
  --with mdformat --with mdformat-gfm --with mdformat-frontmatter --with mdformat-ruff \
  mdformat {}
cat markdown-staged.zlst | xargs -0 -r git add --
```

- Frontend auto-fix/check sequence (run only if `frontend-staged.zlst` is non-empty; follow hook order):

```bash
bun -C app/frontend tsc --noEmit
bun -C app/frontend biome check --fix --unsafe --staged
bun -C app/frontend biome check --staged
bun -C app/frontend knip --no-config-hints || true
# re-add ONLY the originally staged frontend files in safe batches
cat frontend-staged.zlst | xargs -0 -r -n 50 git add --
```

- Python auto-fix/format (run only if `python-staged.zlst` is non-empty):

```bash
# run ruff fix/format on the null-delimited list
cat python-staged.zlst | xargs -0 -r uv run ruff check --fix --unsafe-fixes --
cat python-staged.zlst | xargs -0 -r uv run ruff format --
cat python-staged.zlst | xargs -0 -r git add --
```

- Verification gate (must pass before committing):

```bash
# SECURITY (always)
gitleaks protect --staged --redact

# FRONTEND (if staged)
if [ -s frontend-staged.zlst ]; then
  bun -C app/frontend biome check --staged
  bun -C app/frontend tsc --noEmit
fi
# PYTHON (if staged)
if [ -s python-staged.zlst ]; then
  cat python-staged.zlst | xargs -0 -r uv run ruff check --
  cat python-staged.zlst | xargs -0 -r uv run ruff format --check --
fi
```

### Success condition

- All verification commands succeed, then the commit with the generated message exits with status 0.

### Notes

- Do not ignore non-fixable failures (e.g., TypeScript type errors). After two unsuccessful auto-fix retries with no new changes, stop and print the exact errors for the developer.
- Always run from repo root and prefer `bun -C app/frontend ...` to avoid changing directories.
- Use the same set of commands and order as the pre-commit hook to ensure parity with CI.

### Full pre-fix/check then commit flow (bounded passes, auto message)

```bash
set -euo pipefail

# 1) Ensure staged changes exist
if ! git diff --cached --quiet; then :; else
  echo "No staged changes. Stage files first (git add ...) and rerun."; exit 1
fi

# 2) Persist originally staged sets (null-delimited)
git diff --cached --name-only --diff-filter=ACMR -z | grep -z '^app/frontend/' | tee frontend-staged.zlst >/dev/null || true
git diff --cached --name-only --diff-filter=ACMR -z | grep -z -E '\.py$' | grep -z -v '^app/frontend/' | tee python-staged.zlst >/dev/null || true
git diff --cached --name-only --diff-filter=ACMR -z | grep -z -E '\.md$' | tee markdown-staged.zlst >/dev/null || true

MAX_PASSES=3
PASS=1
while :; do
  CHANGED=0

  # MARKDOWN
  if [ -s markdown-staged.zlst ]; then
    cat markdown-staged.zlst | xargs -0 -r -I {} uv run \
      --with mdformat --with mdformat-gfm --with mdformat-frontmatter --with mdformat-ruff \
      mdformat {} && CHANGED=1 || true
    cat markdown-staged.zlst | xargs -0 -r git add --
  fi

  # FRONTEND
  if [ -s frontend-staged.zlst ]; then
    bun -C app/frontend tsc --noEmit || true
    bun -C app/frontend biome check --fix --unsafe --staged && CHANGED=1 || true
    bun -C app/frontend biome check --staged || true
    bun -C app/frontend knip --no-config-hints || true
    cat frontend-staged.zlst | xargs -0 -r -n 50 git add --
  fi

  # PYTHON
  if [ -s python-staged.zlst ]; then
    cat python-staged.zlst | xargs -0 -r uv run ruff check --fix --unsafe-fixes -- && CHANGED=1 || true
    cat python-staged.zlst | xargs -0 -r uv run ruff format -- && CHANGED=1 || true
    cat python-staged.zlst | xargs -0 -r git add --
  fi

  # Verification gate
  # Security must pass
  gitleaks protect --staged --redact || { echo "GitLeaks found issues."; exit 1; }

  FRONTEND_OK=0
  PYTHON_OK=0
  if [ -s frontend-staged.zlst ]; then
    bun -C app/frontend biome check --staged && bun -C app/frontend tsc --noEmit && FRONTEND_OK=1 || FRONTEND_OK=0
  else
    FRONTEND_OK=1
  fi
  if [ -s python-staged.zlst ]; then
    cat python-staged.zlst | xargs -0 -r uv run ruff check -- && \
    cat python-staged.zlst | xargs -0 -r uv run ruff format --check -- && PYTHON_OK=1 || PYTHON_OK=0
  else
    PYTHON_OK=1
  fi

  if [ "$FRONTEND_OK" -eq 1 ] && [ "$PYTHON_OK" -eq 1 ]; then
    break
  fi

  if [ "$CHANGED" -eq 0 ] && [ "$PASS" -ge "$MAX_PASSES" ]; then
    echo "Auto-fixes exhausted but checks still failing. Review errors above and fix manually."; exit 1
  fi
  PASS=$((PASS + 1))
  if [ "$PASS" -gt "$MAX_PASSES" ]; then
    echo "Reached maximum passes ($MAX_PASSES)."; exit 1
  fi
done

# 3) Generate commit message from staged diff (Conventional Commits)
STATS=$(git diff --cached --stat)
DIFF=$(git diff --cached)
FILES=$(git diff --cached --name-only)

# Synthesize a Conventional Commit message:
# - Header: <type>(<scope>): <subject> (max ~72 chars)
# - Body: why + high-level summary; include notable changes per area
# - Footer: BREAKING CHANGE: <description> (if applicable)
# Heuristics: if only formatting/linting, use chore: format or style:

COMMIT_MSG=COMMIT_MSG.txt
{
  echo "<type>(<scope>): <concise subject summarizing changes>"
  echo
  echo "$STATS"
  echo
  echo "Summary:"
  echo "- Areas: $(printf '%s\n' "$FILES" | sed -E 's|/.*||' | sort -u | tr '\n' ', ' | sed 's/, $//')"
  echo "- Rationale: <why the change was needed>"
  echo
  echo "Details:"
  echo "<bullet list of key changes inferred from DIFF>"
  echo
  echo "Refs: <issue/ticket if any>"
} > "$COMMIT_MSG"

# 4) Commit
git commit -F "$COMMIT_MSG"

# 5) Cleanup
rm -f "$COMMIT_MSG" frontend-staged.zlst python-staged.zlst markdown-staged.zlst
```

### Commit message generation guidance

- Prefer Conventional Commits types: `feat`, `fix`, `refactor`, `perf`, `docs`, `style`, `test`, `build`, `ci`, `chore`.
- Use a single, specific scope when clear (e.g., `frontend`, `python`, `documents`, `canvas`); otherwise omit the scope.
- Keep the header subject imperative, concise, and <= 72 chars.
- If only formatting/linting changes are detected, use `chore: format` or `style: apply linting/formatting`.
- Include a `BREAKING CHANGE:` footer if the diff indicates incompatible API/behavior changes.
