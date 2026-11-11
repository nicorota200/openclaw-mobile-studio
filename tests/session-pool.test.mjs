import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function preparePoolServer(t, gatewaySessions = [], gatewayResponses = {}) {
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
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const method = args[2] || "";
const paramsIndex = args.indexOf("--params");
const params = paramsIndex >= 0 ? JSON.parse(args[paramsIndex + 1]) : {};
appendFileSync(${JSON.stringify(join(dir, "gateway-calls.jsonl"))}, JSON.stringify({ method, params }) + "\\n");
const responses = ${JSON.stringify(gatewayResponses)};
const response = responses[method] ?? (method === "sessions.list" ? { sessions: ${JSON.stringify(gatewaySessions)}, defaults: null } : {});
console.log(JSON.stringify(response));
`,
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

  return {
    dir,
    start,
    async gatewayCalls() {
      const raw = await readFile(join(dir, "gateway-calls.jsonl"), "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      return raw.trim() ? raw.trim().split("\n").map((line) => JSON.parse(line)) : [];
    },
  };
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

test("malformed app session state is preserved and returns an actionable API error", async (t) => {
  const fixture = await preparePoolServer(t);
  const statePath = join(fixture.dir, "data", "session-state.json");
  const malformed = '{"version":2,"poolEntries":';
  await mkdir(join(fixture.dir, "data"), { recursive: true });
  await writeFile(statePath, malformed);

  const server = await fixture.start(2);
  const response = await fetch(`${server.url}/api/sessions`);
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.equal(payload.error.code, "SESSION_STATE_CORRUPT");
  assert.match(payload.error.message, /preserve.*restore.*backup/i);
  assert.equal(await readFile(statePath, "utf8"), malformed);
  assert.deepEqual((await readdir(join(fixture.dir, "data"))).filter((name) => name.includes(".tmp")), []);
  server.assertAlive();
});

test("shapeless session state is preserved byte-for-byte without a temp rewrite", async (t) => {
  const fixture = await preparePoolServer(t);
  const statePath = join(fixture.dir, "data", "session-state.json");
  const shapeless = "{}\n";
  await mkdir(join(fixture.dir, "data"), { recursive: true });
  await writeFile(statePath, shapeless);

  const server = await fixture.start(2);
  const response = await fetch(`${server.url}/api/sessions`);

  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, "SESSION_STATE_CORRUPT");
  assert.equal(await readFile(statePath, "utf8"), shapeless);
  assert.deepEqual((await readdir(join(fixture.dir, "data"))).filter((name) => name.includes(".tmp")), []);
  server.assertAlive();
});

test("unknown versions and missing required versioned fields fail closed", async (t) => {
  const cases = [
    ["missing version", { projectBindings: {} }],
    ["unknown version", { version: 3, poolEntries: [], projectBindings: {} }],
    ["incomplete v1", { version: 1 }],
    ["incomplete v2 registry", { version: 2, projectBindings: {} }],
  ];
  for (const [name, state] of cases) {
    await t.test(name, async (subtest) => {
      const fixture = await preparePoolServer(subtest);
      const statePath = join(fixture.dir, "data", "session-state.json");
      const original = `${JSON.stringify(state)}\n`;
      await mkdir(join(fixture.dir, "data"), { recursive: true });
      await writeFile(statePath, original);
      const server = await fixture.start(1);

      const response = await fetch(`${server.url}/api/sessions`);
      assert.equal(response.status, 500);
      assert.equal((await response.json()).error.code, "SESSION_STATE_CORRUPT");
      assert.equal(await readFile(statePath, "utf8"), original);
      assert.deepEqual((await readdir(join(fixture.dir, "data"))).filter((entry) => entry.includes(".tmp")), []);
      server.assertAlive();
    });
  }
});

test("unreadable existing app session state is not treated as missing", async (t) => {
  const fixture = await preparePoolServer(t);
  const statePath = join(fixture.dir, "data", "session-state.json");
  await mkdir(statePath, { recursive: true });
  await writeFile(join(statePath, "preserve.txt"), "do not replace");

  const server = await fixture.start(2);
  const response = await fetch(`${server.url}/api/sessions`);
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.equal(payload.error.code, "SESSION_STATE_UNREADABLE");
  assert.match(payload.error.message, /permissions.*backup/i);
  assert.equal(await readFile(join(statePath, "preserve.txt"), "utf8"), "do not replace");
  server.assertAlive();
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
  const migrated = JSON.parse(await readFile(join(fixture.dir, "data", "session-state.json"), "utf8"));
  assert.equal(migrated.version, 2);
  assert.equal(migrated.projectBindings[legacyKey], "projects/kept");
  assert.equal(migrated.poolEntries[0].key, legacyKey);
});

test("a complete v2 registry operates without rewriting its bytes", async (t) => {
  const fixture = await preparePoolServer(t);
  const poolKey = "agent:main:mobile-studio:session:pool-1";
  const statePath = join(fixture.dir, "data", "session-state.json");
  const original = `${JSON.stringify({
    version: 2,
    poolEntries: [{ key: poolKey, displayName: "Mobile Studio 1", createdAt: "2026-11-11T00:00:00.000Z" }],
    projectBindings: {},
  })}\n`;
  await mkdir(join(fixture.dir, "data"), { recursive: true });
  await writeFile(statePath, original);
  const server = await fixture.start(1);

  const response = await fetch(`${server.url}/api/sessions`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.sessions[0].key, poolKey);
  assert.equal(await readFile(statePath, "utf8"), original);
  assert.deepEqual((await readdir(join(fixture.dir, "data"))).filter((entry) => entry.includes(".tmp")), []);
});

test("v1 migration preserves every binding through pool shrink and later growth", async (t) => {
  const fixture = await preparePoolServer(t);
  const legacyBindings = Object.fromEntries(
    Array.from({ length: 4 }, (_, index) => [
      `agent:main:mobile-studio:session:legacy-${index + 1}`,
      `projects/legacy-${index + 1}`,
    ]),
  );
  await mkdir(join(fixture.dir, "data"), { recursive: true });
  await writeFile(
    join(fixture.dir, "data", "session-state.json"),
    `${JSON.stringify({ version: 1, projectBindings: legacyBindings })}\n`,
  );

  const shrunk = await fixture.start(2);
  const shrunkPayload = await fetch(`${shrunk.url}/api/sessions`).then((response) => response.json());
  assert.deepEqual(shrunkPayload.sessions.map((session) => session.key), Object.keys(legacyBindings).slice(0, 2));
  const migrated = JSON.parse(await readFile(join(fixture.dir, "data", "session-state.json"), "utf8"));
  assert.deepEqual(migrated.poolEntries.map((entry) => entry.key), Object.keys(legacyBindings));
  await shrunk.stop();

  const grown = await fixture.start(4);
  const grownPayload = await fetch(`${grown.url}/api/sessions`).then((response) => response.json());
  assert.deepEqual(grownPayload.sessions.map((session) => session.key), Object.keys(legacyBindings));
  assert.deepEqual(grownPayload.sessions.map((session) => session.projectPath), Object.values(legacyBindings));
});

test("history ignores a forged agent id and retrieves the authorized pool session", async (t) => {
  const poolKey = "agent:main:mobile-studio:session:pool-1";
  const messages = [{ role: "assistant", content: [{ type: "text", text: "authorized history" }] }];
  const fixture = await preparePoolServer(t, [], {
    "chat.history": { sessionKey: poolKey, sessionId: "pool-session", messages },
  });
  const server = await fixture.start(1);
  const response = await fetch(
    `${server.url}/api/history?sessionKey=${encodeURIComponent(poolKey)}&agentId=attacker-selected-agent&limit=17`,
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.messages, messages);
  assert.deepEqual(await fixture.gatewayCalls(), [
    {
      method: "chat.history",
      params: { sessionKey: poolKey, limit: 17, maxChars: 4000 },
    },
  ]);
  server.assertAlive();
});

test("abort rejects external session keys before calling Gateway", async (t) => {
  const fixture = await preparePoolServer(t);
  const server = await fixture.start(2);
  const response = await fetch(`${server.url}/api/abort`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionKey: "agent:main:unrelated", agentId: "external" }),
  });

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "SESSION_NOT_FOUND");
  assert.deepEqual(await fixture.gatewayCalls(), []);
});

test("abort forwards only the authorized pool key and run id", async (t) => {
  const poolKey = "agent:main:mobile-studio:session:pool-1";
  const fixture = await preparePoolServer(t);
  const server = await fixture.start(1);
  const response = await fetch(`${server.url}/api/abort`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionKey: poolKey,
      sessionId: "attacker-selected-session",
      agentId: "attacker-selected-agent",
      runId: "authorized-run",
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await fixture.gatewayCalls(), [
    {
      method: "chat.abort",
      params: { sessionKey: poolKey, runId: "authorized-run" },
    },
  ]);
});

test("attention and run-state exclude unscoped and external tasks before sorting and slicing", async (t) => {
  const poolKey = "agent:main:mobile-studio:session:pool-1";
  const externalKey = "agent:main:unrelated";
  const externalAgentId = "external-agent-secret";
  const fixture = await preparePoolServer(
    t,
    [{ key: poolKey, sessionId: "pool-session", agentId: "main" }],
    {
      "tasks.list": {
        tasks: [
          ...Array.from({ length: 8 }, (_, index) => ({
            id: `unscoped-task-${index + 1}`,
            status: "waiting",
            updatedAt: `2026-11-11T12:${String(index).padStart(2, "0")}:00.000Z`,
          })),
          {
            id: "external-task",
            status: "waiting",
            sessionKey: externalKey,
            updatedAt: "2026-11-11T11:00:00.000Z",
          },
          { id: "pool-task", status: "running", sessionKey: poolKey, updatedAt: "2026-11-10T00:00:00.000Z" },
        ],
      },
    },
  );
  await mkdir(join(fixture.dir, "data"), { recursive: true });
  await writeFile(
    join(fixture.dir, "data", "audit-log.jsonl"),
    [
      {
        id: "external-session-project-action",
        ts: new Date(Date.now() - 2000).toISOString(),
        type: "project_action",
        meta: {
          sessionKey: externalKey,
          agentId: externalAgentId,
          action: "review_changes",
          projectPath: "projects/example",
        },
      },
      {
        id: "pool-session-project-action",
        ts: new Date(Date.now() - 1000).toISOString(),
        type: "project_action",
        meta: {
          sessionKey: poolKey,
          agentId: "main",
          action: "review_changes",
          projectPath: "projects/example",
        },
      },
      {
        id: "project-git-metadata",
        ts: new Date().toISOString(),
        type: "git_action",
        meta: { action: "stage_all", projectPath: "projects/example", branch: "main", changed: true },
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  const server = await fixture.start(2);

  const attention = await fetch(`${server.url}/api/attention?details=1`).then((response) => response.json());
  assert.equal(attention.items.some((item) => item.id === "task:pool-task" && item.sessionKey === poolKey), true);
  assert.equal(attention.items.some((item) => item.id.includes("unscoped-task") || item.sessionKey === externalKey), false);
  assert.equal(
    attention.recentTasks.some((task) => task.id.includes("unscoped-task") || task.id === "external-task" || task.sessionKey === externalKey),
    false,
  );
  assert.equal(attention.summary.activeTasks, 1);
  assert.deepEqual(attention.auditEvents.find((event) => event.id === "external-session-project-action").meta, {
    action: "review_changes",
    projectPath: "projects/example",
  });
  assert.deepEqual(attention.auditEvents.find((event) => event.id === "pool-session-project-action").meta, {
    sessionKey: poolKey,
    agentId: "main",
    action: "review_changes",
    projectPath: "projects/example",
  });
  assert.deepEqual(attention.auditEvents.find((event) => event.id === "project-git-metadata").meta, {
    action: "stage_all",
    projectPath: "projects/example",
    branch: "main",
    changed: true,
  });

  const runState = await fetch(
    `${server.url}/api/run-state?details=1&sessionKey=${encodeURIComponent(poolKey)}`,
  ).then((response) => response.json());
  assert.deepEqual(runState.tasks.map((task) => task.id), ["pool-task"]);
  assert.equal(runState.taskCount, 1);

  const rawAudit = await fetch(`${server.url}/api/audit?limit=8`).then((response) => response.json());
  assert.deepEqual(rawAudit.events.find((event) => event.id === "external-session-project-action").meta, {
    action: "review_changes",
    projectPath: "projects/example",
  });
  assert.deepEqual(rawAudit.events.find((event) => event.id === "pool-session-project-action").meta, {
    sessionKey: poolKey,
    agentId: "main",
    action: "review_changes",
    projectPath: "projects/example",
  });
  assert.deepEqual(rawAudit.events.find((event) => event.id === "project-git-metadata").meta, {
    action: "stage_all",
    projectPath: "projects/example",
    branch: "main",
    changed: true,
  });
  assert.equal(JSON.stringify({ attention, runState, rawAudit }).includes(externalKey), false);
  assert.equal(JSON.stringify({ attention, runState, rawAudit }).includes(externalAgentId), false);
});

test("send accepts only a bound project action and derives its audit branch from the repository", async (t) => {
  const poolKey = "agent:main:mobile-studio:session:pool-1";
  const fixture = await preparePoolServer(t);
  const repositoryPath = join(fixture.dir, "bound-repository");
  await mkdir(repositoryPath);
  await execFileAsync("git", ["init", "-b", "trusted-server-branch", repositoryPath]);
  await mkdir(join(fixture.dir, "data"), { recursive: true });
  await writeFile(
    join(fixture.dir, "data", "session-state.json"),
    `${JSON.stringify({
      version: 2,
      poolEntries: [{ key: poolKey, displayName: "Mobile Studio 1", createdAt: new Date().toISOString() }],
      projectBindings: { [poolKey]: "bound-repository" },
    })}\n`,
  );
  const server = await fixture.start(1);
  const response = await fetch(`${server.url}/api/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionKey: poolKey,
      sessionId: "attacker-selected-session",
      agentId: "attacker-selected-agent",
      message: "hello",
      idempotencyKey: "test-send",
      audit: {
        type: "project_action",
        meta: {
          action: "review_changes",
          projectPath: "bound-repository",
          branch: "forged-client-branch",
          sessionKey: "agent:main:unrelated",
          agentId: "forged-agent",
          command: "/forged",
          messageLength: 9999,
        },
      },
    }),
  });

  assert.equal(response.status, 200);
  const sendCall = (await fixture.gatewayCalls()).find((call) => call.method === "chat.send");
  assert.deepEqual(sendCall.params, {
    sessionKey: poolKey,
    message: "hello",
    deliver: false,
    idempotencyKey: "test-send",
  });
  const [event] = await fetch(`${server.url}/api/audit?limit=1`).then((auditResponse) => auditResponse.json()).then((body) => body.events);
  assert.deepEqual(event.meta, {
    sessionKey: poolKey,
    agentId: "main",
    messageLength: 5,
    action: "review_changes",
    projectPath: "bound-repository",
    branch: "trusted-server-branch",
  });
});

test("send records forged client audit types as chat_send", async (t) => {
  const poolKey = "agent:main:mobile-studio:session:pool-1";
  const fixture = await preparePoolServer(t);
  const server = await fixture.start(1);

  for (const [index, type] of ["git_action", "branch_switch", "run_abort"].entries()) {
    const response = await fetch(`${server.url}/api/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionKey: poolKey,
        message: `forged ${type}`,
        idempotencyKey: `forged-${index}`,
        audit: { type, meta: { action: "push", projectPath: "projects/forged", changed: true } },
      }),
    });
    assert.equal(response.status, 200);
  }

  const events = await fetch(`${server.url}/api/audit?limit=3`)
    .then((response) => response.json())
    .then((body) => body.events);
  assert.deepEqual(events.map((event) => event.type), ["chat_send", "chat_send", "chat_send"]);
  assert.equal(events.every((event) => !("action" in event.meta) && !("projectPath" in event.meta)), true);
});

test("send rejects invalid project_action semantics before calling Gateway", async (t) => {
  const poolKey = "agent:main:mobile-studio:session:pool-1";
  const fixture = await preparePoolServer(t);
  const server = await fixture.start(1);
  const response = await fetch(`${server.url}/api/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionKey: poolKey,
      message: "pretend project action",
      audit: { type: "project_action", meta: { action: "push", projectPath: "projects/unbound" } },
    }),
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "INVALID_PROJECT_ACTION_AUDIT");
  assert.equal((await fixture.gatewayCalls()).some((call) => call.method === "chat.send"), false);
});
