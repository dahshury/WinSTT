import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import mdx from "fumadocs-mdx/vite";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
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
    }),
    viteReact(),
    nitro(),
  ],
});
