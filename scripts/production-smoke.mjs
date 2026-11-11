#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForJson(url, child, output) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Mobile Studio exited before the smoke probe.\n${output()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return await response.json();
    } catch {
      // The server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}.\n${output()}`);
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "mobile-studio-production-smoke-"));
const fileRoot = join(temporaryRoot, "files");
const fakeOpenClaw = join(temporaryRoot, "openclaw-fixture.mjs");
let child;
let stdout = "";
let stderr = "";

try {
  await mkdir(join(fileRoot, "projects"), { recursive: true });
  await writeFile(
    fakeOpenClaw,
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) console.log('OpenClaw 2026.9.4');",
      "else if (process.argv[2] === 'gateway' && process.argv[3] === 'call') console.log(JSON.stringify({ ok: true }));",
      "else process.exitCode = 2;",
      "",
    ].join("\n"),
  );
  await chmod(fakeOpenClaw, 0o755);

  const port = await availablePort();
  child = spawn(process.execPath, [join(projectRoot, "server.js")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      OPENCLAW_BIN: fakeOpenClaw,
      MOBILE_STUDIO_FILE_ROOT: fileRoot,
      MOBILE_STUDIO_PROJECT_ROOTS: "projects",
      MOBILE_STUDIO_WORKSPACE_PATH: "",
      MOBILE_STUDIO_GIT_MODE: "read",
      MOBILE_STUDIO_BASE_PATH: "/mobile-studio",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-16_384);
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });
  const output = () => `${stdout}${stderr}`.trim();

  const mountedUrl = `http://127.0.0.1:${port}/mobile-studio`;
  const health = await waitForJson(`${mountedUrl}/api/health`, child, output);
  assert(health.ok === true, "production health probe did not confirm the fixture Gateway");
  assert(health.mobileStudio?.version === "0.2.0-rc.1", "production health probe reported the wrong version");
  assert(health.mobileStudio?.gitMode === "read", "production smoke did not start in Git read mode");
  assert(health.mobileStudio?.basePath === "/mobile-studio", "production smoke used the wrong base path");

  const configResponse = await fetch(`${mountedUrl}/api/config`, { signal: AbortSignal.timeout(2_000) });
  const config = await configResponse.json();
  assert(configResponse.ok && config.ok, "production config endpoint failed");
  assert(config.gitMode === "read", "production config endpoint did not report Git read mode");

  const pageResponse = await fetch(`${mountedUrl}/`, { signal: AbortSignal.timeout(2_000) });
  const page = await pageResponse.text();
  assert(pageResponse.ok && /OpenClaw Mobile Studio/i.test(page), "mounted production frontend did not load");

  console.log("production smoke ok: production dependencies, mounted frontend, health, config, and Git read default");
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}
