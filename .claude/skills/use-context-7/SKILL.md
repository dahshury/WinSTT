# Context7 - Library Documentation Fetcher

Fetch up-to-date documentation for any library using Context7 via MCP Docker.

---

## Prerequisites

Context7 must be added to the session first:

```
mcp__MCP_DOCKER__mcp-add({ name: "context7", activate: true })
```

---

## Usage (Two-Step Process)

### Step 1: Resolve the library ID

```
mcp__MCP_DOCKER__resolve-library-id({ libraryName: "prisma" })
```

This returns a Context7-compatible library ID like `/prisma/docs`.

### Step 2: Fetch documentation

```
mcp__MCP_DOCKER__get-library-docs({
  context7CompatibleLibraryID: "/prisma/docs",
  topic: "queries relations",  // optional - focus on specific topic
  tokens: 5000                 // optional - max tokens (default: 10000)
})
```

---

## Common Library IDs

| Library | ID |
|---------|-----|
| Next.js | `/vercel/next.js` |
| Prisma | `/prisma/docs` |
| React | `/facebook/react` |
| NestJS | `/nestjs/docs` |
| tRPC | `/trpc/trpc` |
| Tailwind CSS | `/tailwindlabs/tailwindcss` |
| Zod | `/colinhacks/zod` |

If unsure, always use `resolve-library-id` first to get the correct ID.

---

## Example: Full Workflow

```typescript
// 1. Resolve library
mcp__MCP_DOCKER__resolve-library-id({ libraryName: "next.js" })
// Returns: /vercel/next.js

// 2. Fetch docs on specific topic
mcp__MCP_DOCKER__get-library-docs({
  context7CompatibleLibraryID: "/vercel/next.js",
  topic: "middleware",
  tokens: 8000
})
```

---

## When to Use

- Looking up current API syntax
- Checking latest features/changes
- Verifying correct usage patterns
- Getting code examples for specific topics
