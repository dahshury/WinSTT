/// <reference types="vite/client" />
import {
  HeadContent,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import type * as React from "react";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import appCss from "@/styles/app.css?url";

const docsBaseUrl =
  (import.meta as { env?: { VITE_DOCS_URL?: string } }).env?.VITE_DOCS_URL ??
  "http://localhost:3000";
const docsDescription =
  "Documentation for WinSTT - Windows speech-to-text desktop application";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "WinSTT Docs" },
      { name: "description", content: docsDescription },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "WinSTT Docs" },
      { property: "og:title", content: "WinSTT Docs" },
      { property: "og:description", content: docsDescription },
      { property: "og:url", content: docsBaseUrl },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      {
        rel: "preconnect",
        href: "https://cdn.jsdelivr.net",
        crossOrigin: "anonymous",
      },
      {
        rel: "stylesheet",
        href: "https://cdn.jsdelivr.net/npm/geist@1.2.0/dist/fonts/geist-sans/style.css",
      },
      {
        rel: "stylesheet",
        href: "https://cdn.jsdelivr.net/npm/geist@1.2.0/dist/fonts/geist-mono/style.css",
      },
    ],
  }),
  shellComponent: RootDocument,
});

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
        style={{ fontFamily: '"Geist", system-ui, -apple-system, sans-serif' }}
      >
        <RootProvider theme={{ enabled: false }}>{children}</RootProvider>
        <Scripts />
      </body>
    </html>
  );
}
