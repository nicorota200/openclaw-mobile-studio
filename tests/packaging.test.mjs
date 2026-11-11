import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("systemd and environment templates use the documented portable layout", async () => {
  const [unit, environment] = await Promise.all([
    readFile(new URL("packaging/openclaw-mobile-studio.service", root), "utf8"),
    readFile(new URL("packaging/mobile-studio.env.example", root), "utf8"),
  ]);
  const parsed = parseEnv(environment);

  assert.match(unit, /WorkingDirectory=%h\/\.local\/share\/openclaw-mobile-studio\/app/);
  assert.match(unit, /EnvironmentFile=%h\/\.config\/openclaw-mobile-studio\/env/);
  assert.match(unit, /ExecStart=\/usr\/bin\/env npm run start/);
  assert.equal(parsed.HOST, "127.0.0.1");
  assert.equal(parsed.MOBILE_STUDIO_TOKEN, "");
  assert.equal(parsed.MOBILE_STUDIO_GIT_MODE, "read");
  assert.equal(parsed.MOBILE_STUDIO_BASE_PATH, "/mobile-studio");
  assert.match(parsed.OPENCLAW_BIN, /^\/absolute\/path/);
  assert.doesNotMatch(`${unit}\n${environment}`, /nicola-rota/);
});

test("operations guide covers every Phase 3 lifecycle requirement", async () => {
  const guide = await readFile(new URL("docs/OPERATIONS.md", root), "utf8");
  for (const heading of [
    "Supported versions",
    "Install",
    "Private Tailscale exposure",
    "Backup",
    "Upgrade",
    "Rollback",
    "Uninstall",
  ]) {
    assert.match(guide, new RegExp(`^## ${heading}$`, "m"), `missing ${heading}`);
  }
  assert.match(guide, /npm run doctor -- --env-file/);
  assert.match(guide, /Do not enable Funnel/);
});

test("independent installation protocol preserves the Phase 4 release gate", async () => {
  const protocol = await readFile(new URL("docs/INSTALLATION-TRIAL.md", root), "utf8");
  assert.match(protocol, /distinct compatible Linux OS instance/);
  assert.match(protocol, /do not satisfy the two-host release gate/);
  assert.match(protocol, /Separately provisioned virtual machines may count/);
  assert.match(protocol, /without editing application source/);
  assert.match(protocol, /approximately 30 minutes/);
  assert.match(protocol, /MOBILE_STUDIO_GIT_MODE=read/);
  assert.match(protocol, /release candidate may be tagged only after two passing records/i);
  assert.doesNotMatch(protocol, /nicola-rota/);
});

test("release notes remain explicitly gated before publication", async () => {
  const [changelog, releaseNotes] = await Promise.all([
    readFile(new URL("CHANGELOG.md", root), "utf8"),
    readFile(new URL("docs/RELEASE-NOTES-v0.2.0-rc.1.md", root), "utf8"),
  ]);
  assert.match(changelog, /^## \[0\.2\.0-rc\.1\] - Unreleased$/m);
  assert.match(changelog, /Two passing trials/);
  assert.match(releaseNotes, /Status: prepared, not tagged or released/);
  assert.match(releaseNotes, /must be created only after the two installation records pass/);
});
