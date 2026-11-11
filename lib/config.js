import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, relative, resolve, sep } from "node:path";

function integerEnv(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function gitModeEnv(env) {
  const raw = env.MOBILE_STUDIO_GIT_MODE;
  if (raw === undefined || raw === "") return "read";
  if (raw === "read" || raw === "write") return raw;
  throw new Error(
    `MOBILE_STUDIO_GIT_MODE must be "read" or "write"; received ${JSON.stringify(raw)}. ` +
      "Use read (the default) to block Git mutations or write to enable guarded Git actions.",
  );
}

function agentIdEnv(env) {
  const value = (env.MOBILE_STUDIO_AGENT_ID || "main").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new Error(
      "MOBILE_STUDIO_AGENT_ID must be 1-64 characters, start with a letter or digit, and contain only letters, digits, '.', '_' or '-'.",
    );
  }
  return value;
}

function basePathEnv(env) {
  const raw = (env.MOBILE_STUDIO_BASE_PATH || "/mobile-studio").trim();
  if (!raw.startsWith("/") || raw.includes("?") || raw.includes("#") || raw.includes("\\")) {
    throw new Error("MOBILE_STUDIO_BASE_PATH must be an absolute URL path such as /mobile-studio.");
  }
  const segments = raw.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("MOBILE_STUDIO_BASE_PATH must not contain '.' or '..' path segments.");
  }
  return segments.length ? `/${segments.join("/")}` : "/";
}

function assertRelativePath(name, value, fileRoot) {
  if (!value || value.includes("\0") || isAbsolute(value)) {
    throw new Error(`${name} entries must be non-empty paths relative to MOBILE_STUDIO_FILE_ROOT.`);
  }
  const absolute = resolve(fileRoot, value);
  const fromRoot = relative(fileRoot, absolute);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${name} entry ${JSON.stringify(value)} must stay inside MOBILE_STUDIO_FILE_ROOT.`);
  }
  return fromRoot.split(sep).join("/");
}

function relativePathListEnv(env, name, fallback, fileRoot) {
  const raw = env[name] === undefined ? fallback : env[name];
  const values = String(raw)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => assertRelativePath(name, value, fileRoot));
  if (values.length === 0) throw new Error(`${name} must contain at least one relative path.`);
  return [...new Set(values)];
}

function optionalRelativePathEnv(env, name, fallback, fileRoot) {
  const raw = env[name] === undefined ? fallback : env[name];
  const value = String(raw).trim();
  return value ? assertRelativePath(name, value, fileRoot) : "";
}

async function executablePath(command, pathValue, cwd) {
  const candidates = command.includes("/")
    ? [isAbsolute(command) ? command : resolve(cwd, command)]
    : String(pathValue || "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => resolve(directory, command));

  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Try the next PATH entry.
    }
  }
  return "";
}

export async function loadServerConfig({ env = process.env, cwd = process.cwd() } = {}) {
  const host = env.HOST || "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error(
      `HOST must be loopback-only for trusted-tailnet mode; received ${JSON.stringify(host)}. Use 127.0.0.1 and expose it privately through Tailscale Serve.`,
    );
  }

  const configuredRoot = String(env.MOBILE_STUDIO_FILE_ROOT || "").trim();
  if (!configuredRoot) {
    throw new Error(
      "MOBILE_STUDIO_FILE_ROOT is required. Set it to the narrowest directory Mobile Studio may browse, for example /home/your-user.",
    );
  }
  const requestedRoot = resolve(cwd, configuredRoot);
  let fileRoot;
  try {
    const info = await stat(requestedRoot);
    if (!info.isDirectory()) throw new Error("not a directory");
    await access(requestedRoot, constants.R_OK | constants.X_OK);
    fileRoot = await realpath(requestedRoot);
  } catch (error) {
    throw new Error(
      `MOBILE_STUDIO_FILE_ROOT must be an existing readable directory; could not use ${JSON.stringify(requestedRoot)} (${error.message}).`,
    );
  }

  const requestedOpenClaw = String(env.OPENCLAW_BIN || "openclaw").trim();
  const openclawBin = requestedOpenClaw ? await executablePath(requestedOpenClaw, env.PATH, cwd) : "";
  if (!openclawBin) {
    throw new Error(
      `OpenClaw CLI not found or not executable (${JSON.stringify(requestedOpenClaw || "openclaw")}). Set OPENCLAW_BIN to its executable path or add openclaw to PATH.`,
    );
  }

  return {
    host,
    port: integerEnv(env, "PORT", 8787, 0, 65535),
    authToken: env.MOBILE_STUDIO_TOKEN || "",
    gitMode: gitModeEnv(env),
    fileRoot,
    openclawBin,
    agentId: agentIdEnv(env),
    basePath: basePathEnv(env),
    projectRoots: relativePathListEnv(
      env,
      "MOBILE_STUDIO_PROJECT_ROOTS",
      "projects,.openclaw/workspace/projects",
      fileRoot,
    ),
    workspacePath: optionalRelativePathEnv(
      env,
      "MOBILE_STUDIO_WORKSPACE_PATH",
      ".openclaw/workspace",
      fileRoot,
    ),
    sessionPoolSize: integerEnv(env, "MOBILE_STUDIO_SESSION_POOL_SIZE", 5, 1, 20),
  };
}
