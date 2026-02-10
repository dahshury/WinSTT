import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	output: "export",
	distDir: "out",
	images: {
		unoptimized: true,
	},
	reactCompiler: true,
};

export default nextConfig;
