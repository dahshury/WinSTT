import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import mdx from "fumadocs-mdx/vite";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // Docs intentionally runs on 3001 — the Electron renderer at
    // `frontend/` claims 3000 (hardcoded in renderer-url.ts), so the two
    // projects must not collide when both dev servers are up.
    port: 3001,
    fs: {
      allow: [".", "../frontend/build"],
    },
  },
  resolve: {
    tsconfigPaths: true,
    alias: {
      "@source": new URL("./.source", import.meta.url).pathname,
      "@app-icon": new URL("../frontend/build/icon.png", import.meta.url)
        .pathname,
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
