import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readAuditEvents, writeAuditEventQuiet } from "./lib/audit.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = resolve(__dirname, "public");
const dataDir = resolve(__dirname, "data");
const auditLogPath = join(dataDir, "audit-log.jsonl");

const host = process.env.HOST || "127.0.0.1";
const port = Number.parseInt(process.env.PORT || "8787", 10);
const authToken = process.env.MOBILE_STUDIO_TOKEN || "";
const openclawBin = process.env.OPENCLAW_BIN || "/home/nicola-rota/.npm-global/bin/openclaw";
const openclawSessionsDir =
  process.env.OPENCLAW_SESSIONS_DIR || "/home/nicola-rota/.openclaw/agents/main/sessions";
const openclawSessionsIndex = join(openclawSessionsDir, "sessions.json");
const defaultLimit = 80;
const maxChars = 4000;
const fileRoot = resolve(process.env.MOBILE_STUDIO_FILE_ROOT || "/home/nicola-rota");
const filePreviewLimit = 200 * 1024;
const diffPreviewLimit = 80_000;
const mountPrefixes = ["/mobile-studio"];

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
]);

const textExtensions = new Set([
  ".c",
  ".conf",
  ".cpp",
  ".css",
  ".csv",
  ".env",
  ".go",
  ".h",
  ".html",
  ".ini",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".mjs",
  ".py",
  ".rs",
  ".sh",
  ".sql",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const sensitiveNamePatterns = [
  /^\.env($|\.)/i,
  /^id_.*$/i,
  /^authorized_keys$/i,
  /^known_hosts$/i,
  /(^|[._-])(secret|token|password|passwd|credential|credentials|private-key|apikey|api-key)([._-]|$)/i,
  /\.(pem|key|p12|pfx|crt|cer|kdbx|sqlite|db)$/i,
];

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

function sendError(res, status, code, message, details) {
  sendJson(res, status, { ok: false, error: { code, message, details } });
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 128 * 1024) {
        req.destroy();
        rejectBody(new Error("request body too large"));
      }
    });
    req.on("end", () => resolveBody(data));
    req.on("error", rejectBody);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function requireAuth(req, res) {
  if (!authToken) return true;
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token === authToken) return true;
  sendError(res, 401, "UNAUTHORIZED", "Missing or invalid Mobile Studio token.");
  return false;
}

function runOpenClaw(args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(openclawBin, args, {
      cwd: __dirname,
      env: {
        ...process.env,
        PATH: [
          "/home/nicola-rota/.npm-global/bin",
          process.env.PATH || "",
        ]
          .filter(Boolean)
          .join(":"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectRun(new Error(`openclaw timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectRun(new Error(stderr.trim() || stdout.trim() || `openclaw exited ${code}`));
        return;
      }
      resolveRun(stdout.trim());
    });
  });
}

function runCommand(command, args, { cwd = __dirname, timeoutMs = 10000, maxOutput = 80_000 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectRun(new Error(`${command} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > maxOutput) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > maxOutput) child.kill("SIGTERM");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectRun(new Error(stderr.trim() || stdout.trim() || `${command} exited ${code}`));
        return;
      }
      resolveRun(stdout.trim());
    });
  });
}

async function gatewayCall(method, params = {}, options = {}) {
  const args = ["gateway", "call", method, "--json", "--params", JSON.stringify(params)];
  if (options.expectFinal) args.push("--expect-final");
  if (options.timeoutMs) args.push("--timeout", String(options.timeoutMs));
  const stdout = await runOpenClaw(args, { timeoutMs: options.processTimeoutMs || options.timeoutMs || 15000 });
  return stdout ? JSON.parse(stdout) : {};
}

async function getHealth() {
  const [healthResult, statusResult] = await Promise.allSettled([
    gatewayCall("health", {}, { timeoutMs: 10000 }),
    gatewayCall("status", {}, { timeoutMs: 10000 }),
  ]);
  const health = healthResult.status === "fulfilled" ? healthResult.value : null;
  const status = statusResult.status === "fulfilled" ? statusResult.value : null;
  return {
    ok: healthResult.status === "fulfilled" && statusResult.status === "fulfilled",
    mobileStudio: {
      version: "0.1.0",
      auth: authToken ? "token" : "disabled-loopback-only",
      host,
      port,
      fileRoot,
    },
    gateway: {
      health,
      status,
      errors: {
        health: healthResult.status === "rejected" ? String(healthResult.reason?.message || healthResult.reason) : null,
        status: statusResult.status === "rejected" ? String(statusResult.reason?.message || statusResult.reason) : null,
      },
    },
  };
}

async function resolveInsideFileRoot(inputPath = "") {
  const relativePath = String(inputPath || "").replace(/^[/\\]+/, "");
  const candidate = resolve(fileRoot, relativePath);
  let rootReal;
  try {
    rootReal = await realpath(fileRoot);
  } catch {
    rootReal = fileRoot;
  }
  let candidateReal;
  try {
    candidateReal = await realpath(candidate);
  } catch {
    const parentReal = await realpath(resolve(candidate, ".."));
    candidateReal = resolve(parentReal, basename(candidate));
  }
  if (candidateReal !== rootReal && !candidateReal.startsWith(`${rootReal}${sep}`)) {
    return { ok: false, status: 403, code: "FORBIDDEN_PATH", message: "Path is outside the Mobile Studio file root." };
  }
  return {
    ok: true,
    rootReal,
    absolutePath: candidateReal,
    displayPath: candidateReal === rootReal ? "" : relative(rootReal, candidateReal),
  };
}

function formatFileType(info, linkInfo) {
  if (info.isSymbolicLink()) {
    if (!linkInfo) return "symlink";
    if (linkInfo.isDirectory()) return "directory";
    if (linkInfo.isFile()) return "file";
    return "symlink";
  }
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  return "other";
}

function isSensitivePreviewName(name) {
  return sensitiveNamePatterns.some((pattern) => pattern.test(name));
}

function isTextPreviewable(name) {
  return textExtensions.has(extname(name).toLowerCase());
}

function parseStatusHeader(line = "") {
  const clean = line.replace(/^##\s*/, "");
  const [branchPart = "", trackingPart = ""] = clean.split("...");
  const tracking = trackingPart.split(" ")[0] || "";
  const ahead = Number((line.match(/ahead\s+(\d+)/) || [])[1] || 0);
  const behind = Number((line.match(/behind\s+(\d+)/) || [])[1] || 0);
  return {
    branch: branchPart || "",
    tracking,
    ahead,
    behind,
  };
}

function parseStatusEntry(line) {
  const code = line.slice(0, 2);
  const rawPath = line.slice(3).trim() || line.trim();
  const path = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) : rawPath;
  const staged = code[0] && code[0] !== " " && code[0] !== "?";
  const unstaged = code[1] && code[1] !== " " && code[1] !== "?";
  const untracked = code === "??";
  return {
    code: code.trim() || "?",
    path,
    rawPath,
    staged,
    unstaged,
    untracked,
  };
}

function parseNumstat(output) {
  const totals = new Map();
  for (const line of String(output || "").split("\n")) {
    if (!line.trim()) continue;
    const [addedRaw = "0", deletedRaw = "0", ...pathParts] = line.split("\t");
    const path = pathParts.join("\t");
    if (!path) continue;
    const previous = totals.get(path) || { added: 0, deleted: 0, binary: false };
    const added = Number.parseInt(addedRaw, 10);
    const deleted = Number.parseInt(deletedRaw, 10);
    totals.set(path, {
      added: previous.added + (Number.isFinite(added) ? added : 0),
      deleted: previous.deleted + (Number.isFinite(deleted) ? deleted : 0),
      binary: previous.binary || addedRaw === "-" || deletedRaw === "-",
    });
  }
  return totals;
}

async function countUntrackedLines(rootReal, filePath) {
  const absolutePath = resolve(rootReal, filePath);
  const rootWithSep = `${rootReal}${sep}`;
  if (absolutePath !== rootReal && !absolutePath.startsWith(rootWithSep)) return null;
  const info = await stat(absolutePath).catch(() => null);
  if (!info?.isFile() || info.size > filePreviewLimit || isSensitivePreviewName(basename(absolutePath))) return null;
  if (!isTextPreviewable(basename(absolutePath))) return null;
  const content = await readFile(absolutePath, "utf8").catch(() => null);
  if (content === null) return null;
  if (!content) return 0;
  return content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length;
}

async function getChangeStats(rootReal, entries) {
  const [workingRaw, stagedRaw] = await Promise.all([
    runCommand("git", ["-C", rootReal, "diff", "--numstat"], { timeoutMs: 5000, maxOutput: diffPreviewLimit }).catch(() => ""),
    runCommand("git", ["-C", rootReal, "diff", "--cached", "--numstat"], { timeoutMs: 5000, maxOutput: diffPreviewLimit }).catch(
      () => "",
    ),
  ]);
  const totals = parseNumstat(`${workingRaw}\n${stagedRaw}`);
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.untracked || totals.has(entry.path)) return;
      const lines = await countUntrackedLines(rootReal, entry.path);
      if (lines !== null) totals.set(entry.path, { added: lines, deleted: 0, binary: false });
    }),
  );
  return totals;
}

function parseCommitLog(log) {
  return log
    ? log.split("\n").filter(Boolean).map((line) => {
        const [hash = "", date = "", author = "", refs = "", ...subjectParts] = line.split("\t");
        return {
          hash,
          date,
          author,
          refs: refs.trim(),
          subject: subjectParts.join("\t"),
        };
      })
    : [];
}

async function getRepoRootFromPath(displayPath = "") {
  const resolved = await resolveInsideFileRoot(displayPath);
  if (!resolved.ok) return resolved;
  const info = await stat(resolved.absolutePath);
  const cwd = info.isDirectory() ? resolved.absolutePath : resolve(resolved.absolutePath, "..");
  let root;
  try {
    root = await runCommand("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeoutMs: 5000 });
  } catch {
    return {
      ok: true,
      isRepo: false,
      path: resolved.displayPath,
    };
  }
  const rootReal = await realpath(root);
  if (rootReal !== resolved.rootReal && !rootReal.startsWith(`${resolved.rootReal}${sep}`)) {
    return { ok: false, status: 403, code: "FORBIDDEN_REPO", message: "Git repository is outside the file root." };
  }
  return {
    ok: true,
    isRepo: true,
    rootReal,
    rootDisplayPath: relative(resolved.rootReal, rootReal),
    path: resolved.displayPath,
    root: resolved.rootReal,
  };
}

async function listFiles(url) {
  const resolved = await resolveInsideFileRoot(url.searchParams.get("path") || "");
  if (!resolved.ok) return resolved;
  const showHidden = url.searchParams.get("showHidden") === "1";
  const info = await stat(resolved.absolutePath);
  if (!info.isDirectory()) {
    return { ok: false, status: 400, code: "NOT_DIRECTORY", message: "Path is not a directory." };
  }
  const dirents = await readdir(resolved.absolutePath, { withFileTypes: true });
  const entries = await Promise.all(
    dirents.map(async (dirent) => {
      const absoluteEntryPath = join(resolved.absolutePath, dirent.name);
      const entryPath = relative(resolved.rootReal, absoluteEntryPath);
      let infoForEntry;
      let linkInfo = null;
      try {
        infoForEntry = await lstat(absoluteEntryPath);
        if (infoForEntry.isSymbolicLink()) {
          const target = await realpath(absoluteEntryPath);
          if (target === resolved.rootReal || target.startsWith(`${resolved.rootReal}${sep}`)) {
            linkInfo = await stat(absoluteEntryPath);
          }
        }
      } catch {
        return null;
      }
      const type = formatFileType(infoForEntry, linkInfo);
      const accessible = !infoForEntry.isSymbolicLink() || Boolean(linkInfo);
      return {
        name: dirent.name,
        path: entryPath,
        type,
        isSymlink: infoForEntry.isSymbolicLink(),
        accessible,
        size: type === "file" ? infoForEntry.size : null,
        modifiedAt: infoForEntry.mtime.toISOString(),
        previewable:
          type === "file" &&
          accessible &&
          infoForEntry.size <= filePreviewLimit &&
          isTextPreviewable(dirent.name) &&
          !isSensitivePreviewName(dirent.name),
      };
    }),
  );
  const visibleEntries = entries
    .filter(Boolean)
    .filter((entry) => showHidden || !entry.name.startsWith("."))
    .sort((a, b) => {
      if (a.type === "directory" && b.type !== "directory") return -1;
      if (a.type !== "directory" && b.type === "directory") return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
  return {
    ok: true,
    root: fileRoot,
    path: resolved.displayPath,
    showHidden,
    entries: visibleEntries,
  };
}

async function previewFile(url) {
  const resolved = await resolveInsideFileRoot(url.searchParams.get("path") || "");
  if (!resolved.ok) return resolved;
  const info = await stat(resolved.absolutePath);
  const name = basename(resolved.absolutePath);
  if (!info.isFile()) {
    return { ok: false, status: 400, code: "NOT_FILE", message: "Path is not a file." };
  }
  if (info.size > filePreviewLimit) {
    return { ok: false, status: 413, code: "FILE_TOO_LARGE", message: "Preview is limited to 200 KB." };
  }
  if (!isTextPreviewable(name)) {
    return { ok: false, status: 415, code: "UNSUPPORTED_PREVIEW", message: "Preview is available for text files only." };
  }
  if (isSensitivePreviewName(name)) {
    return {
      ok: false,
      status: 403,
      code: "SENSITIVE_PREVIEW_BLOCKED",
      message: "Preview is blocked for files that commonly contain secrets.",
    };
  }
  const body = await readFile(resolved.absolutePath, "utf8");
  return {
    ok: true,
    path: resolved.displayPath,
    name,
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
    content: body,
  };
}

async function getGitInfo(url) {
  const repo = await getRepoRootFromPath(url.searchParams.get("path") || "");
  if (!repo.ok || !repo.isRepo) return repo;
  const rootReal = repo.rootReal;
  const [branch, status, log, remotes, localBranchesRaw, remoteBranchesRaw] = await Promise.all([
    runCommand("git", ["-C", rootReal, "branch", "--show-current"], { timeoutMs: 5000 }).catch(() => ""),
    runCommand("git", ["-C", rootReal, "status", "--short", "--branch"], { timeoutMs: 5000 }).catch((error) =>
      error.message,
    ),
    runCommand("git", ["-C", rootReal, "log", "--date=short", "--pretty=format:%h%x09%ad%x09%an%x09%d%x09%s", "--max-count=30"], {
      timeoutMs: 5000,
    }).catch(() => ""),
    runCommand("git", ["-C", rootReal, "remote", "-v"], { timeoutMs: 5000 }).catch(() => ""),
    runCommand("git", ["-C", rootReal, "branch", "--format=%(refname:short)"], { timeoutMs: 5000 }).catch(() => ""),
    runCommand("git", ["-C", rootReal, "branch", "-r", "--format=%(refname:short)"], { timeoutMs: 5000 }).catch(() => ""),
  ]);
  const statusLines = status ? status.split("\n") : [];
  const header = parseStatusHeader(statusLines.find((line) => line.startsWith("##")) || "");
  const statusEntries = statusLines
    .filter((line) => !line.startsWith("##"))
    .map(parseStatusEntry);
  const commits = parseCommitLog(log);
  return {
    ok: true,
    isRepo: true,
    path: repo.path,
    repositoryPath: repo.rootDisplayPath,
    repositoryName: basename(rootReal),
    branch: branch || header.branch || "detached",
    tracking: header.tracking,
    ahead: header.ahead,
    behind: header.behind,
    statusLines,
    statusEntries,
    commits,
    remotes: remotes ? Array.from(new Set(remotes.split("\n").filter(Boolean))) : [],
    branches: {
      local: localBranchesRaw ? localBranchesRaw.split("\n").filter(Boolean).sort() : [],
      remote: remoteBranchesRaw
        ? remoteBranchesRaw
            .split("\n")
            .filter((line) => line && !line.includes(" -> "))
            .sort()
        : [],
    },
  };
}

async function listProjects() {
  const projectsDir = resolve(fileRoot, "projects");
  const resolved = await resolveInsideFileRoot("projects");
  if (!resolved.ok) return resolved;
  let dirents;
  try {
    dirents = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return { ok: true, root: fileRoot, projects: [] };
  }
  const projects = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;
    const absolutePath = join(projectsDir, dirent.name);
    try {
      await stat(join(absolutePath, ".git"));
      const status = await runCommand("git", ["-C", absolutePath, "status", "--short", "--branch"], { timeoutMs: 5000 }).catch(
        () => "",
      );
      const lines = status ? status.split("\n") : [];
      const header = parseStatusHeader(lines.find((line) => line.startsWith("##")) || "");
      projects.push({
        name: dirent.name,
        path: `projects/${dirent.name}`,
        branch: header.branch || "",
        tracking: header.tracking,
        ahead: header.ahead,
        behind: header.behind,
        changes: lines.filter((line) => !line.startsWith("##")).length,
      });
    } catch {
      // Ignore non-repositories.
    }
  }
  projects.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { ok: true, root: fileRoot, projects };
}

async function getProjectInfo(url) {
  const gitInfo = await getGitInfo(url);
  if (!gitInfo.ok || !gitInfo.isRepo) return gitInfo;
  const repo = await getRepoRootFromPath(url.searchParams.get("path") || "");
  if (!repo.ok || !repo.isRepo) return repo;
  const rootReal = repo.rootReal;
  const changeStats = await getChangeStats(rootReal, gitInfo.statusEntries || []);
  const diffEntries = await Promise.all(
    (gitInfo.statusEntries || []).slice(0, 40).map(async (entry) => {
      const stats = changeStats.get(entry.path) || { added: 0, deleted: 0, binary: false };
      if (entry.untracked) return { ...entry, stats, diff: "", diffKind: "untracked" };
      const args = ["-C", rootReal, "diff", "--", entry.path];
      let diff = await runCommand("git", args, { timeoutMs: 5000, maxOutput: diffPreviewLimit }).catch((error) => error.message);
      if (!diff && entry.staged) {
        diff = await runCommand("git", ["-C", rootReal, "diff", "--cached", "--", entry.path], {
          timeoutMs: 5000,
          maxOutput: diffPreviewLimit,
        }).catch((error) => error.message);
      }
      return {
        ...entry,
        stats,
        diff,
        diffKind: diff ? "diff" : "none",
        truncated: diff.length >= diffPreviewLimit,
      };
    }),
  );
  const statusEntries = (gitInfo.statusEntries || []).map((entry) => ({
    ...entry,
    stats: changeStats.get(entry.path) || { added: 0, deleted: 0, binary: false },
  }));
  return {
    ...gitInfo,
    statusEntries,
    diffEntries,
    clean: (gitInfo.statusEntries || []).length === 0,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeBranchName(raw) {
  return String(raw || "").trim().replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "");
}

async function switchProjectBranch(req) {
  const body = await readJson(req);
  const path = typeof body.path === "string" ? body.path.trim() : "";
  const branch = normalizeBranchName(body.branch);
  if (!path) return { ok: false, status: 400, code: "PROJECT_PATH_REQUIRED", message: "Project path is required." };
  if (!branch) return { ok: false, status: 400, code: "BRANCH_REQUIRED", message: "Branch is required." };
  if (branch.includes("..") || branch.startsWith("-") || /[\s~^:?*[\\]/.test(branch)) {
    return { ok: false, status: 400, code: "INVALID_BRANCH", message: "Branch name is not allowed." };
  }

  const repo = await getRepoRootFromPath(path);
  if (!repo.ok || !repo.isRepo) return repo;
  const rootReal = repo.rootReal;
  const porcelain = await runCommand("git", ["-C", rootReal, "status", "--porcelain"], { timeoutMs: 5000 }).catch((error) =>
    error.message,
  );
  if (porcelain.trim()) {
    return {
      ok: false,
      status: 409,
      code: "DIRTY_WORKTREE",
      message: "Working tree has changes. Commit, stash, or discard them before switching branch.",
    };
  }

  const current = await runCommand("git", ["-C", rootReal, "branch", "--show-current"], { timeoutMs: 5000 }).catch(() => "");
  if (current === branch) return { ok: true, switched: false, branch, message: "Already on this branch." };

  const localBranches = await runCommand("git", ["-C", rootReal, "branch", "--format=%(refname:short)"], { timeoutMs: 5000 }).catch(
    () => "",
  );
  const remoteBranches = await runCommand("git", ["-C", rootReal, "branch", "-r", "--format=%(refname:short)"], {
    timeoutMs: 5000,
  }).catch(() => "");
  const locals = new Set(localBranches.split("\n").filter(Boolean));
  const remotes = new Set(remoteBranches.split("\n").filter((line) => line && !line.includes(" -> ")));

  if (locals.has(branch)) {
    await runCommand("git", ["-C", rootReal, "switch", branch], { timeoutMs: 10000 });
    await writeAuditEventQuiet(auditLogPath, "branch_switch", { projectPath: path, branch, mode: "local" });
    return { ok: true, switched: true, branch };
  }

  const remote = Array.from(remotes).find((item) => item.endsWith(`/${branch}`));
  if (remote) {
    await runCommand("git", ["-C", rootReal, "switch", "--track", remote], { timeoutMs: 10000 });
    await writeAuditEventQuiet(auditLogPath, "branch_switch", { projectPath: path, branch, remote, mode: "track" });
    return { ok: true, switched: true, branch };
  }

  return { ok: false, status: 404, code: "BRANCH_NOT_FOUND", message: "Branch was not found locally or on remotes." };
}

async function projectInfoFromPath(path) {
  const params = new URLSearchParams({ path });
  return getProjectInfo(new URL(`http://local/api/project?${params.toString()}`));
}

function stagedChangeCount(info) {
  return (info.statusEntries || []).filter((entry) => entry.staged).length;
}

function unstagedChangeCount(info) {
  return (info.statusEntries || []).filter((entry) => entry.unstaged || entry.untracked).length;
}

async function runProjectGitAction(req) {
  const body = await readJson(req);
  const path = typeof body.path === "string" ? body.path.trim() : "";
  const action = typeof body.action === "string" ? body.action.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!path) return { ok: false, status: 400, code: "PROJECT_PATH_REQUIRED", message: "Project path is required." };
  if (!["pull", "stage_all", "unstage_all", "commit", "push"].includes(action)) {
    return { ok: false, status: 400, code: "INVALID_ACTION", message: "Unsupported Git action." };
  }

  const repo = await getRepoRootFromPath(path);
  if (!repo.ok || !repo.isRepo) return repo;
  const rootReal = repo.rootReal;
  const info = await projectInfoFromPath(path);
  if (!info.ok || !info.isRepo) return info;
  const clean = (info.statusEntries || []).length === 0;
  const staged = stagedChangeCount(info);
  const unstaged = unstagedChangeCount(info);

  if (action === "pull") {
    if (!info.tracking) return { ok: false, status: 409, code: "NO_UPSTREAM", message: "Current branch has no upstream." };
    if (!clean) return { ok: false, status: 409, code: "DIRTY_WORKTREE", message: "Pull is blocked while the working tree has changes." };
    if (!info.behind) return { ok: true, action, changed: false, message: "Already up to date." };
    const output = await runCommand("git", ["-C", rootReal, "pull", "--ff-only"], { timeoutMs: 60000, maxOutput: 120_000 });
    await writeAuditEventQuiet(auditLogPath, "git_action", { action, projectPath: path, branch: info.branch, tracking: info.tracking, changed: true });
    return { ok: true, action, changed: true, output };
  }

  if (action === "stage_all") {
    if (!unstaged) return { ok: true, action, changed: false, message: "No unstaged changes to stage." };
    const output = await runCommand("git", ["-C", rootReal, "add", "-A"], { timeoutMs: 30000, maxOutput: 80_000 });
    await writeAuditEventQuiet(auditLogPath, "git_action", { action, projectPath: path, branch: info.branch, changed: true, files: unstaged });
    return { ok: true, action, changed: true, output };
  }

  if (action === "unstage_all") {
    if (!staged) return { ok: true, action, changed: false, message: "No staged changes to unstage." };
    const output = await runCommand("git", ["-C", rootReal, "reset"], { timeoutMs: 30000, maxOutput: 80_000 });
    await writeAuditEventQuiet(auditLogPath, "git_action", { action, projectPath: path, branch: info.branch, changed: true, files: staged });
    return { ok: true, action, changed: true, output };
  }

  if (action === "commit") {
    if (!staged) return { ok: false, status: 409, code: "NOTHING_STAGED", message: "Stage changes before committing." };
    if (!message) return { ok: false, status: 400, code: "COMMIT_MESSAGE_REQUIRED", message: "Commit message is required." };
    if (message.length > 2000) {
      return { ok: false, status: 400, code: "COMMIT_MESSAGE_TOO_LONG", message: "Commit message is too long." };
    }
    const output = await runCommand("git", ["-C", rootReal, "commit", "-m", message], { timeoutMs: 60000, maxOutput: 120_000 });
    await writeAuditEventQuiet(auditLogPath, "git_action", {
      action,
      projectPath: path,
      branch: info.branch,
      changed: true,
      files: staged,
      messageLength: message.length,
    });
    return { ok: true, action, changed: true, output };
  }

  if (action === "push") {
    if (!info.tracking) return { ok: false, status: 409, code: "NO_UPSTREAM", message: "Current branch has no upstream." };
    if (info.behind) return { ok: false, status: 409, code: "BRANCH_BEHIND", message: "Pull remote changes before pushing." };
    if (!info.ahead) return { ok: true, action, changed: false, message: "Nothing to push." };
    const output = await runCommand("git", ["-C", rootReal, "push"], { timeoutMs: 60000, maxOutput: 120_000 });
    await writeAuditEventQuiet(auditLogPath, "git_action", { action, projectPath: path, branch: info.branch, tracking: info.tracking, changed: true, commits: info.ahead });
    return { ok: true, action, changed: true, output };
  }

  return { ok: false, status: 400, code: "INVALID_ACTION", message: "Unsupported Git action." };
}

function normalizeSession(session) {
  return {
    key: session.key,
    sessionId: session.sessionId,
    agentId: session.agentId,
    kind: session.kind,
    displayName: session.displayName,
    channel: session.channel,
    subject: session.subject,
    status: session.status,
    updatedAt: session.updatedAt,
    model: session.model,
    modelProvider: session.modelProvider,
    runtime: session.agentRuntime?.id || null,
    abortedLastRun: session.abortedLastRun === true,
    hasActiveRun: session.hasActiveRun === true,
    startedAt: session.startedAt ?? null,
    endedAt: session.endedAt ?? null,
    runtimeMs: session.runtimeMs ?? null,
    thinkingLevel: session.thinkingLevel || null,
    effectiveFastMode: session.effectiveFastMode ?? null,
    estimatedCostUsd: session.estimatedCostUsd ?? null,
    totalTokens: session.totalTokens ?? null,
    contextTokens: session.contextTokens ?? null,
  };
}

function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function readLocalSessionsIndex() {
  const raw = await readFile(openclawSessionsIndex, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
  return new Map(Object.entries(parsed));
}

function normalizeLocalSession(key, session) {
  const origin = session.origin || {};
  const status = session.status || "";
  return {
    key,
    sessionId: session.sessionId || null,
    agentId: session.agentId || key.split(":")[1] || "",
    kind: session.kind || origin.chatType || session.chatType || "",
    displayName: session.displayName || origin.label || session.subject || "",
    channel: session.channel || origin.provider || origin.surface || session.lastChannel || "",
    subject: session.subject || origin.label || "",
    status,
    updatedAt: session.updatedAt ?? session.lastInteractionAt ?? null,
    model: session.model || null,
    modelProvider: session.modelProvider || null,
    runtime: session.agentRuntime?.id || session.runtime || null,
    abortedLastRun: session.abortedLastRun === true,
    hasActiveRun:
      session.hasActiveRun === true ||
      ["queued", "starting", "running", "waiting", "waiting_approval"].includes(String(status).toLowerCase()),
    startedAt: session.startedAt ?? session.sessionStartedAt ?? null,
    endedAt: session.endedAt ?? null,
    runtimeMs: session.runtimeMs ?? null,
    thinkingLevel: session.thinkingLevel || null,
    effectiveFastMode: session.effectiveFastMode ?? null,
    estimatedCostUsd: session.estimatedCostUsd ?? null,
    totalTokens: session.totalTokens ?? null,
    contextTokens: session.contextTokens ?? null,
  };
}

async function listSessionsLocal() {
  const index = await readLocalSessionsIndex();
  const sessions = await Promise.all(
    [...index.entries()].map(async ([key, session]) => ({
      ...normalizeLocalSession(key, session),
      hasLocalHistory: await hasReadableLocalHistory(session),
    })),
  );
  sessions.sort((a, b) => {
    if (a.hasLocalHistory !== b.hasLocalHistory) return a.hasLocalHistory ? -1 : 1;
    return (timestampMs(b.updatedAt) || 0) - (timestampMs(a.updatedAt) || 0);
  });
  const limitedSessions = sessions.slice(0, 50);
  return {
    ok: true,
    sessions: limitedSessions,
    defaults: null,
    count: limitedSessions.length,
    source: "local",
  };
}

function localTrajectoryPath(session) {
  if (session?.trajectoryFile) return session.trajectoryFile;
  if (session?.sessionFile && session.sessionFile.endsWith(".jsonl")) {
    return session.sessionFile.replace(/\.jsonl$/, ".trajectory.jsonl");
  }
  if (session?.sessionId) return join(openclawSessionsDir, `${session.sessionId}.trajectory.jsonl`);
  return "";
}

async function hasReadableLocalHistory(session) {
  const trajectoryPath = localTrajectoryPath(session);
  if (!trajectoryPath) return false;
  try {
    const info = await stat(trajectoryPath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function limitString(value, limit = maxChars) {
  const text = String(value ?? "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n<truncated ${text.length - limit} chars>`;
}

function stringifyLimited(value, limit = maxChars) {
  if (typeof value === "string") return limitString(value, limit);
  if (value === undefined || value === null) return "";
  try {
    return limitString(JSON.stringify(value, null, 2), limit);
  } catch {
    return limitString(String(value), limit);
  }
}

function sanitizeContent(content) {
  if (typeof content === "string") return limitString(content);
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return limitString(item);
      if (!item || typeof item !== "object") return item;
      const copy = { ...item };
      if (typeof copy.text === "string") copy.text = limitString(copy.text);
      if (typeof copy.content === "string") copy.content = limitString(copy.content);
      if (copy.input && typeof copy.input === "object") copy.input = JSON.parse(JSON.stringify(copy.input));
      if (copy.arguments && typeof copy.arguments === "object") copy.arguments = JSON.parse(JSON.stringify(copy.arguments));
      return copy;
    });
  }
  if (content && typeof content === "object") {
    const copy = { ...content };
    if (typeof copy.text === "string") copy.text = limitString(copy.text);
    return copy;
  }
  return content;
}

function sanitizeMessage(message) {
  if (!message || typeof message !== "object") return message;
  return {
    ...message,
    content: sanitizeContent(message.content),
  };
}

function extractPromptText(prompt) {
  const text = String(prompt || "").trim();
  if (!text) return "";
  const marker = "Current user request:";
  const markerIndex = text.lastIndexOf(marker);
  const candidate = markerIndex >= 0 ? text.slice(markerIndex + marker.length).trim() : text;
  const fenceMatch = candidate.match(/^```[\s\S]*?```\s*([\s\S]+)$/);
  return limitString((fenceMatch ? fenceMatch[1] : candidate).trim());
}

function localToolCallMessage(record, lineIndex) {
  const data = record.data || {};
  return sanitizeMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: data.toolCallId || data.itemId || `local-tool-${lineIndex}`,
        name: data.name || "tool",
        arguments: data.arguments || {},
        input: data.arguments || {},
      },
    ],
    timestamp: timestampMs(record.ts),
    __openclaw: { seq: lineIndex, recordTimestampMs: timestampMs(record.ts), live: true },
  });
}

function localToolResultMessage(record, lineIndex) {
  const data = record.data || {};
  const output = data.output ?? data.result ?? data.contentItems ?? "";
  return sanitizeMessage({
    role: "toolResult",
    toolCallId: data.toolCallId || data.itemId || "",
    toolName: data.name || "tool",
    isError: data.isError === true || data.success === false || data.status === "error",
    content: [
      {
        type: "toolResult",
        id: data.toolCallId || data.itemId || `local-result-${lineIndex}`,
        name: data.name || "tool",
        toolName: data.name || "tool",
        toolCallId: data.toolCallId || data.itemId || "",
        content: stringifyLimited(output),
        text: stringifyLimited(output),
      },
    ],
    timestamp: timestampMs(record.ts),
    __openclaw: { seq: lineIndex, recordTimestampMs: timestampMs(record.ts), live: true },
  });
}

function sliceHistoryMessages(messages, limit) {
  if (messages.length <= limit) return messages;
  const sliced = messages.slice(-limit);
  const latestLiveUserIndex = messages.findLastIndex(
    (message) => message?.role === "user" && message.__openclaw?.live === true,
  );
  if (latestLiveUserIndex < 0 || sliced.includes(messages[latestLiveUserIndex])) return sliced;
  return [messages[latestLiveUserIndex], ...messages.slice(-(limit - 1))];
}

async function getHistoryLocal(sessionKey, limit) {
  const index = await readLocalSessionsIndex();
  const session = index.get(sessionKey);
  if (!session) throw new Error("session not found locally");
  const trajectoryPath = localTrajectoryPath(session);
  const sessionInfo = normalizeLocalSession(sessionKey, session);
  if (!trajectoryPath) {
    return {
      ok: true,
      sessionKey,
      sessionId: session.sessionId || null,
      sessionInfo,
      messages: [],
      defaults: null,
      thinkingLevel: session.thinkingLevel || null,
      source: "local",
    };
  }

  let raw = "";
  try {
    raw = await readFile(trajectoryPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {
      ok: true,
      sessionKey,
      sessionId: session.sessionId || null,
      sessionInfo,
      messages: [],
      defaults: null,
      thinkingLevel: session.thinkingLevel || null,
      source: "local",
    };
  }
  const lines = raw.split(/\r?\n/);
  let lastCompletedLine = -1;
  let lastCompletedRecord = null;
  const records = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const record = JSON.parse(line);
      records.push({ record, lineIndex: index });
      if (record.type === "model.completed" && Array.isArray(record.data?.messagesSnapshot)) {
        lastCompletedLine = index;
        lastCompletedRecord = record;
      }
    } catch {
      // The trajectory may be read while OpenClaw is appending the last line.
    }
  });

  const messages = Array.isArray(lastCompletedRecord?.data?.messagesSnapshot)
    ? lastCompletedRecord.data.messagesSnapshot.map(sanitizeMessage)
    : [];
  const seenLivePromptTurnIds = new Set();

  for (const { record, lineIndex } of records) {
    if (lineIndex <= lastCompletedLine) continue;
    if (record.type === "prompt.submitted") {
      const turnId = record.data?.turnId || `line-${lineIndex}`;
      if (seenLivePromptTurnIds.has(turnId)) continue;
      seenLivePromptTurnIds.add(turnId);
      const text = extractPromptText(record.data?.prompt);
      if (text) {
        messages.push({
          role: "user",
          content: text,
          timestamp: timestampMs(record.ts),
          __openclaw: { seq: lineIndex, recordTimestampMs: timestampMs(record.ts), live: true },
        });
      }
    } else if (record.type === "tool.call") {
      messages.push(localToolCallMessage(record, lineIndex));
    } else if (record.type === "tool.result") {
      messages.push(localToolResultMessage(record, lineIndex));
    }
  }

  const sliced = sliceHistoryMessages(messages, limit);
  return {
    ok: true,
    sessionKey,
    sessionId: session.sessionId || null,
    sessionInfo,
    messages: sliced,
    defaults: null,
    thinkingLevel: session.thinkingLevel || null,
    source: "local",
  };
}

async function listSessions() {
  try {
    return await listSessionsLocal();
  } catch {
    const result = await gatewayCall("sessions.list", { limit: 50 }, { timeoutMs: 10000 });
    const sessions = Array.isArray(result.sessions) ? result.sessions.map(normalizeSession) : [];
    return {
      ok: true,
      sessions,
      defaults: result.defaults || null,
      count: result.count ?? sessions.length,
      source: "gateway",
    };
  }
}

async function getHistory(url) {
  const sessionKey = url.searchParams.get("sessionKey") || "";
  const agentId = url.searchParams.get("agentId") || "";
  const limit = Math.min(Number.parseInt(url.searchParams.get("limit") || String(defaultLimit), 10), 200);
  if (!sessionKey.trim()) {
    return { ok: false, status: 400, code: "SESSION_KEY_REQUIRED", message: "sessionKey is required." };
  }
  try {
    return await getHistoryLocal(sessionKey, limit);
  } catch {
    // Fall back to the Gateway API for non-local or future session formats.
  }
  const params = {
    sessionKey,
    limit,
    maxChars,
    ...(agentId ? { agentId } : {}),
  };
  const result = await gatewayCall("chat.history", params, { timeoutMs: 15000 });
  return {
    ok: true,
    sessionKey: result.sessionKey || sessionKey,
    sessionId: result.sessionId || result.sessionInfo?.sessionId || null,
    sessionInfo: result.sessionInfo || null,
    messages: Array.isArray(result.messages) ? result.messages : [],
    defaults: result.defaults || null,
    thinkingLevel: result.thinkingLevel || null,
    source: "gateway",
  };
}

function taskTimestamp(task) {
  const value = task.updatedAt ?? task.endedAt ?? task.startedAt ?? task.createdAt ?? 0;
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeTask(task) {
  return {
    id: task.id || task.taskId || task.runId || "",
    title: task.title || task.name || task.description || task.prompt || "Task",
    status: task.status || task.state || "",
    runtime: task.runtime || task.kind || task.type || "",
    sessionKey: task.sessionKey || task.key || "",
    agentId: task.agentId || "",
    startedAt: task.startedAt ?? null,
    updatedAt: task.updatedAt ?? null,
    endedAt: task.endedAt ?? null,
    runtimeMs: task.runtimeMs ?? null,
  };
}

async function getRunState(url) {
  const sessionKey = url.searchParams.get("sessionKey") || "";
  const includeDetails = url.searchParams.get("details") === "1";
  if (!sessionKey.trim()) {
    return { ok: false, status: 400, code: "SESSION_KEY_REQUIRED", message: "sessionKey is required." };
  }

  let session = null;
  let sessionSource = "local";
  try {
    const sessionsResult = await listSessionsLocal();
    session = sessionsResult.sessions.find((item) => item.key === sessionKey) || null;
  } catch (error) {
    try {
      const sessionsResult = await gatewayCall("sessions.list", { limit: 50 }, { timeoutMs: 20000, processTimeoutMs: 25000 });
      const sessions = Array.isArray(sessionsResult.sessions) ? sessionsResult.sessions : [];
      const gatewaySession = sessions.find((item) => item.key === sessionKey) || null;
      session = gatewaySession ? normalizeSession(gatewaySession) : null;
      sessionSource = "gateway";
    } catch (gatewayError) {
      return {
        ok: false,
        status: 502,
        code: "RUN_STATE_UNAVAILABLE",
        message: gatewayError instanceof Error ? gatewayError.message : "Could not read session state.",
      };
    }
  }

  const [tasksResult, approvalsResult] = includeDetails
    ? await Promise.allSettled([
        gatewayCall("tasks.list", {}, { timeoutMs: 12000, processTimeoutMs: 15000 }),
        gatewayCall("exec.approvals.get", {}, { timeoutMs: 12000, processTimeoutMs: 15000 }),
      ])
    : [{ status: "fulfilled", value: { tasks: [] } }, { status: "fulfilled", value: null }];

  const tasksRaw = tasksResult.status === "fulfilled" && Array.isArray(tasksResult.value.tasks) ? tasksResult.value.tasks : [];
  const tasks = tasksRaw
    .map(normalizeTask)
    .sort((a, b) => taskTimestamp(b) - taskTimestamp(a))
    .slice(0, 8);
  const matchingTasks = tasks.filter((task) => !task.sessionKey || task.sessionKey === sessionKey);
  const approvals = approvalsResult.status === "fulfilled" ? approvalsResult.value : null;

  return {
    ok: true,
    sessionKey,
    session,
    source: sessionSource,
    tasks: matchingTasks.length > 0 ? matchingTasks : tasks,
    taskCount: tasksRaw.length,
    approvals: approvals
      ? {
          configured: approvals.exists === true,
          version: approvals.file?.version ?? null,
          socket: Boolean(approvals.file?.socket?.path),
        }
      : null,
    errors: {
      tasks: tasksResult.status === "rejected" ? String(tasksResult.reason?.message || tasksResult.reason) : null,
      approvals: approvalsResult.status === "rejected" ? String(approvalsResult.reason?.message || approvalsResult.reason) : null,
    },
  };
}

function isAttentionActiveSession(session) {
  if (!session) return false;
  const status = String(session.status || "").toLowerCase();
  return session.hasActiveRun === true || ["queued", "starting", "running", "waiting", "waiting_approval"].includes(status);
}

function attentionSessionName(session) {
  const key = session?.key || "";
  const rawName = String(session?.displayName || "").trim();
  const subject = String(session?.subject || "").trim();
  const usefulName = rawName && !rawName.startsWith("telegram:") ? rawName : "";
  if (key.includes(":telegram:group:")) return subject || usefulName || `Telegram group ${key.split(":").at(-1)}`;
  if (key.includes(":telegram:direct:")) return usefulName || subject || "Direct chat";
  if (usefulName) return usefulName;
  if (key.endsWith(":main")) return "Main";
  return key.replace(/^agent:[^:]+:/, "") || "Session";
}

function attentionToneFromStatus(status) {
  const normalized = String(status || "").toLowerCase();
  if (["failed", "error", "lost", "timed_out", "cancelled", "aborted"].includes(normalized)) return "danger";
  if (["waiting", "waiting_approval"].includes(normalized)) return "waiting";
  if (["running", "starting", "queued"].includes(normalized)) return "active";
  return "idle";
}

function attentionTaskTitle(task) {
  return String(task.title || task.id || "Task").replace(/\s+/g, " ").trim();
}

async function getAttention(url = new URL("http://local/api/attention")) {
  const includeDetails = url.searchParams.get("details") === "1";
  const [sessionsResult, projectsResult, tasksResult, approvalsResult, healthResult] = await Promise.allSettled([
    listSessions(),
    listProjects(),
    includeDetails ? gatewayCall("tasks.list", {}, { timeoutMs: 6000, processTimeoutMs: 8000 }) : { tasks: [] },
    includeDetails ? gatewayCall("exec.approvals.get", {}, { timeoutMs: 6000, processTimeoutMs: 8000 }) : null,
    includeDetails ? gatewayCall("health", {}, { timeoutMs: 6000, processTimeoutMs: 8000 }) : null,
  ]);

  const sessions = sessionsResult.status === "fulfilled" ? sessionsResult.value.sessions || [] : [];
  const projects = projectsResult.status === "fulfilled" ? projectsResult.value.projects || [] : [];
  const rawTasks = tasksResult.status === "fulfilled" && Array.isArray(tasksResult.value.tasks) ? tasksResult.value.tasks : [];
  const tasks = rawTasks.map(normalizeTask).sort((a, b) => taskTimestamp(b) - taskTimestamp(a));
  const approvals = approvalsResult.status === "fulfilled" ? approvalsResult.value : null;
  const health = healthResult.status === "fulfilled" ? healthResult.value : null;
  const auditEvents = await readAuditEvents(auditLogPath, 8).catch(() => []);

  const items = [];
  for (const session of sessions.filter(isAttentionActiveSession).slice(0, 5)) {
    const status = String(session.status || (session.hasActiveRun ? "running" : "") || "active");
    const started = timestampMs(session.startedAt);
    const elapsed = started ? Date.now() - started : session.runtimeMs;
    items.push({
      id: `run:${session.key}`,
      type: "run",
      tone: attentionToneFromStatus(status),
      title: attentionSessionName(session),
      meta: [status, session.model || "", session.thinkingLevel ? `think ${session.thinkingLevel}` : ""].filter(Boolean).join(" · "),
      timestamp: session.updatedAt ?? session.startedAt ?? null,
      durationMs: Number.isFinite(elapsed) ? elapsed : null,
      sessionKey: session.key,
    });
  }

  for (const project of projects.filter((item) => item.changes > 0 || item.ahead > 0 || item.behind > 0).slice(0, 8)) {
    const bits = [
      project.branch || "",
      project.changes > 0 ? `${project.changes} changed` : "clean",
      project.ahead > 0 ? `ahead ${project.ahead}` : "",
      project.behind > 0 ? `behind ${project.behind}` : "",
    ].filter(Boolean);
    items.push({
      id: `project:${project.path}`,
      type: "project",
      tone: project.behind > 0 ? "waiting" : project.changes > 0 ? "active" : "idle",
      title: project.name,
      meta: bits.join(" · "),
      projectPath: project.path,
      changes: project.changes,
      ahead: project.ahead,
      behind: project.behind,
    });
  }

  const activeTasks = tasks.filter((task) =>
    ["queued", "running", "starting", "waiting", "waiting_approval"].includes(String(task.status || "").toLowerCase()),
  );
  const failedTasks = tasks.filter((task) =>
    ["failed", "timed_out", "lost"].includes(String(task.status || "").toLowerCase()),
  );
  for (const task of [...activeTasks, ...failedTasks].slice(0, 6)) {
    items.push({
      id: `task:${task.id || attentionTaskTitle(task)}`,
      type: "task",
      tone: attentionToneFromStatus(task.status),
      title: attentionTaskTitle(task),
      meta: [task.status, task.runtime, task.agentId].filter(Boolean).join(" · "),
      timestamp: taskTimestamp(task) || null,
      sessionKey: task.sessionKey || "",
    });
  }

  const pluginErrors = health ? (Array.isArray(health?.plugins?.errors) ? health.plugins.errors.length : 0) : 0;
  const eventLoopDegraded = health?.eventLoop?.degraded === true;
  if (includeDetails && (healthResult.status === "rejected" || pluginErrors > 0 || eventLoopDegraded)) {
    items.push({
      id: "health:gateway",
      type: "health",
      tone: "danger",
      title: "Gateway attention",
      meta:
        healthResult.status === "rejected"
          ? String(healthResult.reason?.message || healthResult.reason)
          : [pluginErrors ? `${pluginErrors} plugin error(s)` : "", eventLoopDegraded ? "event loop degraded" : ""]
              .filter(Boolean)
              .join(" · "),
    });
  }

  if (sessionsResult.status === "rejected") {
    items.push({
      id: "error:sessions",
      type: "health",
      tone: "danger",
      title: "Sessions unavailable",
      meta: String(sessionsResult.reason?.message || sessionsResult.reason),
    });
  }

  if (projectsResult.status === "rejected") {
    items.push({
      id: "error:projects",
      type: "health",
      tone: "danger",
      title: "Projects unavailable",
      meta: String(projectsResult.reason?.message || projectsResult.reason),
    });
  }

  const approvalConfigured = approvals?.exists === true || Boolean(approvals?.file?.socket?.path);
  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    summary: {
      activeRuns: sessions.filter(isAttentionActiveSession).length,
      changedProjects: projects.filter((project) => project.changes > 0).length,
      activeTasks: activeTasks.length,
      failedTasks: failedTasks.length,
      approvalConfigured,
      healthOk: includeDetails ? healthResult.status === "fulfilled" && pluginErrors === 0 && !eventLoopDegraded : null,
      itemCount: items.length,
    },
    items: items.slice(0, 24),
    projects: projects.slice(0, 12),
    recentTasks: tasks.slice(0, 8),
    auditEvents,
    approvals: approvals
      ? {
          configured: approvalConfigured,
          version: approvals.file?.version ?? null,
          socket: Boolean(approvals.file?.socket?.path),
        }
      : null,
    errors: {
      tasks: tasksResult.status === "rejected" ? String(tasksResult.reason?.message || tasksResult.reason) : null,
      approvals: approvalsResult.status === "rejected" ? String(approvalsResult.reason?.message || approvalsResult.reason) : null,
      health: healthResult.status === "rejected" ? String(healthResult.reason?.message || healthResult.reason) : null,
    },
  };
}

async function sendMessage(req) {
  const body = await readJson(req);
  const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey.trim() : "";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const audit = body.audit && typeof body.audit === "object" && !Array.isArray(body.audit) ? body.audit : null;
  const idempotencyKey =
    typeof body.idempotencyKey === "string" && body.idempotencyKey.trim()
      ? body.idempotencyKey.trim()
      : `mobile-studio:${randomUUID()}`;
  if (!sessionKey) {
    return { ok: false, status: 400, code: "SESSION_KEY_REQUIRED", message: "sessionKey is required." };
  }
  if (!message) {
    return { ok: false, status: 400, code: "MESSAGE_REQUIRED", message: "message is required." };
  }
  const result = await gatewayCall(
    "chat.send",
    {
      sessionKey,
      ...(sessionId ? { sessionId } : {}),
      ...(agentId ? { agentId } : {}),
      message,
      deliver: false,
      idempotencyKey,
    },
    { timeoutMs: 20000, processTimeoutMs: 25000 },
  );
  const command = message.startsWith("/") ? message.split(/\s+/)[0].slice(0, 80) : "";
  await writeAuditEventQuiet(auditLogPath, audit?.type || "chat_send", {
    sessionKey,
    agentId,
    command,
    messageLength: message.length,
    ...(audit?.meta && typeof audit.meta === "object" ? audit.meta : {}),
  });
  return {
    ok: true,
    idempotencyKey,
    result,
  };
}

async function abortRun(req) {
  const body = await readJson(req);
  const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey.trim() : "";
  const runId = typeof body.runId === "string" ? body.runId.trim() : "";
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  if (!sessionKey) {
    return { ok: false, status: 400, code: "SESSION_KEY_REQUIRED", message: "sessionKey is required." };
  }
  const result = await gatewayCall(
    "chat.abort",
    {
      sessionKey,
      ...(runId ? { runId } : {}),
      ...(agentId ? { agentId } : {}),
    },
    { timeoutMs: 10000 },
  );
  await writeAuditEventQuiet(auditLogPath, "run_abort", { sessionKey, runId, agentId });
  return { ok: true, result };
}

async function serveStatic(req, res, pathname) {
  const cleanPath = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = resolve(join(publicDir, cleanPath));
  if (!filePath.startsWith(publicDir)) {
    sendError(res, 403, "FORBIDDEN", "Forbidden path.");
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes.get(extname(filePath)) || "application/octet-stream",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    res.end(body);
  } catch {
    const index = await readFile(join(publicDir, "index.html"));
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    });
    res.end(index);
  }
}

async function handleApi(req, res, url) {
  if (!requireAuth(req, res)) return;
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, await getHealth());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/sessions") {
      sendJson(res, 200, await listSessions());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/history") {
      const result = await getHistory(url);
      if (!result.ok) sendError(res, result.status, result.code, result.message);
      else sendJson(res, 200, result);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/run-state") {
      const result = await getRunState(url);
      if (!result.ok) sendError(res, result.status, result.code, result.message);
      else sendJson(res, 200, result);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/attention") {
      sendJson(res, 200, await getAttention(url));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/audit") {
      const limit = Number.parseInt(url.searchParams.get("limit") || "40", 10);
      sendJson(res, 200, { ok: true, events: await readAuditEvents(auditLogPath, limit) });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/files") {
      const result = await listFiles(url);
      if (!result.ok) sendError(res, result.status, result.code, result.message);
      else sendJson(res, 200, result);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/file") {
      const result = await previewFile(url);
      if (!result.ok) sendError(res, result.status, result.code, result.message);
      else sendJson(res, 200, result);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/projects") {
      const result = await listProjects();
      if (!result.ok) sendError(res, result.status, result.code, result.message);
      else sendJson(res, 200, result);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/project") {
      const result = await getProjectInfo(url);
      if (!result.ok) sendError(res, result.status, result.code, result.message);
      else sendJson(res, 200, result);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/project/branch") {
      const result = await switchProjectBranch(req);
      if (!result.ok) sendError(res, result.status, result.code, result.message);
      else sendJson(res, 200, result);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/project/git-action") {
      const result = await runProjectGitAction(req);
      if (!result.ok) sendError(res, result.status, result.code, result.message);
      else sendJson(res, 200, result);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/git") {
      const result = await getGitInfo(url);
      if (!result.ok) sendError(res, result.status, result.code, result.message);
      else sendJson(res, 200, result);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/send") {
      const result = await sendMessage(req);
      if (!result.ok) sendError(res, result.status, result.code, result.message);
      else sendJson(res, 200, result);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/abort") {
      const result = await abortRun(req);
      if (!result.ok) sendError(res, result.status, result.code, result.message);
      else sendJson(res, 200, result);
      return;
    }
    sendError(res, 404, "NOT_FOUND", "Unknown API endpoint.");
  } catch (error) {
    sendError(res, 500, "API_ERROR", error instanceof Error ? error.message : String(error));
  }
}

function normalizeMountedUrl(url) {
  for (const prefix of mountPrefixes) {
    if (url.pathname === prefix) {
      return { redirectTo: `${prefix}/${url.search}` };
    }
    if (url.pathname.startsWith(`${prefix}/`)) {
      url.pathname = url.pathname.slice(prefix.length) || "/";
      return { redirectTo: null };
    }
  }
  return { redirectTo: null };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
  const mounted = normalizeMountedUrl(url);
  if (mounted.redirectTo) {
    res.writeHead(308, {
      location: mounted.redirectTo,
      "cache-control": "no-store",
    });
    res.end();
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res, url);
    return;
  }
  await serveStatic(req, res, url.pathname);
});

server.listen(port, host, () => {
  console.log(`OpenClaw Mobile Studio listening on http://${host}:${port}`);
  if (!authToken) {
    console.log("MOBILE_STUDIO_TOKEN is not set; API is open to loopback clients only.");
  }
});
