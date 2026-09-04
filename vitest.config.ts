import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@circlecode/protocol": `${root}packages/protocol/src/index.ts`,
      "@circlecode/security": `${root}packages/security/src/index.ts`,
      "@circlecode/core": `${root}packages/core/src/index.ts`,
      "@circlecode/geometry": `${root}packages/geometry/src/index.ts`,
      "@circlecode/encoder": `${root}packages/encoder/src/index.ts`,
      "@circlecode/decoder": `${root}packages/decoder/src/index.ts`,
      "@circlecode/renderer-svg": `${root}packages/renderer-svg/src/index.ts`,
    },
  },
});
