import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	cacheComponents: true,
	output: "standalone",
	distDir: "out",
	images: {
		unoptimized: true,
	},
	reactCompiler: true,
	// Repo root has its own bun.lock for husky; pin Turbopack to the frontend
	// workspace so it doesn't warn about the parent lockfile.
	turbopack: {
		root: fileURLToPath(new URL(".", import.meta.url)),
	},
};

export default nextConfig;
