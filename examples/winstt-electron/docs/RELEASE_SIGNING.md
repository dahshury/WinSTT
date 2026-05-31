# Release Signing (minisign)

WinSTT release artifacts (the `WinSTT-CPU-Portable-*.exe` and
`WinSTT-GPU-Portable-*.exe` files attached to each GitHub Release) are signed
with [minisign](https://jedisct1.github.io/minisign/) in addition to the
standard Authenticode signature that `electron-updater` already validates.

This adds a parallel, offline-verifiable trust layer:

- **Authenticode** (handled automatically by `electron-updater` and the
  Windows SmartScreen flow) protects users during install and update.
- **minisign sidecars** (`<artifact>.minisig`) let power users verify the
  download manually on any platform without a Windows trust store, using
  only the public key at [`docs/winstt.pub`](winstt.pub).

The user-facing verification recipe lives in the docs site at
`docs/content/docs/verify-releases.mdx` ("Verify Release Signatures").

## One-time setup (maintainer)

> The private key never enters the repo. It must be generated **locally**
> by the maintainer and the secret material must be supplied to GitHub
> Actions via repository secrets.

### 1. Generate the WinSTT signing keypair

Install minisign first:

- Windows: `scoop install minisign` (or `choco install minisign`)
- macOS: `brew install minisign`
- Linux: `apt install minisign` / `pacman -S minisign`

Then run, from the **repo root**:

```bash
minisign -G -p docs/winstt.pub -s ~/.config/winstt/winstt.key
```

You will be prompted for a password. Pick a strong one and store it in
your password manager — there is no recovery path if it is lost.

This produces two files:

| Path | Status |
|---|---|
| `docs/winstt.pub` | **Commit this to the repo.** Public, safe to share. |
| `~/.config/winstt/winstt.key` | **NEVER commit.** Keep on the maintainer machine only. `.gitignore` already excludes `*.key`. |

### 2. Commit the public key

```bash
git add docs/winstt.pub
git commit -m "chore(release): publish minisign verification pubkey"
```

### 3. Add GitHub Actions secrets

The release workflow (`.github/workflows/electron-release.yml`) reads two
repo secrets to sign each artifact. Add them under
**Settings → Secrets and variables → Actions → New repository secret**:

| Secret name | Value |
|---|---|
| `MINISIGN_SECRET_KEY` | The **entire contents** of `~/.config/winstt/winstt.key` (multi-line, beginning with `untrusted comment:`). |
| `MINISIGN_PASSWORD` | The password you typed during `minisign -G`. |

Easiest way to copy the secret-key file contents on Windows:

```pwsh
Get-Content $HOME\.config\winstt\winstt.key | Set-Clipboard
```

…then paste into the GitHub Actions secret form.

### 4. Cut a release

```bash
git tag v0.X.0
git push --tags
```

The CPU and GPU matrix jobs each build their installer, then a "Sign
artifacts with minisign" step writes `<artifact>.minisig` next to each
`.exe` and uploads both to the GitHub Release page. Users can then verify
following the recipe in the docs.

## Key rotation

If `MINISIGN_SECRET_KEY` is ever compromised:

1. Generate a new keypair locally (step 1 above) — overwrite
   `docs/winstt.pub` and your local `winstt.key`.
2. Replace the `MINISIGN_SECRET_KEY` and `MINISIGN_PASSWORD` secrets on
   GitHub.
3. Commit the new `docs/winstt.pub` and push.
4. Communicate the rotation in the release notes of the next tag — users
   who have cached the old pubkey will see verification fail until they
   refresh from the repo.

## Why this is not wired into the auto-updater

`electron-updater` already verifies Authenticode for every update payload
on Windows before it executes. Adding minisign verification into the
update flow would require shipping `docs/winstt.pub` inside the installed
app and trusting the locally-cached copy on every update — which adds
attack surface (the cached pubkey itself becomes a target) without
strengthening the chain meaningfully beyond what Authenticode + the
GitHub HTTPS endpoint already provide.

Minisign is therefore positioned strictly as a **manual, offline
verification layer for power users** — distributed via the repo's public
docs at https://github.com/dahshury/WinSTT, not bundled into the app.
