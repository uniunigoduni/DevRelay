import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface PackageMetadata { version?: unknown; }

const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
const metadata = JSON.parse(readFileSync(packagePath, "utf8")) as PackageMetadata;

if (typeof metadata.version !== "string" || !metadata.version.trim()) {
  throw new Error("DevRelay package version is missing or invalid.");
}

export const VERSION = metadata.version.trim();
