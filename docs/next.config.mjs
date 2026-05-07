import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: '/llms.txt',
        destination: '/api/llms.txt',
      },
      {
        source: '/llms-full.txt',
        destination: '/api/llms-full.txt',
      },
      {
        source: '/llms.mdx/docs/:path*',
        destination: '/api/llms.mdx/docs/:path*',
      },
      {
        source: '/docs/:path*.mdx',
        destination: '/api/llms.mdx/docs/:path*',
      },
    ];
  },
};

export default withMDX(config);

