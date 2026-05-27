# Frontend Development Guide

## Project at a glance

- **Renderer:** Vite 7 multi-page React 19 app — **no router, no Next.js**. 8 HTML entries (`index.html` + `windows/*.html`), one `BrowserWindow` per entry.
- **Main process:** Electron 42 bundled by tsup → `dist-electron/main.js`.
- **Type checker:** `tsgo` (TypeScript native preview). Fall back to `bun typecheck:tsc` for stock `tsc`.
- **Linter / formatter:** Biome 2.x + `ultracite`. (No ESLint, no Prettier, no Stylelint.)
- **Architecture audit:** `bun check:fsd` — custom 123-rule auditor. (No Steiger.)
- **Styling:** Tailwind CSS v4 (`@tailwindcss/vite`) + UI primitives from `@base-ui/react`.
- **State:** Zustand. **No TanStack Query, no Redux** — IPC is the data layer.
- **Forms:** `react-hook-form` + `@hookform/resolvers` + Zod.
- **i18n:** `use-intl` (migrated off `next-intl`). Locales: `ar`, `en`, `es`, `fr`, `hi`, `zh`.

## Commands

| Command                       | Description                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `bun dev` / `bun electron:dev`| Full Electron + Vite dev (concurrent: `vite`, `tsup --watch`, electron-start)     |
| `bun dev:renderer`            | Vite renderer only (no Electron) — `http://localhost:3000`                        |
| `bun build`                   | Production renderer build (`vite build` → `dist-renderer/`)                       |
| `bun electron:compile`        | Bundle Electron main + preload via tsup → `dist-electron/`                        |
| `bun electron:build`          | Build distributable installer (electron-builder, NSIS portable)                   |
| `bun typecheck`               | TypeScript via `tsgo --noEmit` (NOT `npx tsc`)                                    |
| `bun lint` / `bun lint:fix`   | Biome lint (and auto-fix)                                                         |
| `bun format`                  | Biome format                                                                      |
| `bun test`                    | Run unit tests (Bun test runner)                                                  |
| `bun test:e2e`                | Playwright (browser projects)                                                     |
| `bun test:e2e:electron`       | Playwright against compiled Electron build                                        |
| `bun test:visual`             | Playwright visual-regression suite                                                |
| `bun generate`                | Regenerate TS types + Zod schemas from `../spec/openapi.yaml`                     |
| `bun knip`                    | Detect unused exports/files                                                       |
| `bun check:fsd`               | Audit FSD layer/import violations (123 rules)                                     |
| `bun check:i18n`              | Verify locale-key parity across `messages/*.json`                                 |
| `bun check:react-doctor`      | React-doctor static check (offline)                                               |
| `bun crap:gate` / `coverage:gate` | Regression gates against baseline reports                                     |
| `bun native:build`            | Recompile `winstt-paste.exe` and `winstt-context.exe` (C helpers)                 |

---

# Feature-Sliced Design (FSD) Rulebook

> **Core:** `src/` follows FSD: **Layers → Slices → Segments**. Import only from layers below. Expose via public API only.
>
> **Project convention:** the page-like top layer is named **`views/`** (not `pages/`). There is no router — each "view" is the React tree mounted into one HTML entry under `src/entries/<name>.tsx`. The rest of this doc uses `views/` consistently.

---

## 1. Layer Hierarchy

```
src/
  app/          # Bootstrap, providers, global styles, layouts (NO slices)
  views/        # One slice per BrowserWindow (main, settings, overlay,
                #   tray-menu, model-picker, device-picker, onboarding, history)
  widgets/      # Composite blocks (combine features + entities)
  features/     # Reusable user interactions
  entities/     # Business domain objects
  shared/       # Foundation utilities (NO slices)
  entries/      # One .tsx per HTML window — createRoot + render <View />
```

### Import Contract

| Layer    | May Import From                     |
| -------- | ----------------------------------- |
| app      | all                                 |
| views    | widgets, features, entities, shared |
| widgets  | features, entities, shared          |
| features | entities, shared                    |
| entities | shared (use `@x` for peer entities) |
| shared   | nothing                             |

Enforced by `bun check:fsd` (~123 rules, deterministic + heuristic; rule provenance + residuals in `.fsd-ledger/`, gitignored).

**Deprecated:** `processes/` layer. Use `features/` or `app/`.

---

## 2. Segments

Segments describe **purpose**, not essence.

| Segment   | Contains                                      |
| --------- | --------------------------------------------- |
| `ui/`     | Components, markup, formatting, local styles  |
| `api/`    | Requests, DTOs, mappers, loaders, actions     |
| `model/`  | Business logic, stores, validation, selectors |
| `lib/`    | Slice-specific helpers, formatters, adapters  |
| `config/` | Feature flags, slice constants                |

**Forbidden names:** `components/`, `hooks/`, `types/`, `utils/`, `helpers/`, `constants/`

### Hook Placement

| Type                      | Location            |
| ------------------------- | ------------------- |
| Domain data               | `model/`            |
| Reusable utility          | `shared/lib/hooks/` |
| UI behavior               | Same file or `ui/`  |
| API query/mutation        | `api/`              |
| Cross-slice orchestration | `app/`              |

### Example Structure

```
entities/article/
  ui/ArticlePreview.tsx, ArticleCard.tsx
  api/get-article.ts, dto.ts, mapper.ts
  model/article.ts, selectors.ts
  @x/user.ts          # Cross-entity export
  index.ts            # Public API
```

---

## 3. Public API

Every slice has ONE `index.ts`. Consumers import from there only.

```typescript
// views/settings/index.ts
export { SettingsView } from "./ui/SettingsView";
```

**Forbidden:**

```typescript
export * from "./ui/SettingsView"; // No wildcards
export * from "./model/store";     // No exposing internals
```

### Cross-Entity Imports (@x)

```
entities/song/@x/artist.ts → exports minimal surface for artist
entities/artist/model/ → imports from song/@x/artist
```

```typescript
// entities/song/@x/artist.ts
export type { Song } from "../model/song";

// entities/artist/model/artist.ts
import type { Song } from "entities/song/@x/artist";
```

---

## 4. Shared Layer

Segments only, no slices.

```
shared/
  ui/       # Primitives (Button wrapper, Card, Tooltip) on top of @base-ui/react
  api/      # IPC helpers, generated Zod schemas, OpenAPI-typed clients
  config/   # Env vars, app config
  lib/      # Utilities, formatters
  i18n/     # use-intl provider + messages loader
```

### Tree-Shaking: Separate Index Per Component

```
shared/ui/
  button/Button.tsx, index.ts
  text-field/TextField.tsx, index.ts
  index.ts  # Optional aggregate
```

```typescript
// Prefer specific imports
import { Button } from "@/shared/ui/button";

// Avoid aggregate (blocks tree-shaking)
import { Button } from "@/shared/ui";
```

**Rules:** Isolated folders, no business logic, props/slots only, CSS Modules colocated.

---

## 5. Data Layer (IPC, not HTTP)

The renderer has **no HTTP client**. All "remote" data flows through Electron IPC:

- Outbound: `window.electronAPI.<channel>(payload)` defined in `electron/preload.ts`'s `contextBridge` — typed via `spec/generated/ts/schema.d.ts` (regenerated by `bun generate` from `../spec/openapi.yaml`).
- Inbound: `window.electronAPI.on<Event>(handler)` — `IpcRendererEvent` is stripped in the preload so renderer code never imports `electron` types.
- Runtime validation: Zod schemas generated alongside the TS types (`scripts/generate-zod-schemas.ts`) — used at the IPC boundary for fuzz-/contract-tests.

Cloud STT (OpenAI / ElevenLabs) goes through the **electron-main** process via the Vercel AI SDK; the renderer never holds API keys. Settings reach the renderer via IPC after `electron-store` returns from main. See `memory/project_cloud_stt_architecture.md` and `memory/project_ws_request_response_value_envelope.md`.

```typescript
// shared/api/electron.ts (example)
export const settingsApi = {
  get: () => window.electronAPI.settingsGet(),
  set: (patch: SettingsPatch) => window.electronAPI.settingsSet({ value: patch }),
  on: (h: (next: Settings) => void) => window.electronAPI.onSettingsUpdate(h),
};
```

> **IPC envelope rule:** `sendRequest` commands MUST wrap their payload in `{ value: … }`. Never run downloads or model-load inline in async IPC handlers — they freeze the WS pump (`memory/project_ws_request_response_value_envelope.md`).

---

## 6. Types

| Type                              | Location                                |
| --------------------------------- | --------------------------------------- |
| Generated OpenAPI TS types        | `../spec/generated/ts/schema.d.ts`      |
| Generated Zod schemas             | `src/shared/api/schemas/` (or similar)  |
| Entity-specific domain types      | Entity's `model/`                       |
| DTOs / IPC payload shapes         | Next to handler in `api/`               |
| Component props                   | Same file as component                  |
| Utility types                     | `shared/lib/utility-types/`             |
| Ambient declarations              | `src/electron.d.ts`, `src/css.d.ts`     |

```typescript
// shared/api/models.ts
import type { components } from "@spec/generated/ts/schema";
export type SettingsSchema = components["schemas"]["SettingsSchema"];

// entities/transcription/api/dto.ts
export interface TranscriptionDTO {
  id: string;
  ts: number;
  text: string;
  wavPath: string | null;
}
```

---

## 7. Layer Details

### Entities

Business nouns (user, article, post). UI is **dumb** (render-only). Cross-references via `@x`.

<details><summary>Entity UI Example (Remix)</summary>

```typescript
// entities/article/ui/ArticlePreview.tsx
export function ArticlePreview({ article }: { article: Article }) {
  return (
    <div className="article-preview">
      <Link to={`/profile/${article.author.username}`}>
        <img src={article.author.image} alt="" />
      </Link>
      <Link to={`/article/${article.slug}`} className="preview-link">
        <h1>{article.title}</h1><p>{article.description}</p>
      </Link>
    </div>
  );
}
```

</details>

### Features

Reusable user interactions. **Never import another feature.** Use composition via props.

```
features/auth/
  ui/LoginForm.tsx, RegisterForm.tsx
  api/sign-in.ts, register.ts
  model/registration-schema.ts
  index.ts
```

### Widgets

Large composite blocks reused by multiple pages. Use when block needs multiple features/entities.

<details><summary>Header Widget Example (Remix)</summary>

```typescript
// widgets/header/ui/Header.tsx
export function Header() {
  const currentUser = useContext(CurrentUser);
  return (
    <nav className="navbar">
      <Link to="/">conduit</Link>
      {currentUser ? (
        <>
          <Link to="/editor"><i className="ion-compose" /> New Article</Link>
          <Link to="/settings"><i className="ion-gear-a" /> Settings</Link>
        </>
      ) : (
        <><Link to="/login">Sign in</Link><Link to="/register">Sign up</Link></>
      )}
    </nav>
  );
}
```

</details>

### Views (this project's "pages" layer)

One slice per BrowserWindow. **Never import another view.** Use `_` prefix for internal folders. Reuse features/entities for shared logic.

```
views/settings/
  ui/SettingsView.tsx
  model/...
  index.ts
```

Current views: `main`, `settings`, `overlay`, `tray-menu`, `model-picker`, `device-picker`, `onboarding`, `history`.

### App

Bootstrap layer. **No slices.** Organize by technical intent.

```
app/
  providers/IntlProvider.tsx, ThemeProvider.tsx
  layouts/TitleBar.tsx
  styles/globals.css
  index.tsx
```

---

## 8. Framework Integrations

### Vite (multi-page Electron renderer)

This project is a Vite multi-page app — there is no router. Each Electron
BrowserWindow loads its own HTML entry directly via `file://` in production
and via the Vite dev server (`http://localhost:3000/` for main,
`http://localhost:3000/windows/<page>.html` for secondaries) in dev.

**Structure:**

```
frontend/
├── index.html                 # main window (stays at root — Vite dev-root
│                              #   convention; serves at "/")
├── windows/                   # secondary windows (one HTML per BrowserWindow)
│   ├── settings.html
│   ├── overlay.html
│   ├── tray-menu.html
│   ├── model-picker.html
│   ├── device-picker.html
│   ├── onboarding.html
│   └── history.html
├── src/
│   ├── entries/               # one .tsx per HTML entry (createRoot here)
│   │   ├── main.tsx
│   │   ├── settings.tsx
│   │   ├── overlay.tsx
│   │   ├── tray-menu.tsx
│   │   ├── model-picker.tsx
│   │   ├── device-picker.tsx
│   │   ├── onboarding.tsx
│   │   └── history.tsx
│   └── ... (FSD layers — unchanged)
└── vite.config.ts            # rollupOptions.input lists all 8 entries
```

**Adding a new window:**

1. Create `windows/<window-name>.html` (copy an existing one). New windows go
   under `windows/`; only the main entry lives at the frontend root.
2. Create `src/entries/<window-name>.tsx` with `createRoot(...).render(<View />)`.
3. Add the entry to `vite.config.ts` `rollupOptions.input` as
   `resolve(rootDir, "windows/<window-name>.html")`.
4. Add the page key to the renderer-URL helper in `electron/lib/renderer-url.ts` so it maps to `"windows/<window-name>.html"`.
5. In Electron main, call `loadRendererPage(win, "<window-name>")`.

### Vite perf gotchas (already encoded in `vite.config.ts`)

- **React Compiler is dev-gated.** `babel-plugin-react-compiler` is wired only when `command === "build"` (saves ~8 s of dev first paint).
- **React + react-dom + @base-ui must share one chunk.** Splitting them produces circular ESM chunks → `Cannot read properties of undefined (reading 'useLayoutEffect')` in packaged builds (dev doesn't reproduce). See `memory/project_vite_chunk_circular_react.md`.
- **`server.warmup` only the main entry.** Warming all 8 entries regressed dev to ~14 s. See `memory/project_vite_cold_start_levers.md`.

### Electron main ↔ renderer

- `electron/preload.ts` is the only place `electron` is imported in the renderer chain. It strips `IpcRendererEvent` from callbacks before exposing them via `contextBridge.exposeInMainWorld`.
- `electron/ws/stt-client.ts` owns the dual-channel WebSocket to the Python STT server (control JSON + binary audio). The renderer never sees raw WS frames.
- `electron/ipc/*.ts` — modular handlers, each its own file with colocated `*.test.ts` (and some `.property.test.ts` using fast-check).

---

## 9. State Management

| Tool                 | Use For                                                              |
| -------------------- | -------------------------------------------------------------------- |
| **Zustand**          | Renderer client state (settings store, model store, transcription)   |
| **IPC**              | Server-of-truth data — Electron main is the data layer, not HTTP     |
| Local component state | UI-only state (open/closed dialogs, hover)                          |

**No TanStack Query, no Redux.** The data layer is IPC; refetching is replaced by IPC-push events from `electron/ws/stt-client.ts`.

```typescript
// entities/setting/model/settings-store.ts (shape)
import { create } from "zustand";

interface SettingsStore {
  settings: Settings;
  setSettings: (next: Settings) => void;
  patch: (p: Partial<Settings>) => void;
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  settings: defaultSettings,
  setSettings: (next) => set({ settings: next }),
  patch: (p) => set((s) => ({ settings: { ...s.settings, ...p } })),
}));
```

There are multiple model-related Zustand stores by design (catalog, model-swap, etc.). Be aware of split-brain risk — see `memory/project_server_split_brain_launch.md`.

---

## 10. Authentication

Not applicable — desktop app, no user accounts. Cloud API keys (OpenAI / ElevenLabs / OpenRouter) are stored via Electron `safeStorage` and never sent to the renderer. See `electron/lib/secret-storage.ts`.

<details><summary>Generic Remix reference (retained for FSD discipline reference only)</summary>

```typescript
// shared/api/auth.server.ts
const sessionStorage = createCookieSessionStorage<{ user: User }>({
  cookie: {
    name: "__session",
    httpOnly: true,
    sameSite: "lax",
    secrets: [process.env.SESSION_SECRET!],
    secure: process.env.NODE_ENV === "production",
  },
});

export async function createUserSession({ request, user, redirectTo }) {
  const session = await sessionStorage.getSession(
    request.headers.get("Cookie"),
  );
  session.set("user", user);
  return redirect(redirectTo, {
    headers: {
      "Set-Cookie": await sessionStorage.commitSession(session, {
        maxAge: 60 * 60 * 24 * 7,
      }),
    },
  });
}

export async function getUserFromSession(request: Request) {
  const session = await sessionStorage.getSession(
    request.headers.get("Cookie"),
  );
  return session.get("user") ?? null;
}

export async function requireUser(request: Request) {
  const user = await getUserFromSession(request);
  if (!user) throw redirect("/login");
  return user;
}
```

</details>

```typescript
// shared/api/currentUser.ts
export const CurrentUser = createContext<User | null>(null);
```

---

## 11. Validation & Forms

Stack: **`react-hook-form` + `@hookform/resolvers` + Zod**. Schemas often come from the generated bundle (`bun generate` → schemas paired with the OpenAPI TS types), then refined where needed.

```typescript
// views/settings/model/api-key-schema.ts
import { z } from "zod";

export const apiKeySchema = z.object({
  provider: z.enum(["openai", "elevenlabs", "openrouter"]),
  key: z.string().min(1, "API key required"),
});

export type ApiKeyInput = z.infer<typeof apiKeySchema>;
```

```typescript
// features/connect-server/ui/ApiKeyForm.tsx
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { apiKeySchema, type ApiKeyInput } from "../../views/settings/model/api-key-schema";

export function ApiKeyForm({ onSave }: { onSave: (input: ApiKeyInput) => void }) {
  const { register, handleSubmit, formState: { errors } } = useForm<ApiKeyInput>({
    resolver: zodResolver(apiKeySchema),
  });
  return (
    <form onSubmit={handleSubmit(onSave)}>
      <input {...register("key")} />
      {errors.key && <p className="text-red-500">{errors.key.message}</p>}
    </form>
  );
}
```

---

## 12. Layouts

| Location      | Use When                                         |
| ------------- | ------------------------------------------------ |
| `shared/ui`   | Simple primitives, no business logic, no widgets |
| `app/layouts` | Composes widgets, app-specific logic             |

```typescript
// shared/ui/layout/Layout.tsx
export function Layout({ children, sidebar }) {
  return <div><Header /><main>{children}</main><aside>{sidebar}</aside></div>;
}

// app/layouts/MainLayout.tsx
import { Header } from "widgets/header";
export function MainLayout({ children }) {
  return <><Header /><Sidebar />{children}</>;
}
```

---

## 13. Import Rules

**Within slice:** Relative paths, never `"../"` alone:

```typescript
import { loadUserStatistics } from "../api/loadUserStatistics"; // Good
import { loadUserStatistics } from "../"; // Bad - circular via index.ts
```

**Between slices:** Absolute imports:

```typescript
import { Button } from "@/shared/ui/button";
```

**Index files:** Re-export only, never import siblings.

---

## 14. Navigation (no URLs)

There is **no router** and no URL state. Each view is mounted at a fixed Electron BrowserWindow. Cross-window navigation is by sending an IPC command (`window.electronAPI.openWindow("settings")`), which calls `loadRendererPage(win, "<name>")` in Electron main.

Lower layers must **never** hardcode window names. If a feature/entity needs to open another window, accept the opener as a prop or use a thin helper in `shared/lib/`:

```typescript
// Good — opener accepted as a prop
<Button onClick={onOpenSettings}>Open Settings</Button>

// Bad — window name buried in an entity
<Button onClick={() => window.electronAPI.openWindow("settings")}>…</Button>
```

**Slice groups:** Group related slices but put NO shared code in the group folder:

```
features/llm-processing/, features/swap-model/, features/swap-notifications/  # No index.ts or utils.ts at features/<group>/
```

---

## 15. Styling

- **Tailwind CSS v4** (`@tailwindcss/vite`) is the primary styling system. Tokens live in CSS variables defined in `app/styles/`.
- UI primitives come from `@base-ui/react` (Base UI by MUI). Project wrappers under `shared/ui/<primitive>/`.
- Global styles in `app/styles/` (CSS, not SCSS). Multi-window assets in `public/`.
- `clsx` + `tailwind-merge` (`cn(...)`) for conditional class composition. `class-variance-authority` for variant APIs.

---

## 16. Tooling

| Tool                                          | Purpose                                          |
| --------------------------------------------- | ------------------------------------------------ |
| `bun`                                         | Package manager + test runner                    |
| `@biomejs/biome` (+ `ultracite`)              | Linting + formatting (NOT ESLint / Prettier)    |
| `tsgo` (`@typescript/native-preview`)         | Default type checker (use `bun typecheck:tsc` for stock `tsc`) |
| `bun check:fsd`                               | Architecture lint — 123-rule auditor (NOT Steiger) |
| `openapi-typescript`                          | TS type generation from `../spec/openapi.yaml`  |
| `scripts/generate-zod-schemas.ts`             | Zod runtime validator generation (paired with the TS types) |
| `knip`                                        | Dead-code / unused-export detection             |
| `react-doctor`                                | Static React anti-pattern check (`bun check:react-doctor`) |
| `@playwright/test`                            | E2E + visual regression                          |
| `@stryker-mutator/core`                       | Mutation testing (`stryker.conf.json`)           |
| `fast-check`                                  | Property-based testing (25+ `*.property.test.ts` suites) |
| `electron-builder`                            | Packaging (NSIS portable; see `packaging/electron-builder.*.yml`) |
| `@electron/rebuild`                           | Native-addon rebuild (only `uiohook-napi` today) |

```bash
bun generate          # regen TS types + Zod schemas from spec/openapi.yaml
bun check:fsd         # audit FSD violations
bun check:i18n        # locale-key parity
bun knip              # find unused exports
```

---

## 17. Anti-Patterns

| Pattern                                                            | Problem                                              |
| ------------------------------------------------------------------ | ---------------------------------------------------- |
| `components/`, `helpers/`, `utils/`, `types/`, `hooks/` folders    | Describes "what" not "why"                           |
| Cross-slice imports without `@x`                                   | Breaks isolation                                     |
| Hardcoded window names below views                                 | Coupling                                             |
| Global styles in slice CSS                                         | Breaks encapsulation                                 |
| Deep imports bypassing `index.ts`                                  | Fragile dependencies                                 |
| Shared logic in view slices                                        | Prevents reuse                                       |
| New layers for ad-hoc purposes                                     | Breaks architecture                                  |
| `export * from`                                                    | Blocks tree-shaking                                  |
| `useMemo` / `useCallback`                                          | React Compiler handles it; manual wrapping is noise (`memory/feedback_react_compiler.md`) |
| Importing `electron` from the renderer                             | Only `electron/preload.ts` may import `electron`     |
| Splitting React from `@base-ui` in `manualChunks`                  | Circular ESM crash in packaged builds (`memory/project_vite_chunk_circular_react.md`) |
| Running model loads / downloads inline in async IPC handlers       | Freezes the WS pump (`memory/project_ws_request_response_value_envelope.md`) |

**Structure comparison:**

```
Bad (by type)          Good (by domain)
├── components/        ├── entities/
│   ├── DeliveryCard   │   ├── delivery/
├── actions/           │   │   ├── ui/card.js
│   ├── delivery.js    │   │   ├── model/actions.js
├── helpers/           │   ├── region/
```

---

## 18. Migration

1. Solidify `shared/` + `app/` (config, ui kit)
2. Group existing UI into views/widgets (temporary violations OK)
3. Extract features/entities over time
4. Document public APIs before removing legacy
5. Run `bun check:fsd` for violations

---

## 19. Quick Reference

```
LAYERS: app → views → widgets → features → entities → shared
SEGMENTS: ui, api, model, lib, config
IMPORTS: Only from layers below. @x for entity cross-refs. No sideways.
PUBLIC API: One index.ts, named exports, no wildcards.
STYLING: Tailwind v4 + @base-ui/react. Globals in app/styles/.
NAVIGATION: No router. Each view = one BrowserWindow + one HTML entry.
FORMS: react-hook-form + Zod (resolver). Validation in model/, UI errors in ui/.
STATE: Zustand (renderer client state) + IPC (data layer). No TanStack Query, no Redux.
COMPILER: React Compiler in build only. Never write useMemo / useCallback.
```
