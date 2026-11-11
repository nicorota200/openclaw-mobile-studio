import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadServerConfig } from "../lib/config.js";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "oms-config-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "allowed-root");
  const bin = join(dir, "bin");
  await mkdir(root);
  await mkdir(bin);
  const openclaw = join(bin, "openclaw");
  await writeFile(openclaw, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return { dir, root, bin, openclaw };
}

test("portable configuration discovers OpenClaw on PATH and normalizes explicit host settings", async (t) => {
  const item = await fixture(t);
  const config = await loadServerConfig({
    cwd: item.dir,
    env: {
      PATH: item.bin,
      HOST: "127.0.0.1",
      PORT: "0",
      MOBILE_STUDIO_FILE_ROOT: "allowed-root",
      MOBILE_STUDIO_AGENT_ID: "builder-2",
      MOBILE_STUDIO_PROJECT_ROOTS: "repos,workspace/projects,repos",
      MOBILE_STUDIO_WORKSPACE_PATH: "workspace",
      MOBILE_STUDIO_BASE_PATH: "/studio/",
      MOBILE_STUDIO_SESSION_POOL_SIZE: "3",
    },
  });

  assert.equal(config.fileRoot, item.root);
  assert.equal(config.openclawBin, item.openclaw);
  assert.equal(config.agentId, "builder-2");
  assert.equal(config.basePath, "/studio");
  assert.deepEqual(config.projectRoots, ["repos", "workspace/projects"]);
  assert.equal(config.workspacePath, "workspace");
  assert.equal(config.sessionPoolSize, 3);
  assert.equal(config.gitMode, "read");
});

test("startup configuration requires an explicit existing file root", async (t) => {
  const item = await fixture(t);
  await assert.rejects(
    loadServerConfig({ env: { PATH: item.bin }, cwd: item.dir }),
    /MOBILE_STUDIO_FILE_ROOT is required/,
  );
  await assert.rejects(
    loadServerConfig({ env: { PATH: item.bin, MOBILE_STUDIO_FILE_ROOT: "missing" }, cwd: item.dir }),
    /must be an existing readable directory/,
  );
});

test("startup configuration rejects public binds, escaping roots, invalid agents, and missing OpenClaw", async (t) => {
  const item = await fixture(t);
  const base = { PATH: item.bin, MOBILE_STUDIO_FILE_ROOT: item.root };
  await assert.rejects(loadServerConfig({ env: { ...base, HOST: "0.0.0.0" } }), /loopback-only/);
  await assert.rejects(
    loadServerConfig({ env: { ...base, MOBILE_STUDIO_PROJECT_ROOTS: "../outside" } }),
    /must stay inside/,
  );
  await assert.rejects(
    loadServerConfig({ env: { ...base, MOBILE_STUDIO_AGENT_ID: "bad:agent" } }),
    /MOBILE_STUDIO_AGENT_ID/,
  );
  await assert.rejects(
    loadServerConfig({ env: { ...base, PATH: join(item.dir, "empty") } }),
    /OpenClaw CLI not found or not executable/,
  );
});
