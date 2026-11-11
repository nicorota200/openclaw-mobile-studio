import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function command(command, args, options = {}) {
  return execFileAsync(command, args, { ...options, encoding: "utf8" });
}

async function prepareGitModeServer(t) {
  const dir = await mkdtemp(join(tmpdir(), "oms-git-mode-test-"));
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
    join(dir, "start.mjs"),
    `import { Server } from "node:http";
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  this.once("listening", () => process.send?.({ port: this.address().port }));
  return listen.apply(this, args);
};
await import("./server.mjs");
`,
  );

  const repository = join(dir, "repository");
  const remote = join(dir, "remote.git");
  const other = join(dir, "other");
  await mkdir(repository);
  await command("git", ["init", "-b", "main", repository]);
  await command("git", ["-C", repository, "config", "user.name", "Mobile Studio Test"]);
  await command("git", ["-C", repository, "config", "user.email", "mobile-studio@example.invalid"]);
  await writeFile(join(repository, "README.md"), "initial\n");
  await command("git", ["-C", repository, "add", "README.md"]);
  await command("git", ["-C", repository, "commit", "-m", "initial"]);
  await command("git", ["init", "--bare", remote]);
  await command("git", ["-C", repository, "remote", "add", "origin", remote]);
  await command("git", ["-C", repository, "push", "-u", "origin", "main"]);
  await command("git", ["-C", repository, "switch", "-c", "feature"]);
  await command("git", ["-C", repository, "push", "-u", "origin", "feature"]);
  await command("git", ["-C", repository, "switch", "main"]);

  const gitLog = join(dir, "git-calls.jsonl");
  const bin = join(dir, "bin");
  await mkdir(bin);
  const actualGit = (await command("sh", ["-c", "command -v git"])).stdout.trim();
  await writeFile(
    join(bin, "git"),
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
appendFileSync(${JSON.stringify(gitLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const result = spawnSync(${JSON.stringify(actualGit)}, process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );

  function spawnServer(gitMode) {
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: "0",
      MOBILE_STUDIO_TOKEN: "",
      MOBILE_STUDIO_FILE_ROOT: dir,
      OPENCLAW_BIN: "/bin/false",
    };
    if (gitMode !== undefined) env.MOBILE_STUDIO_GIT_MODE = gitMode;
    const child = spawn(process.execPath, [join(dir, "start.mjs")], {
      cwd: dir,
      env,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.add(child);
    let errors = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      errors += chunk;
    });
    return { child, errors: () => errors };
  }

  async function start(gitMode) {
    const running = spawnServer(gitMode);
    const [address] = await once(running.child, "message", { signal: AbortSignal.timeout(5000) });
    return {
      ...running,
      url: `http://127.0.0.1:${address.port}`,
      assertAlive() {
        assert.equal(running.child.exitCode, null, running.errors());
      },
    };
  }

  async function gitCalls() {
    const raw = await readFile(gitLog, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return raw.trim() ? raw.trim().split("\n").map((line) => JSON.parse(line)) : [];
  }

  return { dir, repository, remote, other, spawnServer, start, gitCalls };
}

async function post(url, path, body) {
  return fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("Git mode defaults to read and rejects mutation routes before parsing or running Git", async (t) => {
  const fixture = await prepareGitModeServer(t);
  const server = await fixture.start();

  const config = await fetch(`${server.url}/api/config`).then((response) => response.json());
  assert.equal(config.gitMode, "read");

  for (const path of ["/api/project/branch", "/api/project/git-action"]) {
    const response = await post(server.url, path, "not-json");
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "GIT_WRITES_DISABLED");
  }
  assert.deepEqual(await fixture.gitCalls(), []);

  const project = await fetch(`${server.url}/api/project?path=repository`).then((response) => response.json());
  assert.equal(project.ok, true);
  assert.equal(project.isRepo, true);
  const files = await fetch(`${server.url}/api/files?path=repository`).then((response) => response.json());
  assert.equal(files.ok, true);
  assert(files.entries.some((entry) => entry.name === "README.md"));
  assert((await fixture.gitCalls()).length > 0, "read-only Git inspection should remain available");

  const health = await fetch(`${server.url}/api/health`).then((response) => response.json());
  assert.equal(health.mobileStudio.gitMode, "read");
  server.assertAlive();
});

test("explicit read mode returns the stable disabled response", async (t) => {
  const fixture = await prepareGitModeServer(t);
  const server = await fixture.start("read");
  const response = await post(server.url, "/api/project/git-action", {
    path: "repository",
    action: "stage_all",
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "GIT_WRITES_DISABLED");
  assert.equal((await fetch(`${server.url}/api/config`).then((item) => item.json())).gitMode, "read");
});

test("invalid Git mode fails startup with an actionable error", async (t) => {
  const fixture = await prepareGitModeServer(t);
  const running = fixture.spawnServer("enabled");
  const [code] = await once(running.child, "exit", { signal: AbortSignal.timeout(5000) });
  assert.notEqual(code, 0);
  assert.match(running.errors(), /MOBILE_STUDIO_GIT_MODE must be "read" or "write"/);
  assert.match(running.errors(), /received "enabled"/);
});

test("write mode preserves guarded branch, stage, unstage, commit, push, pull, and audit behavior", async (t) => {
  const fixture = await prepareGitModeServer(t);
  const server = await fixture.start("write");
  assert.equal((await fetch(`${server.url}/api/config`).then((response) => response.json())).gitMode, "write");

  let response = await post(server.url, "/api/project/branch", { path: "repository", branch: "feature" });
  assert.equal(response.status, 200, await response.text());

  await writeFile(join(fixture.repository, "feature.txt"), "feature from Mobile Studio\n");
  response = await post(server.url, "/api/project/git-action", { path: "repository", action: "stage_all" });
  assert.equal(response.status, 200, await response.text());
  assert.match((await command("git", ["-C", fixture.repository, "status", "--porcelain"])).stdout, /^A  feature\.txt/m);

  response = await post(server.url, "/api/project/git-action", { path: "repository", action: "unstage_all" });
  assert.equal(response.status, 200, await response.text());
  assert.match((await command("git", ["-C", fixture.repository, "status", "--porcelain"])).stdout, /^\?\? feature\.txt/m);

  response = await post(server.url, "/api/project/git-action", { path: "repository", action: "stage_all" });
  assert.equal(response.status, 200, await response.text());
  response = await post(server.url, "/api/project/git-action", {
    path: "repository",
    action: "commit",
    message: "feature commit",
  });
  assert.equal(response.status, 200, await response.text());

  response = await post(server.url, "/api/project/git-action", { path: "repository", action: "push" });
  assert.equal(response.status, 200, await response.text());

  await command("git", ["clone", "--branch", "feature", fixture.remote, fixture.other]);
  await command("git", ["-C", fixture.other, "config", "user.name", "Remote Test"]);
  await command("git", ["-C", fixture.other, "config", "user.email", "remote@example.invalid"]);
  await writeFile(join(fixture.other, "remote.txt"), "remote update\n");
  await command("git", ["-C", fixture.other, "add", "remote.txt"]);
  await command("git", ["-C", fixture.other, "commit", "-m", "remote update"]);
  await command("git", ["-C", fixture.other, "push"]);
  await command("git", ["-C", fixture.repository, "fetch", "origin"]);

  response = await post(server.url, "/api/project/git-action", { path: "repository", action: "pull" });
  assert.equal(response.status, 200, await response.text());
  assert.equal((await readFile(join(fixture.repository, "remote.txt"), "utf8")), "remote update\n");

  const audit = await fetch(`${server.url}/api/audit?limit=20`).then((item) => item.json());
  assert(audit.events.some((event) => event.type === "branch_switch" && event.meta?.branch === "feature"));
  for (const action of ["stage_all", "unstage_all", "commit", "push", "pull"]) {
    assert(audit.events.some((event) => event.type === "git_action" && event.meta?.action === action), `missing ${action} audit event`);
  }
  server.assertAlive();
});
