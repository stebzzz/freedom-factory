import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  reactCompiler: true,
  output: "standalone",
  serverExternalPackages: [
    "@anthropic-ai/sdk",
    "@fal-ai/client",
    "remotion",
    "@remotion/renderer",
    "@remotion/bundler",
    "fluent-ffmpeg",
  ],
  turbopack: {
    root: __dirname,
  },
  outputFileTracingExcludes: {
    "/*": [
      "public/generated/**/*",
      "public/old/**/*",
      "public/style-refs/**/*",
      "public/uploads/**/*",
      "outputs/**/*",
      "audio/**/*",
      "mp3/**/*",
      "old/**/*",
      ".concat-work/**/*",
      "ref-style/**/*",
      "dentist/**/*",
      "node_modules/@remotion/compositor-darwin-*/**/*",
      "node_modules/@remotion/compositor-win32-*/**/*",
    ],
  },
};

export default nextConfig;
