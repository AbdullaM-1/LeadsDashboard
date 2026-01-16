import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  // Suppress TypeScript errors during build (Vercel may be stricter)
  typescript: {
    // Don't fail build on TypeScript errors - let it continue
    ignoreBuildErrors: false,
  },
  // Suppress ESLint errors during build
  eslint: {
    // Don't fail build on ESLint errors
    ignoreDuringBuilds: false,
  },
  // Transpile ringcentral-webphone libraries
  transpilePackages: ['sip.js', '@ringcentral/sdk'],
};

export default nextConfig;
