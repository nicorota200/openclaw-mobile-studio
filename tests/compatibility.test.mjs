import assert from "node:assert/strict";
import test from "node:test";
import {
  compareVersions,
  normalizedVersion,
  parseNumericVersion,
  supportedVersions,
  versionIsSupported,
} from "../lib/compatibility.js";

test("numeric versions are parsed and compared without lexical ordering bugs", () => {
  assert.deepEqual(parseNumericVersion("OpenClaw 2026.9.4 (abc)"), [2026, 9, 4]);
  assert.deepEqual(parseNumericVersion("v24.18.0"), [24, 18, 0]);
  assert.equal(normalizedVersion("git version 2.53.0"), "2.53.0");
  assert.equal(compareVersions([1, 104, 0], [1, 70, 0]), 1);
  assert.equal(compareVersions([2026, 9, 4], [2026, 9, 4]), 0);
});

test("the first product compatibility ranges are explicit and bounded where tested", () => {
  assert.equal(versionIsSupported("v22.19.0", supportedVersions.node), true);
  assert.equal(versionIsSupported("v24.99.0", supportedVersions.node), true);
  assert.equal(versionIsSupported("v25.0.0", supportedVersions.node), false);
  assert.equal(versionIsSupported("OpenClaw 2026.9.4", supportedVersions.openclaw), true);
  assert.equal(versionIsSupported("OpenClaw 2026.9.99", supportedVersions.openclaw), true);
  assert.equal(versionIsSupported("OpenClaw 2026.10.0", supportedVersions.openclaw), false);
  assert.equal(versionIsSupported("git version 2.39.0", supportedVersions.git), true);
  assert.equal(versionIsSupported("1.70.0", supportedVersions.tailscale), true);
});
