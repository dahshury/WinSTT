import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	cacheComponents: true,
	output: "standalone",
	distDir: "out",
	images: {
		unoptimized: true,
	},
	reactCompiler: true,
};

export default nextConfig;
