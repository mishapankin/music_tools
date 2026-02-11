import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  basePath: "/music_tools",
  env: {
    NEXT_PUBLIC_BASE_PATH: '/music_tools',
  },
  output: "export",
};

export default nextConfig;
