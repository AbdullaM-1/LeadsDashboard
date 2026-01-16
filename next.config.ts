import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Suppress TypeScript errors during build (Vercel may be stricter)
  typescript: {
    // Don't fail build on TypeScript errors - let it continue
    ignoreBuildErrors: false,
  },
  // Transpile ringcentral-webphone libraries
  transpilePackages: ['sip.js', '@ringcentral/sdk'],
};

export default nextConfig;
