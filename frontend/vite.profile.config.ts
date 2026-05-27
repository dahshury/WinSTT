import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

// Mirror of vite.config.ts for sandboxed benchmarking. Uses a separate
// cacheDir + port so we can run `vite` here without clobbering the live
// dev session's caches. Keep in sync with vite.config.ts so measurements
// reflect the real config.
export default defineConfig(({ command }) => {
	const isProdBuild = command === "build";
	return {
		root: rootDir,
		base: "./",
		cacheDir: "node_modules/.vite-profile",
		plugins: [
			react({
				babel: {
					plugins: isProdBuild ? [["babel-plugin-react-compiler", { target: "19" }]] : [],
				},
			}),
			tsconfigPaths(),
			tailwindcss(),
		],
		optimizeDeps: {
			include: [
				"react",
				"react-dom",
				"react-dom/client",
				"react/jsx-runtime",
				"react/jsx-dev-runtime",
				"use-intl",
				"use-intl/react",
				"zustand",
				"zustand/middleware",
				"zustand/shallow",
				"motion",
				"motion/react",
				"virtua",
				"zod",
				"react-hook-form",
				"@hookform/resolvers/zod",
				"tailwind-merge",
				"clsx",
				"class-variance-authority",
				"fuse.js",
				"double-metaphone",
				"@hugeicons/react",
				"@hugeicons/core-free-icons",
				"@base-ui/react",
			],
		},
		build: {
			outDir: "dist-renderer-profile",
			emptyOutDir: true,
			sourcemap: false,
			target: "esnext",
			reportCompressedSize: false,
			rollupOptions: {
				input: {
					main: resolve(rootDir, "index.html"),
					settings: resolve(rootDir, "windows/settings.html"),
					overlay: resolve(rootDir, "windows/overlay.html"),
					"tray-menu": resolve(rootDir, "windows/tray-menu.html"),
					"model-picker": resolve(rootDir, "windows/model-picker.html"),
					"device-picker": resolve(rootDir, "windows/device-picker.html"),
					onboarding: resolve(rootDir, "windows/onboarding.html"),
					history: resolve(rootDir, "windows/history.html"),
				},
			},
		},
		server: {
			port: 3099,
			strictPort: true,
			warmup: { clientFiles: ["./src/entries/main.tsx"] },
		},
	};
});
