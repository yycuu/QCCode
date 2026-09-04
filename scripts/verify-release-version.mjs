import { readFile } from "node:fs/promises";

const releaseTag = process.env.GITHUB_REF_NAME;
if (!releaseTag) throw new Error("Release tag is unavailable.");

const directories = [
  "core", "geometry", "protocol", "security", "vision", "encoder",
  "decoder", "renderer-canvas", "renderer-svg", "scanner", "server-sdk", "sdk",
];

const manifests = await Promise.all(directories.map(async (directory) =>
  JSON.parse(await readFile(new URL(`../packages/${directory}/package.json`, import.meta.url))),
));
const versions = new Set(manifests.map(({ version }) => version));
if (versions.size !== 1) {
  throw new Error(`All packages must have one version; found ${[...versions].join(", ")}.`);
}

const [version] = versions;
const expectedTag = `v${version}`;
if (releaseTag !== expectedTag) {
  throw new Error(`Release tag ${releaseTag} does not match package version ${version}. Create the GitHub Release with tag ${expectedTag}.`);
}

console.log(`All QCCode packages match release ${releaseTag}.`);
