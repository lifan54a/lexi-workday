import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const projectDir = dirname(fileURLToPath(import.meta.url));
const sourceDir = resolve(projectDir, "..", "public", "legacy");
const outputDir = resolve(projectDir, "dist");

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await cp(sourceDir, outputDir, { recursive: true });

console.log(`EdgeOne static assets copied to ${outputDir}`);
