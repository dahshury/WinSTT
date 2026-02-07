# Frontend Development Guide

## Commands

| Command         | Description                              |
| --------------- | ---------------------------------------- |
| `bun typecheck` | TypeScript type checking (NOT `npx tsc`) |
| `bun dev`       | Start development server                 |
| `bun build`     | Production build                         |
| `bun lint`      | ESLint                                   |

---

# Feature-Sliced Design (FSD) Rulebook

> **Core:** `src/` follows FSD: **Layers → Slices → Segments**. Import only from layers below. Expose via public API only.

---

## 1. Layer Hierarchy

```
src/
  app/          # Bootstrap, providers, global styles (NO slices)
  pages/        # Route-mapped pages
  widgets/      # Composite blocks (features+entities)
  features/     # Reusable user interactions
  entities/     # Business domain objects
  shared/       # Foundation utilities (NO slices)
```

### Import Contract

| Layer    | May Import From                     |
| -------- | ----------------------------------- |
| app      | all                                 |
| pages    | widgets, features, entities, shared |
| widgets  | features, entities, shared          |
| features | entities, shared                    |
| entities | shared (use `@x` for peer entities) |
| shared   | nothing                             |

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
// pages/feed/index.ts
export { FeedPage } from "./ui/FeedPage";
export { loader } from "./api/loader";
```

**Forbidden:**

```typescript
export * from "./ui/FeedPage"; // No wildcards
export * from "./model/comments"; // No exposing internals
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
  ui/       # Primitives (Button, Input, Card)
  api/      # API client, HTTP helpers, DTOs
  config/   # Env vars, app config
  lib/      # Utilities, formatters
  routes/   # Route path constants
  i18n/     # Internationalization
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

## 5. API Client

### OpenAPI Fetch (Recommended)

```typescript
// shared/api/client.ts
import createClient from "openapi-fetch";
import type { paths } from "./v1";
export const { GET, POST, PUT, DELETE } = createClient<paths>({ baseUrl });
```

<details><summary>Axios Alternative</summary>

```typescript
export const client = axios.create({ baseURL, timeout: 5000 });
```

</details>

<details><summary>Custom Class Alternative</summary>

```typescript
export class ApiClient {
  constructor(private baseUrl: string) {}
  async get<T>(
    endpoint: string,
    params?: Record<string, string | number>,
  ): Promise<T> {
    const url = new URL(endpoint, this.baseUrl);
    if (params)
      Object.entries(params).forEach(([k, v]) =>
        url.searchParams.append(k, String(v)),
      );
    const res = await fetch(url.toString(), {
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  async post<T, D>(endpoint: string, body: D): Promise<T> {
    const res = await fetch(`${this.baseUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}
```

</details>

---

## 6. Types

| Type                        | Location                             |
| --------------------------- | ------------------------------------ |
| API response types (shared) | `shared/api/models.ts`               |
| Entity-specific types       | Entity's `model/`                    |
| DTOs/mappers                | Next to request in `api/`            |
| Component props             | Same file as component               |
| Utility types               | `shared/lib/utility-types/`          |
| Ambient declarations        | `shared/lib/untyped-packages/*.d.ts` |

```typescript
// shared/api/models.ts
import type { components } from "./v1";
export type Article = components["schemas"]["Article"];

// entities/song/api/dto.ts
export interface SongDTO {
  id: number;
  title: string;
  disc_no: number;
  artist_ids: number[];
}

// entities/song/api/mapper.ts
export function adaptSongDTO(dto: SongDTO): Song {
  return {
    id: String(dto.id),
    title: dto.title,
    fullTitle: `${dto.disc_no} / ${dto.title}`,
  };
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

### Pages

Route-mapped. **Never import another page.** Use `_` prefix for internal folders. Reuse features/entities for shared logic.

```
pages/feed/
  ui/FeedPage.tsx, Tabs.tsx, Pagination.tsx
  api/loader.ts
  index.ts
```

### App

Bootstrap layer. **No slices.** Organize by technical intent.

```
app/
  providers/QueryProvider.tsx
  layouts/MainLayout.tsx, AuthLayout.tsx
  styles/globals.scss
  assets/logo.svg
  api-routes/get-example-data.ts
  index.tsx
```

---

## 8. Framework Integrations

### Next.js (App Router)

- Default to Server Components
- `'use client'` only for event listeners, browser APIs, state
- Use async runtime APIs (Next.js 15+):

```typescript
const cookieStore = await cookies();
const params = await props.params;
```

**Structure:**

```
├── app/                    # Next.js router
│   ├── api/example/route.ts  # Re-exports from src/app/api-routes
│   └── example/page.tsx      # Re-exports from src/pages
└── src/                    # FSD layers
```

**Page re-export:**

```typescript
// app/example/page.tsx
export { ExamplePage as default, metadata } from "@/pages/example";
```

**API route:**

```typescript
// src/app/api-routes/get-example-data.ts
export const getExampleData = () => {
  try {
    return Response.json({ data: getExamplesList() });
  } catch {
    return Response.json(null, { status: 500 });
  }
};
// app/api/example/route.ts
export { getExampleData as GET } from "@/app/api-routes";
```

### Remix

<details><summary>Route File</summary>

```typescript
// app/routes/_index.tsx
import { FeedPage } from "pages/feed";
export { loader } from "pages/feed";
export const meta: MetaFunction = () => [{ title: "Conduit" }];
export default FeedPage;
```

</details>

<details><summary>Loader</summary>

```typescript
// pages/feed/api/loader.ts
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const tag = url.searchParams.get("tag") ?? undefined;
  const page = parseInt(url.searchParams.get("page") ?? "", 10);
  return json(
    await promiseHash({
      articles: throwAnyErrors(
        GET("/articles", {
          params: { query: { tag, limit: 20, offset: page * 20 } },
        }),
      ),
      tags: throwAnyErrors(GET("/tags")),
    }),
  );
};
```

</details>

<details><summary>Named Actions</summary>

```typescript
// pages/article-read/api/action.ts
export const action = async ({ request, params }: ActionFunctionArgs) => {
  const currentUser = await requireUser(request);
  const formData = await request.formData();
  return namedAction(formData, {
    async delete() {
      await DELETE("/articles/{slug}", {
        params: { path: { slug: params.slug } },
        headers: auth,
      });
      return redirect("/");
    },
    async favorite() {
      await POST("/articles/{slug}/favorite", {
        params: { path: { slug: params.slug } },
        headers: auth,
      });
      return redirectBack(request, { fallback: "/" });
    },
  });
};
```

</details>

### SvelteKit

<details><summary>Config</summary>

```typescript
// svelte.config.js
export default {
  kit: {
    files: {
      routes: "src/app/routes",
      lib: "src",
      appTemplate: "src/app/index.html",
      assets: "public",
    },
    alias: { "@/*": "src/*" },
  },
};
```

```html
<!-- src/app/routes/+page.svelte -->
<script>
  import { HomePage } from "@/pages/home";
</script>
<HomePage />
```

</details>

### NuxtJS

<details><summary>Config</summary>

```typescript
// nuxt.config.ts
export default defineNuxtConfig({
  alias: { "@": "../src" },
  dir: { pages: "./src/app/routes", layouts: "./src/app/layouts" },
});
```

</details>

### Electron

<details><summary>Structure & IPC</summary>

```
src/
  app/main/, preload/, renderer/
  main/features/, entities/, shared/
  renderer/pages/, widgets/, features/, entities/, shared/
  shared/ipc/channels.ts, events.ts
```

```typescript
// shared/ipc/channels.ts
export const CHANNELS = {
  GET_USER_DATA: "GET_USER_DATA",
  SAVE_USER: "SAVE_USER",
} as const;

// app/preload/index.ts
const API = {
  [CHANNELS.GET_USER_DATA]: () => ipcRenderer.sendSync(CHANNELS.GET_USER_DATA),
  [CHANNELS.SAVE_USER]: (args) => ipcRenderer.invoke(CHANNELS.SAVE_USER, args),
};
contextBridge.exposeInMainWorld("electron", API);
```

</details>

---

## 9. State Management

| Tool        | Use For                                            |
| ----------- | -------------------------------------------------- |
| React Query | Server state (API, caching, sync)                  |
| Redux       | Complex client state (multi-step, cross-component) |
| URL state   | UI state (filters, pagination, modals)             |

Can be combined.

### React Query

```typescript
// shared/api/query-client.ts
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5 * 60 * 1000, gcTime: 5 * 60 * 1000 },
  },
});

// entities/post/api/post.queries.ts
export const postQueries = {
  all: () => ["posts"],
  lists: () => [...postQueries.all(), "list"],
  list: (page: number, limit: number) =>
    queryOptions({
      queryKey: [...postQueries.lists(), page, limit],
      queryFn: () => getPosts(page, limit),
      placeholderData: (prev) => prev,
    }),
  detail: (id?: number) =>
    queryOptions({
      queryKey: [...postQueries.all(), "detail", id],
      queryFn: () => getDetailPost({ id }),
      staleTime: 5000,
    }),
};

// features/post/api/use-update-title.ts
export const useUpdateTitle = (id: number) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ newTitle }) =>
      apiClient.patch(`/posts/${id}`, { title: newTitle }),
    onSuccess: (newPost) =>
      qc.setQueryData(postQueries.detail({ id }), newPost),
  });
};
```

### Redux Toolkit

<details><summary>Entity Adapter</summary>

```typescript
// entities/song/model/songs.ts
export const fetchSongs = createAsyncThunk("songs/fetchSongs", listSongs);
const songAdapter = createEntityAdapter();
const songsSlice = createSlice({
  name: "songs",
  initialState: songAdapter.getInitialState(),
  reducers: {},
  extraReducers: (b) => {
    b.addCase(fetchSongs.fulfilled, (s, a) =>
      songAdapter.upsertMany(s, a.payload),
    );
  },
});
export default songsSlice.reducer;
```

</details>

<details><summary>Normalizr</summary>

```typescript
export const artistEntity = new schema.Entity("artists");
export const songEntity = new schema.Entity("songs", {
  artists: [artistEntity],
});
export const fetchSong = createAsyncThunk("songs/fetchSong", async (id) => {
  const data = await getSong(id);
  return normalize(data, songEntity).entities;
});
```

</details>

<details><summary>Global Types</summary>

```typescript
// app/store.ts
const store = configureStore({
  reducer: { songs: songReducer, artists: artistReducer },
});
declare type RootState = ReturnType<typeof store.getState>;
declare type AppDispatch = typeof store.dispatch;

// shared/lib/redux/hooks.ts
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
```

</details>

---

## 10. Authentication (Remix Reference)

<details><summary>Session Storage</summary>

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

```typescript
// Zod schema - pages/sign-in/model/registration-schema.ts
export const registrationData = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  confirmPassword: z.string(),
}).refine((d) => d.password === d.confirmPassword, { message: "Passwords do not match", path: ["confirmPassword"] });

// Form parser - pages/article-edit/model/parseAsArticle.ts
export function parseAsArticle(data: FormData) {
  const errors = [];
  const title = data.get("title");
  if (typeof title !== "string" || !title) errors.push("Give this article a title");
  // ... validate other fields
  if (errors.length) throw errors;
  return { title, description, body, tags: data.get("tags") ?? "" };
}

// Form errors component (Remix)
export function FormErrors() {
  const actionData = useActionData<typeof action>();
  return actionData?.errors ? <ul className="error-messages">{actionData.errors.map(e => <li key={e}>{e}</li>)}</ul> : null;
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

## 14. URL & Routing

Lower layers **never hardcode URLs**. Accept routes as props or use `shared/routes`.

```typescript
// Bad - URL in entity
<Card.Title href={`/post/${data.id}`} />

// Good - URL from page layer
<Card.Title href={getPostUrl(data.id)} />
```

**URL state (Remix):**

```typescript
export function FeedPage() {
  const [searchParams] = useSearchParams();
  const page = parseInt(searchParams.get("page") ?? "1", 10);
  return <Form><ExistingSearchParams exclude={["page"]} /><button name="page" value={page + 1}>Next</button></Form>;
}
```

**Slice groups:** Group related slices but NO shared code in group folder:

```
features/post/compose/, like/, delete/  # No index.ts or utils.ts at features/post/
```

---

## 15. Styling

- CSS Modules (`*.module.scss/css`) colocated with components
- Global styles in `app/styles/`
- Multi-layer assets in `app/assets/` or `static/`

---

## 16. Tooling

| Tool                        | Purpose                                 |
| --------------------------- | --------------------------------------- |
| bun                         | Package manager                         |
| ESLint, Stylelint, Prettier | Linting/formatting                      |
| Steiger                     | Architecture lint (`npx steiger src`)   |
| FSD CLI                     | Scaffolding (`npx fsd <layer> <slice>`) |
| openapi-typescript, orval   | Type generation                         |

```bash
bun run generate-api-types
npx fsd pages feed sign-in --segments ui api
npx steiger src
```

---

## 17. Anti-Patterns

| Pattern                           | Problem                    |
| --------------------------------- | -------------------------- |
| `components/`, `helpers/` folders | Describes "what" not "why" |
| Cross-slice imports without `@x`  | Breaks isolation           |
| Hardcoded URLs below pages        | Coupling                   |
| Global styles in slice CSS        | Breaks encapsulation       |
| Deep imports bypassing index.ts   | Fragile dependencies       |
| Shared logic in page slices       | Prevents reuse             |
| New layers for ad-hoc purposes    | Breaks architecture        |
| `export * from`                   | Blocks tree-shaking        |

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
2. Group existing UI into pages/widgets (temporary violations OK)
3. Extract features/entities over time
4. Document public APIs before removing legacy
5. Run `npx steiger src` for violations

---

## 19. Quick Reference

```
LAYERS: app → pages → widgets → features → entities → shared
SEGMENTS: ui, api, model, lib, config
IMPORTS: Only from layers below. @x for entity cross-refs. No sideways.
PUBLIC API: One index.ts, named exports, no wildcards.
STYLING: CSS Modules per slice, globals in app/styles/
ROUTING: Pages own URLs, lower layers URL-agnostic.
FORMS: Validation in model/, UI errors in ui/, submissions in api/.
STATE: React Query (server), Redux (complex client), URL (UI filters).
```
