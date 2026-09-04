import { readFile } from "node:fs/promises";

const expected = process.env.GITHUB_REF_NAME?.replace(/^v/u, "");
if (!expected) throw new Error("Release tag must be named v<version>");

const directories = [
  "core", "geometry", "protocol", "security", "vision", "encoder",
  "decoder", "renderer-canvas", "renderer-svg", "scanner", "server-sdk", "sdk",
];

for (const directory of directories) {
  const manifest = JSON.parse(await readFile(new URL(`../packages/${directory}/package.json`, import.meta.url)));
  if (manifest.version !== expected) {
    throw new Error(`${manifest.name} is ${manifest.version}, expected ${expected} from the release tag`);
  }
}

console.log(`All QCCode packages match release ${expected}.`);
