import { readFileSync } from "node:fs";

const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

if (typeof metadata.version !== "string" || !metadata.version.trim()) {
  throw new Error("package.json must contain a non-empty version.");
}

export const mobileStudioVersion = metadata.version;
