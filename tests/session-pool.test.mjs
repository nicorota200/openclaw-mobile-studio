import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

async function preparePoolServer(t, gatewaySessions = []) {
  const dir = await mkdtemp(join(tmpdir(), "oms-pool-test-"));
  const children = new Set();
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    }
    await rm(dir, { recursive: true, force: true });
  });
  const root = new URL("../", import.meta.url);
  await cp(new URL("server.js", root), join(dir, "server.mjs"));
  await cp(new URL("lib/", root), join(dir, "lib"), { recursive: true });
  await cp(new URL("public/", root), join(dir, "public"), { recursive: true });
  await writeFile(join(dir, "package.json"), '{"type":"module"}');
  await symlink(fileURLToPath(new URL("node_modules/", root)), join(dir, "node_modules"), "dir");
  await writeFile(
    join(dir, "fake-openclaw.mjs"),
    `#!/usr/bin/env node\nconsole.log(JSON.stringify({ sessions: ${JSON.stringify(gatewaySessions)}, defaults: null }));\n`,
    { mode: 0o755 },
  );
  await writeFile(
    join(dir, "start.mjs"),
    `import { Server } from 'node:http';
     const listen = Server.prototype.listen;
     Server.prototype.listen = function (...args) {
       this.once('listening', () => process.send({ port: this.address().port }));
       return listen.apply(this, args);
     };
     await import('./server.mjs');
    `,
  );

  async function start(poolSize = 5) {
    const child = spawn(process.execPath, [join(dir, "start.mjs")], {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        HOST: "127.0.0.1",
        PORT: "0",
        MOBILE_STUDIO_TOKEN: "",
        MOBILE_STUDIO_FILE_ROOT: dir,
        MOBILE_STUDIO_SESSION_POOL_SIZE: String(poolSize),
        OPENCLAW_BIN: join(dir, "fake-openclaw.mjs"),
        OPENCLAW_SESSIONS_DIR: join(dir, "gateway-sessions"),
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.add(child);
    let errors = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      errors += chunk;
    });
    const [address] = await once(child, "message", { signal: AbortSignal.timeout(5000) });
    return {
      child,
      url: `http://127.0.0.1:${address.port}`,
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, "exit");
        child.kill();
        await exited;
      },
      assertAlive() {
        assert.equal(child.exitCode, null, errors);
      },
    };
  }

  return { dir, start };
}

test("two concurrent first lists create one stable configured pool across restart", async (t) => {
  const exactKey = "agent:main:mobile-studio:session:pool-2";
  const fixture = await preparePoolServer(t, [
    { key: exactKey, sessionId: "gateway-two", agentId: "main", displayName: "Gateway title" },
    { key: "agent:main:unrelated", sessionId: "unrelated" },
  ]);
  const first = await fixture.start(5);
  const [left, right] = await Promise.all([
    fetch(`${first.url}/api/sessions`).then((response) => response.json()),
    fetch(`${first.url}/api/sessions`).then((response) => response.json()),
  ]);

  assert.deepEqual(left.sessions.map((session) => session.key), right.sessions.map((session) => session.key));
  assert.equal(left.sessions.length, 5);
  assert.equal(left.sessions.find((session) => session.key === exactKey)?.sessionId, "gateway-two");
  assert.equal(left.sessions.some((session) => session.key === "agent:main:unrelated"), false);
  const statePath = join(fixture.dir, "data", "session-state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.poolEntries.length, 5);
  const firstKeys = state.poolEntries.map((entry) => entry.key);
  assert.deepEqual((await readdir(join(fixture.dir, "data"))).filter((name) => name.includes(".tmp")), []);

  await first.stop();
  const restarted = await fixture.start(5);
  const afterRestart = await fetch(`${restarted.url}/api/sessions`).then((response) => response.json());
  assert.deepEqual(afterRestart.sessions.map((session) => session.key), firstKeys);
  restarted.assertAlive();
});

test("pool bootstrap and disabled mutations never alter Gateway-owned files", async (t) => {
  const fixture = await preparePoolServer(t);
  const gatewayDir = join(fixture.dir, "gateway-sessions");
  await mkdir(gatewayDir, { recursive: true });
  const indexPath = join(gatewayDir, "sessions.json");
  const transcriptPath = join(gatewayDir, "history.jsonl");
  await writeFile(indexPath, '{"sentinel":{"sessionId":"keep"}}\n');
  await writeFile(transcriptPath, "gateway history must stay here\n");
  const indexBefore = await stat(indexPath);
  const transcriptBefore = await stat(transcriptPath);
  const server = await fixture.start(3);

  assert.equal((await fetch(`${server.url}/api/sessions`)).status, 200);
  assert.equal((await fetch(`${server.url}/api/sessions`, { method: "POST", body: "{}" })).status, 405);
  assert.equal((await fetch(`${server.url}/api/sessions`, { method: "DELETE", body: "{}" })).status, 405);

  assert.equal(await readFile(indexPath, "utf8"), '{"sentinel":{"sessionId":"keep"}}\n');
  assert.equal(await readFile(transcriptPath, "utf8"), "gateway history must stay here\n");
  assert.equal((await stat(indexPath)).ino, indexBefore.ino);
  assert.equal((await stat(transcriptPath)).ino, transcriptBefore.ino);
  assert.deepEqual((await readdir(gatewayDir)).sort(), ["history.jsonl", "sessions.json"]);
  await assert.rejects(stat(join(fixture.dir, "data", "deleted-sessions")), { code: "ENOENT" });
  server.assertAlive();
});

test("v1 project bindings seed migration without deleting the binding", async (t) => {
  const fixture = await preparePoolServer(t);
  const legacyKey = "agent:main:mobile-studio:session:legacy-bound";
  await mkdir(join(fixture.dir, "data"), { recursive: true });
  await writeFile(
    join(fixture.dir, "data", "session-state.json"),
    `${JSON.stringify({ version: 1, projectBindings: { [legacyKey]: "projects/kept" } })}\n`,
  );
  const server = await fixture.start(2);
  const payload = await fetch(`${server.url}/api/sessions`).then((response) => response.json());
  assert.equal(payload.sessions[0].key, legacyKey);
  assert.equal(payload.sessions[0].projectPath, "projects/kept");
});
