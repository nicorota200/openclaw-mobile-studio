import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { renderDoctorReport, runDoctor } from "../lib/doctor.js";

async function doctorFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "oms-doctor-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "home");
  const openclaw = join(dir, "openclaw");
  await mkdir(join(root, "projects"), { recursive: true });
  await writeFile(openclaw, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = {
    PATH: "/test/bin",
    MOBILE_STUDIO_FILE_ROOT: root,
    OPENCLAW_BIN: openclaw,
    MOBILE_STUDIO_TOKEN: "must-not-appear-in-doctor-output",
  };
  return { dir, root, openclaw, env };
}

function successfulRun(openclaw, { openclawVersion = "OpenClaw 2026.9.4 (test)", serve = true } = {}) {
  return async (command, args) => {
    const name = basename(command);
    if (command === openclaw && args[0] === "--version") return { code: 0, stdout: `${openclawVersion}\n`, stderr: "" };
    if (command === openclaw && args[0] === "gateway") return { code: 0, stdout: '{"ok":true}\n', stderr: "" };
    if (name === "git") return { code: 0, stdout: "git version 2.53.0\n", stderr: "" };
    if (name === "tailscale" && args[0] === "version") return { code: 0, stdout: "1.104.4\n", stderr: "" };
    if (name === "tailscale" && args[0] === "status") {
      return { code: 0, stdout: '{"BackendState":"Running","Self":{"Online":true}}', stderr: "" };
    }
    if (name === "tailscale" && args[0] === "serve") {
      return { code: 0, stdout: serve ? "https://node.example.ts.net (tailnet only)\n|-- /mobile-studio proxy\n" : "No serve config\n", stderr: "" };
    }
    if (name === "systemctl") return { code: 0, stdout: "running\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  };
}

test("doctor passes compatible prerequisites and never emits configured secrets", async (t) => {
  const fixture = await doctorFixture(t);
  const report = await runDoctor({
    env: fixture.env,
    cwd: fixture.dir,
    platform: "linux",
    nodeVersion: "v24.18.0",
    run: successfulRun(fixture.openclaw),
  });
  assert.equal(report.ok, true);
  assert.equal(report.summary.failures, 0);
  assert(report.results.some((item) => item.id === "gateway" && item.status === "pass"));
  assert(report.results.some((item) => item.id === "tailscale-serve" && item.status === "pass"));
  assert.doesNotMatch(JSON.stringify(report), /must-not-appear-in-doctor-output/);
  assert.match(renderDoctorReport(report), /Doctor passed/);
});

test("doctor fails unsupported OpenClaw and keeps missing Serve routing as a warning", async (t) => {
  const fixture = await doctorFixture(t);
  const report = await runDoctor({
    env: fixture.env,
    cwd: fixture.dir,
    platform: "linux",
    nodeVersion: "v24.18.0",
    run: successfulRun(fixture.openclaw, { openclawVersion: "OpenClaw 2026.10.0", serve: false }),
  });
  assert.equal(report.ok, false);
  assert(report.results.some((item) => item.id === "openclaw" && item.status === "fail"));
  assert.equal(report.results.some((item) => item.id === "gateway"), false);
  assert(report.results.some((item) => item.id === "tailscale-serve" && item.status === "warn"));
});
