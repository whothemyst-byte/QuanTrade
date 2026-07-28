import type { NextConfig } from "next";

const config: NextConfig = {
  // The workspace packages ship TypeScript source, not build output.
  transpilePackages: ["@quantrade/core", "@quantrade/agent"],

  webpack: (cfg) => {
    // Those packages use ESM-style ".js" specifiers that resolve to ".ts"
    // files. Without this alias webpack hunts for emitted JavaScript that
    // never exists, and the Mind page fails to build.
    cfg.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return cfg;
  },
};

export default config;
