import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadServerConfig } from "./config.js";
import { normalizedVersion, supportedVersions, versionIsSupported } from "./compatibility.js";

const execFileAsync = promisify(execFile);

async function defaultRun(command, args, { cwd, env, timeoutMs = 12000 } = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (error) {
    return {
      code: Number.isInteger(error.code) ? error.code : 1,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
      stderr: typeof error.stderr === "string" ? error.stderr : "",
      errorCode: typeof error.code === "string" ? error.code : "",
    };
  }
}

function result(id, status, message, hint = "") {
  return { id, status, message, ...(hint ? { hint } : {}) };
}

function versionResult(id, output, range) {
  const version = normalizedVersion(output);
  if (version === "unknown") {
    return result(id, "fail", `Could not parse ${id} version.`, `Expected ${range.label}.`);
  }
  if (!versionIsSupported(version, range)) {
    return result(id, "fail", `${id} ${version} is outside the supported range.`, `Install ${range.label}.`);
  }
  return result(id, "pass", `${id} ${version} (${range.label}).`);
}

function gatewayArgs(method, params) {
  return ["gateway", "call", method, "--json", "--params", JSON.stringify(params), "--timeout", "10000"];
}

export async function runDoctor({
  env = process.env,
  cwd = process.cwd(),
  platform = process.platform,
  nodeVersion = process.version,
  run = defaultRun,
} = {}) {
  const results = [];

  results.push(
    platform === "linux"
      ? result("platform", "pass", "Linux host detected.")
      : result("platform", "fail", `Unsupported platform ${platform}.`, "The first product target supports Linux only."),
  );
  results.push(versionResult("node", nodeVersion, supportedVersions.node));

  let config = null;
  try {
    config = await loadServerConfig({ env, cwd });
    results.push(
      result(
        "configuration",
        "pass",
        `Configuration is valid: loopback ${config.host}:${config.port}, agent ${config.agentId}, Git ${config.gitMode}.`,
      ),
    );
  } catch (error) {
    results.push(result("configuration", "fail", error.message));
  }

  if (config) {
    results.push(
      config.authToken
        ? result(
            "pwa-auth",
            "fail",
            "MOBILE_STUDIO_TOKEN is set, but the standard PWA does not submit bearer credentials.",
            "Leave MOBILE_STUDIO_TOKEN empty for the supported trusted-tailnet deployment.",
          )
        : result("pwa-auth", "pass", "Standard PWA access uses the trusted-tailnet boundary without a bearer token."),
    );

    const dataPath = join(cwd, "data");
    try {
      const info = await stat(dataPath).catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error)));
      await access(info ? dataPath : cwd, constants.W_OK | constants.X_OK);
      results.push(result("data-directory", "pass", info ? "Application data directory is writable." : "Application directory can create data/."));
    } catch {
      results.push(
        result(
          "data-directory",
          "fail",
          "The service account cannot write application state.",
          `Grant write access to ${dataPath} or its parent before starting the service.`,
        ),
      );
    }

    let presentProjectRoots = 0;
    for (const projectRoot of config.projectRoots) {
      try {
        const info = await stat(join(config.fileRoot, projectRoot));
        if (info.isDirectory()) presentProjectRoots += 1;
      } catch {
        // Missing configured roots are reported as one warning below.
      }
    }
    results.push(
      presentProjectRoots
        ? result("project-roots", "pass", `${presentProjectRoots}/${config.projectRoots.length} configured project root(s) exist.`)
        : result(
            "project-roots",
            "warn",
            "None of the configured project roots exists yet.",
            "Create one or adjust MOBILE_STUDIO_PROJECT_ROOTS; the file browser can still operate.",
          ),
    );
  }

  const git = await run("git", ["--version"], { cwd, env });
  results.push(
    git.code === 0
      ? versionResult("git", git.stdout, supportedVersions.git)
      : result("git", "fail", "Git is not executable from PATH.", `Install ${supportedVersions.git.label}.`),
  );

  if (config) {
    const openclawVersion = await run(config.openclawBin, ["--version"], { cwd, env });
    const openclawCheck =
      openclawVersion.code === 0
        ? versionResult("openclaw", openclawVersion.stdout, supportedVersions.openclaw)
        : result("openclaw", "fail", "The configured OpenClaw CLI could not run.", "Check OPENCLAW_BIN and service-account permissions.");
    results.push(openclawCheck);

    if (openclawCheck.status === "pass") {
      const probes = [
        ["health", {}],
        ["status", {}],
        ["sessions.list", { limit: 1 }],
      ];
      let gatewayOk = true;
      for (const [method, params] of probes) {
        const probe = await run(config.openclawBin, gatewayArgs(method, params), { cwd, env, timeoutMs: 15000 });
        if (probe.code !== 0) {
          gatewayOk = false;
          break;
        }
        try {
          JSON.parse(probe.stdout || "{}");
        } catch {
          gatewayOk = false;
          break;
        }
      }
      results.push(
        gatewayOk
          ? result("gateway", "pass", "Gateway health, status, and sessions.list probes passed.")
          : result(
              "gateway",
              "fail",
              "A required read-only Gateway probe failed.",
              "Start a compatible local OpenClaw Gateway and rerun doctor.",
            ),
      );
    }
  }

  const tailscaleVersion = await run("tailscale", ["version"], { cwd, env });
  const tailscaleCheck =
    tailscaleVersion.code === 0
      ? versionResult("tailscale", tailscaleVersion.stdout, supportedVersions.tailscale)
      : result("tailscale", "fail", "Tailscale is not executable from PATH.", `Install ${supportedVersions.tailscale.label}.`);
  results.push(tailscaleCheck);
  if (tailscaleCheck.status === "pass") {
    const status = await run("tailscale", ["status", "--json"], { cwd, env });
    let connected = false;
    if (status.code === 0) {
      try {
        const parsed = JSON.parse(status.stdout);
        connected = parsed.BackendState === "Running" && parsed.Self?.Online === true;
      } catch {
        connected = false;
      }
    }
    results.push(
      connected
        ? result("tailnet", "pass", "Tailscale is connected and this node is online.")
        : result("tailnet", "fail", "Tailscale is not connected as an online node.", "Connect the host to the private tailnet."),
    );

    const serve = await run("tailscale", ["serve", "status"], { cwd, env });
    const expectedPath = config?.basePath || "/mobile-studio";
    const serveReady = serve.code === 0 && serve.stdout.includes(expectedPath) && /tailnet only/i.test(serve.stdout);
    results.push(
      serveReady
        ? result("tailscale-serve", "pass", `A tailnet-only Serve route includes ${expectedPath}.`)
        : result(
            "tailscale-serve",
            "warn",
            `No confirmed tailnet-only Serve route for ${expectedPath}.`,
            "Configure Tailscale Serve after the local service is running; never use Funnel for this product mode.",
          ),
    );
  }

  const systemd = await run("systemctl", ["--user", "is-system-running"], { cwd, env });
  const systemdState = systemd.stdout.trim();
  results.push(
    systemd.code === 0 && systemdState === "running"
      ? result("systemd-user", "pass", "User systemd manager is running.")
      : systemdState === "degraded"
        ? result("systemd-user", "warn", "User systemd manager is degraded.", "Inspect failed user units before installation.")
        : result(
            "systemd-user",
            "fail",
            "User systemd manager is unavailable.",
            "The supported installation uses a user systemd service.",
          ),
  );

  const failures = results.filter((item) => item.status === "fail").length;
  const warnings = results.filter((item) => item.status === "warn").length;
  return {
    ok: failures === 0,
    summary: { checks: results.length, failures, warnings },
    compatibility: supportedVersions,
    results,
  };
}

export function renderDoctorReport(report) {
  const label = { pass: "PASS", warn: "WARN", fail: "FAIL" };
  const lines = report.results.flatMap((item) => [
    `${label[item.status]} ${item.id}: ${item.message}`,
    ...(item.hint ? [`  ${item.hint}`] : []),
  ]);
  lines.push(
    `Doctor ${report.ok ? "passed" : "failed"}: ${report.summary.checks} checks, ${report.summary.failures} failure(s), ${report.summary.warnings} warning(s).`,
  );
  return lines.join("\n");
}
