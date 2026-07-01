/// <reference types="vite/client" />
import {
  createRootRoute,
  HeadContent,
  Link,
  Scripts,
} from "@tanstack/react-router";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import type * as React from "react";
import { absoluteDocsUrl, siteConfig } from "@/lib/site";
import appCss from "@/styles/app.css?url";

const docsDescription = siteConfig.description;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: `${siteConfig.name} Docs` },
      { name: "description", content: docsDescription },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: `${siteConfig.name} Docs` },
      { property: "og:title", content: `${siteConfig.name} Docs` },
      { property: "og:description", content: docsDescription },
      { property: "og:url", content: absoluteDocsUrl("/") },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      // fonttrio "startup" trio — Nunito (headings), Nunito Sans (body),
      // Fira Code (mono). Loaded from Google Fonts; CSS vars in app.css.
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossOrigin: "anonymous",
      },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600&family=Nunito:wght@400;600;700;800;900&family=Nunito+Sans:wght@400;600;700&display=swap",
      },
    ],
  }),
  shellComponent: RootDocument,
  notFoundComponent: NotFound,
});

function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-24 text-center">
      <p
        className="font-mono text-xs uppercase tracking-[0.2em]"
        style={{ color: "var(--brand-accent)" }}
      >
        404
      </p>
      <h1 className="mt-3 text-3xl font-bold tracking-tight">Page not found</h1>
      <p
        className="mt-3 max-w-md text-sm leading-relaxed"
        style={{
          color: "color-mix(in oklab, var(--fg-strong) 60%, transparent)",
        }}
      >
        The page you're looking for doesn't exist or has moved. Try the
        documentation home, or head back to the landing page.
      </p>
      <div className="mt-8 flex gap-3">
        <Link
          to="/"
          className="inline-flex items-center gap-2 rounded-lg px-5 py-2 text-sm font-medium transition-all hover:brightness-110"
          style={{
            background: "var(--brand-accent)",
            color: "var(--fg-strong)",
            boxShadow:
              "inset 0 1px 0 0 oklch(100% 0 0 / 0.12), 0 0 24px color-mix(in oklab, var(--brand-accent) 25%, transparent)",
          }}
        >
          Home
        </Link>
        <Link
          to="/docs/$"
          params={{ _splat: "" }}
          className="inline-flex items-center gap-2 rounded-lg px-5 py-2 text-sm font-medium transition-colors"
          style={{
            background: "transparent",
            border:
              "1px solid color-mix(in oklab, var(--fg-strong) 15%, transparent)",
            color: "color-mix(in oklab, var(--fg-strong) 85%, transparent)",
          }}
        >
          Documentation
        </Link>
      </div>
    </main>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className="dark"
      style={{ colorScheme: "dark" }}
      suppressHydrationWarning
    >
      <head>
        <HeadContent />
      </head>
      <body
        className="flex flex-col min-h-screen"
        style={{ fontFamily: "var(--font-body)" }}
      >
        <RootProvider theme={{ enabled: false }}>{children}</RootProvider>
        <Scripts />
      </body>
    </html>
  );
}
