import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mobileStudioVersion } from "../lib/version.js";

test("runtime version comes from package metadata", async () => {
  const metadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(mobileStudioVersion, metadata.version);
  assert.equal(mobileStudioVersion, "0.2.0-rc.1");
});
