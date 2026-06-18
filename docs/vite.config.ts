import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import mdx from "fumadocs-mdx/vite";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

const githubPagesBase = process.env["DOCS_BASE_PATH"] ?? "/WinSTT/";
const docsBase = process.env["GITHUB_PAGES"] === "true" ? githubPagesBase : "/";
const appPackage = JSON.parse(
  readFileSync(join(process.cwd(), "..", "package.json"), "utf8"),
) as { version?: unknown };
const appVersion =
  typeof appPackage.version === "string" ? appPackage.version : "0.0.0-alpha.0";

function getDocsPages() {
  const contentRoot = join(process.cwd(), "content", "docs");
  const pages = ["/"];

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!entry.endsWith(".mdx")) continue;

      const relativePath = relative(contentRoot, fullPath).split(sep).join("/");
      const withoutExt = relativePath.replace(/\.mdx$/, "");
      const route =
        withoutExt === "index"
          ? "/docs"
          : withoutExt.endsWith("/index")
            ? `/docs/${withoutExt.slice(0, -"/index".length)}`
            : `/docs/${withoutExt}`;

      pages.push(route);
    }
  }

  walk(contentRoot);
  return [...new Set(pages)].map((path) => ({
    path,
    prerender: {
      enabled: true,
    },
  }));
}

export default defineConfig({
  base: docsBase,
  define: {
    "import.meta.env.VITE_WINSTT_VERSION": JSON.stringify(appVersion),
  },
  server: {
    // Docs intentionally runs on 3001 — the Tauri renderer dev server is
    // fixed to 1420, so the two dev servers don't collide when both are up.
    port: 3001,
    fs: {
      allow: [".", "../public"],
    },
  },
  resolve: {
    tsconfigPaths: true,
    alias: {
      "@source": new URL("./.source", import.meta.url).pathname,
      "@app-icon": new URL("../public/icon.png", import.meta.url).pathname,
    },
  },
  plugins: [
    mdx(import("./source.config")),
    tailwindcss(),
    tanstackStart({
      srcDirectory: "src",
      prerender: {
        enabled: true,
        autoSubfolderIndex: true,
        autoStaticPathsDiscovery: false,
        concurrency: 4,
        crawlLinks: false,
        failOnError: true,
        filter: ({ path }) =>
          !path.startsWith("/api/") && !path.startsWith("/og/"),
      },
      pages: getDocsPages(),
    }),
    viteReact(),
    nitro(),
  ],
});
