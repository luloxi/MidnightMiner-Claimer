/** @type {import('next').NextConfig} */
const nextConfig = {
  // Load the native Cardano library from Node.js at runtime on the server.
  serverExternalPackages: ["@emurgo/cardano-serialization-lib-nodejs"],

  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Don't try to polyfill/bundle the native addon on the client side
      config.resolve.fallback = {
        ...config.resolve.fallback,
        "@emurgo/cardano-serialization-lib-nodejs": false,
      };
    }
    // Ignore .wasm files that webpack might try to process
    config.module.rules.push({
      test: /\.wasm$/,
      type: "asset/resource",
    });
    return config;
  },
};

export default nextConfig;
