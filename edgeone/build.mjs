import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const projectDir = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(projectDir, "..", "public");
const sourceDir = resolve(publicDir, "legacy");
const outputDir = resolve(projectDir, "dist");

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await cp(sourceDir, outputDir, { recursive: true });
await cp(resolve(publicDir, "favicon.ico"), resolve(outputDir, "favicon.ico"));
await cp(resolve(publicDir, "apple-touch-icon.png"), resolve(outputDir, "apple-touch-icon.png"));
await cp(resolve(publicDir, "icons"), resolve(outputDir, "icons"), { recursive: true });

console.log(`EdgeOne assets, runtime, and icons copied to ${outputDir}`);
