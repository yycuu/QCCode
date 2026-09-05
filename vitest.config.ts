import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@qccode/protocol": `${root}packages/protocol/src/index.ts`,
      "@qccode/security": `${root}packages/security/src/index.ts`,
      "@qccode/core": `${root}packages/core/src/index.ts`,
      "@qccode/geometry": `${root}packages/geometry/src/index.ts`,
      "@qccode/encoder": `${root}packages/encoder/src/index.ts`,
      "@qccode/decoder": `${root}packages/decoder/src/index.ts`,
      "@qccode/vision": `${root}packages/vision/src/index.ts`,
      "@qccode/renderer-svg": `${root}packages/renderer-svg/src/index.ts`,
      "@qccode/renderer-canvas": `${root}packages/renderer-canvas/src/index.ts`,
      "@qccode/scanner": `${root}packages/scanner/src/index.ts`,
    },
  },
});
