import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const packages = [
  "core",
  "geometry",
  "protocol",
  "security",
  "vision",
  "encoder",
  "decoder",
  "renderer-canvas",
  "renderer-svg",
  "scanner",
  "server-sdk",
  "sdk",
];

const publish = process.argv.includes("--publish");
const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "artifacts/npm");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    if (options.capture) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

if (publish && run("git", ["status", "--porcelain"], { capture: true }).trim()) {
  throw new Error("Refusing to publish from a dirty Git working tree.");
}

run("pnpm", ["build"]);

const packedPackages = [];
for (const name of packages) {
  const packed = JSON.parse(run("pnpm", [
    "--dir",
    `packages/${name}`,
    "pack",
    "--pack-destination",
    output,
    "--json",
  ], { capture: true }));

  console.log(`Packed ${packed.name}@${packed.version}`);
  packedPackages.push(packed);
}

const versions = new Set(packedPackages.map(({ version }) => version));
if (versions.size !== 1) {
  throw new Error(`All packages must use one version; found ${[...versions].join(", ")}`);
}

if (publish) {
  for (const packed of packedPackages) {
    run("npm", ["publish", packed.filename, "--access", "public"]);
  }
}

console.log(publish ? "Published all QCCode packages." : `Packages are in ${output}`);
