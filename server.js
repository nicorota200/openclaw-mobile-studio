import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import Busboy from "busboy";
import { readAuditEvents, writeAuditEventQuiet } from "./lib/audit.js";
import { projectActions } from "./public/project-actions.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = resolve(__dirname, "public");
const dataDir = resolve(__dirname, "data");
const auditLogPath = join(dataDir, "audit-log.jsonl");
const appSessionStatePath = join(dataDir, "session-state.json");

const host = process.env.HOST || "127.0.0.1";
const port = Number.parseInt(process.env.PORT || "8787", 10);
const authToken = process.env.MOBILE_STUDIO_TOKEN || "";
const openclawBin = process.env.OPENCLAW_BIN || "/home/nicola-rota/.npm-global/bin/openclaw";
const defaultLimit = 80;
const maxChars = 4000;
const sessionPoolSizeMin = 1;
const sessionPoolSizeMax = 20;

function boundedIntegerEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function gitModeEnv() {
  const raw = process.env.MOBILE_STUDIO_GIT_MODE;
  if (raw === undefined || raw === "") return "read";
  if (raw === "read" || raw === "write") return raw;
  throw new Error(
    `MOBILE_STUDIO_GIT_MODE must be "read" or "write"; received ${JSON.stringify(raw)}. ` +
      "Use read (the default) to block Git mutations or write to enable guarded Git actions.",
  );
}

const sessionPoolSize = boundedIntegerEnv(
  "MOBILE_STUDIO_SESSION_POOL_SIZE",
  5,
  sessionPoolSizeMin,
  sessionPoolSizeMax,
);
const gitMode = gitModeEnv();
const fileRoot = resolve(process.env.MOBILE_STUDIO_FILE_ROOT || "/home/nicola-rota");
const filePreviewLimit = 200 * 1024;
const diffPreviewLimit = 80_000;
const uploadRoot = resolve(process.env.MOBILE_STUDIO_UPLOAD_DIR || join(dataDir, "chat-uploads"));
const uploadMaxFileBytes = boundedIntegerEnv(
  "MOBILE_STUDIO_MAX_UPLOAD_BYTES",
  1024 * 1024 * 1024,
  1,
  Number.MAX_SAFE_INTEGER,
);
const uploadTtlMs = boundedIntegerEnv(
  "MOBILE_STUDIO_UPLOAD_TTL_MS",
  7 * 24 * 60 * 60 * 1000,
  1,
  365 * 24 * 60 * 60 * 1000,
);
const uploadMaxAttachmentsPerMessage = boundedIntegerEnv("MOBILE_STUDIO_MAX_ATTACHMENTS_PER_MESSAGE", 5, 1, 20);
const uploadMaxTotalBytes = boundedIntegerEnv(
  "MOBILE_STUDIO_MAX_TOTAL_UPLOAD_BYTES",
  2 * 1024 * 1024 * 1024,
  1,
  Number.MAX_SAFE_INTEGER,
);
const uploadMaxConcurrent = boundedIntegerEnv("MOBILE_STUDIO_MAX_CONCURRENT_UPLOADS", 2, 1, 20);
const uploadSetupDelayMs =
  process.env.NODE_ENV === "test" ? Number.parseInt(process.env.MOBILE_STUDIO_TEST_UPLOAD_SETUP_DELAY_MS || "0", 10) || 0 : 0;
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

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function safeUploadName(name) {
  const base = basename(String(name || "upload").replace(/\0/g, ""));
  const cleaned = base.replace(/[^\w .@()+,-]/g, "_").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 180) || "upload";
}

function uploadMetaPath(id) {
  return join(uploadRoot, id, "manifest.json");
}

function uploadDirectoryPath(name) {
  const path = resolve(uploadRoot, name);
  if (dirname(path) !== uploadRoot) {
    throw new HttpError(400, "INVALID_ATTACHMENT_ID", "Attachment directory is outside the upload root.");
  }
  return path;
}

function validateUploadManifest(manifest, id, fileInfo, { allowExpired = false } = {}) {
  const uploadDir = uploadDirectoryPath(id);
  const manifestPath = uploadMetaPath(id);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new HttpError(400, "INVALID_ATTACHMENT_MANIFEST", "Attachment metadata is malformed.");
  }
  const filePath = resolve(typeof manifest.path === "string" ? manifest.path : "");
  const expiresAt = Date.parse(manifest.expiresAt || "");
  if (
    manifest.id !== id ||
    typeof manifest.name !== "string" ||
    !manifest.name ||
    !Number.isSafeInteger(manifest.size) ||
    manifest.size < 0 ||
    manifest.path !== filePath ||
    dirname(filePath) !== uploadDir ||
    filePath === manifestPath ||
    !Number.isFinite(expiresAt) ||
    !fileInfo?.isFile() ||
    fileInfo.isSymbolicLink() ||
    fileInfo.size !== manifest.size
  ) {
    throw new HttpError(400, "INVALID_ATTACHMENT_MANIFEST", "Attachment metadata or payload is malformed.");
  }
  if (!allowExpired && expiresAt <= Date.now()) {
    throw new HttpError(410, "ATTACHMENT_EXPIRED", "Attachment has expired; upload it again before sending.");
  }
  return { manifest, filePath, expiresAt };
}

async function loadUploadManifest(id, options) {
  const uploadDir = uploadDirectoryPath(id);
  const manifestPath = uploadMetaPath(id);
  let directoryInfo;
  let manifestInfo;
  try {
    directoryInfo = await lstat(uploadDir);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new HttpError(400, "INVALID_ATTACHMENT_MANIFEST", "Attachment directory is malformed.");
    }
    manifestInfo = await lstat(manifestPath);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error?.code === "ENOENT") {
      throw new HttpError(404, "ATTACHMENT_NOT_FOUND", "Attachment was not found; upload it again.");
    }
    throw error;
  }
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
    throw new HttpError(400, "INVALID_ATTACHMENT_MANIFEST", "Attachment metadata is malformed.");
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new HttpError(404, "ATTACHMENT_NOT_FOUND", "Attachment was not found; upload it again.");
    }
    if (error instanceof SyntaxError || error?.code === "EISDIR") {
      throw new HttpError(400, "INVALID_ATTACHMENT_MANIFEST", "Attachment metadata is malformed.");
    }
    throw error;
  }
  const filePath = resolve(typeof manifest?.path === "string" ? manifest.path : "");
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.path !== filePath ||
    dirname(filePath) !== uploadDir ||
    filePath === manifestPath
  ) {
    throw new HttpError(400, "INVALID_ATTACHMENT_MANIFEST", "Attachment metadata or payload is malformed.");
  }
  let fileInfo;
  try {
    fileInfo = await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new HttpError(400, "INVALID_ATTACHMENT_MANIFEST", "Attachment payload is missing.");
    }
    throw error;
  }
  return validateUploadManifest(manifest, id, fileInfo, options);
}

async function removeUploadDirectory(name) {
  const path = uploadDirectoryPath(name);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new HttpError(500, "UPLOAD_STORAGE_UNAVAILABLE", `Upload directory cannot be inspected: ${error.message}`);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return false;
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    throw new HttpError(500, "UPLOAD_STORAGE_UNAVAILABLE", `Upload directory cannot be removed: ${error.message}`);
  }
  return true;
}

async function readUploadManifest(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) {
    throw new HttpError(400, "INVALID_ATTACHMENT_ID", "Attachment id is invalid.");
  }
  const loaded = await loadUploadManifest(id, { allowExpired: true });
  if (loaded.expiresAt <= Date.now()) {
    if (await removeUploadDirectory(id).catch(() => false)) {
      uploadStoredBytes = Math.max(0, uploadStoredBytes - loaded.manifest.size);
    }
    throw new HttpError(410, "ATTACHMENT_EXPIRED", "Attachment has expired; upload it again before sending.");
  }
  return loaded.manifest;
}

const activeUploadDirectories = new Set();
let uploadStoredBytes = 0;
let uploadReservedBytes = 0;
let uploadStorageReady = null;
let uploadMaintenanceWork = Promise.resolve();
let activeUploadCount = 0;

function withUploadMaintenanceLock(work) {
  const result = uploadMaintenanceWork.then(work, work);
  uploadMaintenanceWork = result.catch(() => {});
  return result;
}

async function cleanupUploads({ initialize = false } = {}) {
  const now = Date.now();
  let entries;
  try {
    entries = await readdir(uploadRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw new HttpError(500, "UPLOAD_STORAGE_UNAVAILABLE", `Upload storage cannot be read: ${error.message}`);
  }
  let validBytes = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || activeUploadDirectories.has(entry.name)) continue;
    let loaded;
    try {
      loaded = await loadUploadManifest(entry.name, { allowExpired: true });
    } catch (error) {
      if (error instanceof HttpError && error.status < 500) {
        await removeUploadDirectory(entry.name);
        continue;
      }
      throw new HttpError(500, "UPLOAD_STORAGE_UNAVAILABLE", `Upload storage cannot be inspected: ${error.message}`);
    }
    if (loaded.expiresAt <= now) {
      if (await removeUploadDirectory(entry.name)) {
        if (!initialize) uploadStoredBytes = Math.max(0, uploadStoredBytes - loaded.manifest.size);
      }
      continue;
    }
    validBytes += loaded.manifest.size;
  }
  if (initialize) uploadStoredBytes = validBytes;
  return validBytes;
}

function ensureUploadStorageReady() {
  if (!uploadStorageReady) {
    uploadStorageReady = withUploadMaintenanceLock(() => cleanupUploads({ initialize: true })).catch((error) => {
      uploadStorageReady = null;
      throw error;
    });
  }
  return uploadStorageReady;
}

async function prepareUploadStorage() {
  await mkdir(uploadRoot, { recursive: true });
  await ensureUploadStorageReady();
  await withUploadMaintenanceLock(() => cleanupUploads());
}

function reserveUploadBytes(size) {
  if (uploadStoredBytes + uploadReservedBytes + size > uploadMaxTotalBytes) {
    throw new HttpError(
      507,
      "UPLOAD_CAPACITY_EXCEEDED",
      `Upload storage limit is ${uploadMaxTotalBytes} bytes; remove or wait for existing attachments to expire.`,
    );
  }
  uploadReservedBytes += size;
}

function releaseUploadBytes(size) {
  uploadReservedBytes = Math.max(0, uploadReservedBytes - size);
}

async function saveUploadWithinLimits(req) {
  let busboy = null;
  let inputFile = null;
  let outputFile = null;
  let uploadDir = null;
  let filePromise = null;
  let failure = null;
  let rejectFailure;
  const failed = new Promise((_, reject) => {
    rejectFailure = reject;
  });
  // A disconnect can happen while upload-root setup is still pending.
  failed.catch(() => {});

  const failOnce = (error) => {
    if (failure) return;
    failure = error instanceof HttpError ? error : new HttpError(400, "UPLOAD_PARSE_ERROR", error?.message || "Upload failed.");
    req.unpipe(busboy || undefined);
    inputFile?.destroy(failure);
    outputFile?.destroy(failure);
    busboy?.destroy(failure);
    if (!req.destroyed && !req.readableEnded) req.resume();
    rejectFailure(failure);
  };
  const abortUpload = () => failOnce(new HttpError(400, "UPLOAD_ABORTED", "Upload was interrupted."));
  const requestError = (error) => failOnce(new HttpError(400, "UPLOAD_ABORTED", error?.message || "Upload was interrupted."));
  req.once("aborted", abortUpload);
  req.once("error", requestError);

  if (req.aborted || req.destroyed) abortUpload();
  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength && contentLength > uploadMaxFileBytes + 1024 * 1024) {
    failOnce(new HttpError(413, "UPLOAD_TOO_LARGE", `Upload limit is ${Math.round(uploadMaxFileBytes / 1024 / 1024)} MB.`));
  }
  try {
    const setup = (async () => {
      if (uploadSetupDelayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, uploadSetupDelayMs));
      await prepareUploadStorage();
    })();
    await Promise.race([setup, failed]);
    if (failure) throw failure;
    busboy = Busboy({
      headers: req.headers,
      limits: {
        files: 1,
        // Busboy marks a stream truncated when this threshold is reached. Using
        // max + 1 makes the documented maximum inclusive without buffering.
        fileSize: uploadMaxFileBytes + 1,
      },
    });
  } catch (error) {
    req.off("aborted", abortUpload);
    req.off("error", requestError);
    if (failure) throw failure;
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "UPLOAD_PARSE_ERROR", error.message);
  }
  let fileSeen = false;

  const parsed = new Promise((resolveParsed, rejectParsed) => {
    busboy.on("file", (field, file, info) => {
      file.on("error", (error) => failOnce(error));
      if (field !== "file" || fileSeen) {
        failOnce(new HttpError(400, fileSeen ? "TOO_MANY_FILES" : "FILE_REQUIRED", "Upload field `file` is required."));
        return;
      }
      fileSeen = true;
      inputFile = file;
      filePromise = (async () => {
        const id = randomUUID();
        const originalName = safeUploadName(info.filename || "upload");
        const dir = join(uploadRoot, id);
        uploadDir = dir;
        activeUploadDirectories.add(id);
        // Keep user bytes distinct from our manifest, including for manifest.json.
        const filePath = join(dir, `file-${originalName}`);
        const createdAt = new Date();
        let size = 0;
        let reservedSize = 0;
        let committed = false;
        let tooLarge = false;
        try {
          await mkdir(dir, { recursive: true });
          if (failure) throw failure;
          outputFile = createWriteStream(filePath, { flags: "wx", mode: 0o600 });
          file.on("data", (chunk) => {
            try {
              size += chunk.length;
              if (size > uploadMaxFileBytes) {
                tooLarge = true;
                failOnce(
                  new HttpError(413, "UPLOAD_TOO_LARGE", `Upload limit is ${Math.round(uploadMaxFileBytes / 1024 / 1024)} MB.`),
                );
                return;
              }
              reserveUploadBytes(chunk.length);
              reservedSize += chunk.length;
            } catch (error) {
              failOnce(error);
            }
          });
          file.on("limit", () => {
            tooLarge = true;
            failOnce(
              new HttpError(413, "UPLOAD_TOO_LARGE", `Upload limit is ${Math.round(uploadMaxFileBytes / 1024 / 1024)} MB.`),
            );
          });
          await pipeline(file, outputFile);
          if (tooLarge || file.truncated || size > uploadMaxFileBytes) {
            throw new HttpError(413, "UPLOAD_TOO_LARGE", `Upload limit is ${Math.round(uploadMaxFileBytes / 1024 / 1024)} MB.`);
          }
          const manifest = {
            id,
            name: originalName,
            originalName,
            mime: info.mimeType || "application/octet-stream",
            size,
            path: filePath,
            createdAt: createdAt.toISOString(),
            expiresAt: new Date(createdAt.getTime() + uploadTtlMs).toISOString(),
          };
          await writeFile(uploadMetaPath(id), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
          releaseUploadBytes(reservedSize);
          uploadStoredBytes += size;
          reservedSize = 0;
          committed = true;
          return manifest;
        } catch (error) {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
          if (error instanceof HttpError) throw error;
          throw new HttpError(500, "UPLOAD_FAILED", error instanceof Error ? error.message : "Upload failed.");
        } finally {
          if (!committed) releaseUploadBytes(reservedSize);
          activeUploadDirectories.delete(id);
        }
      })();
      filePromise.catch((error) => {
        failOnce(error);
      });
    });

    busboy.on("filesLimit", () => {
      failOnce(new HttpError(400, "TOO_MANY_FILES", "Upload one file at a time."));
    });
    busboy.on("error", (error) => {
      failOnce(error);
      rejectParsed(failure);
    });
    busboy.on("finish", resolveParsed);
    req.pipe(busboy);
  });
  try {
    await Promise.race([parsed, failed]);
    if (failure) throw failure;
    if (!filePromise) throw new HttpError(400, "FILE_REQUIRED", "Upload field `file` is required.");
    const manifest = await filePromise;
    await writeAuditEventQuiet(auditLogPath, "attachment_upload", {
      attachmentId: manifest.id,
      name: manifest.name,
      mime: manifest.mime,
      size: manifest.size,
    });
    return manifest;
  } catch (error) {
    inputFile?.destroy();
    outputFile?.destroy();
    await filePromise?.catch(() => {});
    if (uploadDir) await rm(uploadDir, { recursive: true, force: true }).catch(() => {});
    throw failure || error;
  } finally {
    req.unpipe(busboy);
    req.off("aborted", abortUpload);
    req.off("error", requestError);
  }
}

async function saveUpload(req) {
  if (activeUploadCount >= uploadMaxConcurrent) {
    throw new HttpError(
      429,
      "UPLOAD_CONCURRENCY_LIMIT",
      `At most ${uploadMaxConcurrent} upload(s) may run concurrently; retry after one finishes.`,
    );
  }
  activeUploadCount += 1;
  try {
    return await saveUploadWithinLimits(req);
  } finally {
    activeUploadCount -= 1;
  }
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
      gitMode,
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
        const parts = line.split("\t");
        const hasParentFields = parts.length >= 7;
        const [hash = "", fullHash = "", parentsRaw = "", date = "", author = "", refs = "", ...subjectParts] = hasParentFields
          ? parts
          : [parts[0] || "", parts[0] || "", "", parts[1] || "", parts[2] || "", parts[3] || "", ...parts.slice(4)];
        return {
          hash,
          fullHash,
          parents: parentsRaw.split(" ").filter(Boolean),
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
    runCommand(
      "git",
      ["-C", rootReal, "log", "--date=short", "--pretty=format:%h%x09%H%x09%P%x09%ad%x09%an%x09%d%x09%s", "--max-count=30"],
      { timeoutMs: 5000 },
    ).catch(() => ""),
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
  const projectRoots = ["projects", ".openclaw/workspace/projects"];
  const projects = [];

  for (const rootPath of projectRoots) {
    const resolved = await resolveInsideFileRoot(rootPath);
    if (!resolved.ok) return resolved;
    let dirents;
    try {
      dirents = await readdir(resolved.absolutePath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;
      const absolutePath = join(resolved.absolutePath, dirent.name);
      try {
        await stat(join(absolutePath, ".git"));
        const status = await runCommand("git", ["-C", absolutePath, "status", "--short", "--branch"], { timeoutMs: 5000 }).catch(
          () => "",
        );
        const lines = status ? status.split("\n") : [];
        const header = parseStatusHeader(lines.find((line) => line.startsWith("##")) || "");
        projects.push({
          name: dirent.name,
          path: `${rootPath}/${dirent.name}`,
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasValidProjectBindings(projectBindings) {
  return (
    isPlainObject(projectBindings) &&
    Object.entries(projectBindings).every(
      ([sessionKey, projectPath]) =>
        sessionKey.length > 0 &&
        sessionKey === sessionKey.trim() &&
        typeof projectPath === "string" &&
        projectPath.length > 0 &&
        projectPath === projectPath.trim(),
    )
  );
}

function isValidV1SessionState(state) {
  return hasExactKeys(state, ["version", "projectBindings"]) && state.version === 1 && hasValidProjectBindings(state.projectBindings);
}

function isValidV2SessionState(state) {
  if (
    !hasExactKeys(state, ["version", "poolEntries", "projectBindings"]) ||
    state.version !== 2 ||
    !Array.isArray(state.poolEntries) ||
    !hasValidProjectBindings(state.projectBindings)
  ) {
    return false;
  }
  const seenPoolKeys = new Set();
  return state.poolEntries.every((entry) => {
    if (!hasExactKeys(entry, ["key", "displayName", "createdAt"])) return false;
    if (
      typeof entry.key !== "string" ||
      !entry.key ||
      entry.key !== entry.key.trim() ||
      seenPoolKeys.has(entry.key) ||
      typeof entry.displayName !== "string" ||
      !entry.displayName ||
      entry.displayName !== entry.displayName.trim() ||
      entry.displayName.length > 80 ||
      typeof entry.createdAt !== "string" ||
      !entry.createdAt ||
      !Number.isFinite(Date.parse(entry.createdAt))
    ) {
      return false;
    }
    seenPoolKeys.add(entry.key);
    return true;
  });
}

function migrateAppSessionState(state) {
  if (state.version === 2) {
    return {
      version: 2,
      poolEntries: state.poolEntries.map((entry) => ({ ...entry })),
      projectBindings: { ...state.projectBindings },
    };
  }
  return { version: 2, poolEntries: [], projectBindings: { ...state.projectBindings } };
}

async function readAppSessionState() {
  let raw;
  try {
    raw = await readFile(appSessionStatePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 2, poolEntries: [], projectBindings: {} };
    throw new HttpError(
      500,
      "SESSION_STATE_UNREADABLE",
      `Cannot read ${appSessionStatePath}; restore its permissions or a known-good backup before retrying.`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(
      500,
      "SESSION_STATE_CORRUPT",
      `Cannot parse ${appSessionStatePath}; preserve it and restore a known-good backup before retrying.`,
    );
  }
  if (!isValidV1SessionState(parsed) && !isValidV2SessionState(parsed)) {
    throw new HttpError(
      500,
      "SESSION_STATE_CORRUPT",
      `${appSessionStatePath} has an invalid structure; preserve it and restore a known-good backup before retrying.`,
    );
  }
  return migrateAppSessionState(parsed);
}

async function writeAppSessionState(state) {
  if (!isValidV2SessionState(state)) throw new Error("Refusing to write invalid v2 session state.");
  await mkdir(dataDir, { recursive: true });
  const tmp = `${appSessionStatePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, appSessionStatePath);
}

let appSessionStateWork = Promise.resolve();

function withAppSessionStateLock(work) {
  const result = appSessionStateWork.then(work, work);
  appSessionStateWork = result.catch(() => {});
  return result;
}

function mobileStudioSessionName(index) {
  return `Mobile Studio ${index}`;
}

function mobileStudioSessionKey(index) {
  return `agent:main:mobile-studio:session:pool-${index}`;
}

function completePoolEntries(state) {
  const now = new Date().toISOString();
  const poolEntries = state.poolEntries.map((entry, index) => ({
    ...entry,
    displayName: entry.displayName || mobileStudioSessionName(index + 1),
    createdAt: entry.createdAt || now,
  }));
  const knownKeys = new Set(poolEntries.map((entry) => entry.key));

  for (const key of Object.keys(state.projectBindings)) {
    if (!key.startsWith("agent:main:mobile-studio:session:") || knownKeys.has(key)) continue;
    poolEntries.push({ key, displayName: mobileStudioSessionName(poolEntries.length + 1), createdAt: now });
    knownKeys.add(key);
  }

  for (let index = 1; poolEntries.length < sessionPoolSize; index += 1) {
    const key = mobileStudioSessionKey(index);
    if (knownKeys.has(key)) continue;
    poolEntries.push({ key, displayName: mobileStudioSessionName(poolEntries.length + 1), createdAt: now });
    knownKeys.add(key);
  }

  return { ...state, poolEntries };
}

async function ensureAppSessionPool() {
  return withAppSessionStateLock(async () => {
    const previous = await readAppSessionState();
    const completed = completePoolEntries(previous);
    if (JSON.stringify(completed) !== JSON.stringify(previous)) await writeAppSessionState(completed);
    return completed;
  });
}

function activePoolEntries(state) {
  return state.poolEntries.slice(0, sessionPoolSize);
}

async function isActivePoolSession(sessionKey) {
  const state = await ensureAppSessionPool();
  return activePoolEntries(state).some((entry) => entry.key === sessionKey);
}

async function normalizeProjectBindingPath(projectPath) {
  const value = String(projectPath || "").trim();
  if (!value) return "";
  const repo = await getRepoRootFromPath(value);
  if (!repo.ok) throw new HttpError(repo.status || 400, repo.code || "INVALID_PROJECT_PATH", repo.message || "Invalid project path.");
  if (!repo.isRepo) throw new HttpError(400, "NOT_REPOSITORY", "Project path is not a Git repository.");
  return repo.rootDisplayPath;
}

async function setSessionProject(req) {
  const body = await readJson(req);
  const sessionKey = String(body.sessionKey || "").trim();
  const projectPath = await normalizeProjectBindingPath(body.projectPath || "");
  if (!sessionKey) return { ok: false, status: 400, code: "SESSION_KEY_REQUIRED", message: "sessionKey is required." };
  const updated = await withAppSessionStateLock(async () => {
    const appState = completePoolEntries(await readAppSessionState());
    if (!activePoolEntries(appState).some((entry) => entry.key === sessionKey)) return false;
    if (!projectPath) delete appState.projectBindings[sessionKey];
    else appState.projectBindings[sessionKey] = projectPath;
    await writeAppSessionState(appState);
    return true;
  });
  if (!updated) return { ok: false, status: 404, code: "SESSION_NOT_FOUND", message: "Pool session not found." };
  await writeAuditEventQuiet(auditLogPath, projectPath ? "session_project_attach" : "session_project_detach", {
    sessionKey,
    projectPath,
  });
  return { ok: true, sessionKey, projectPath };
}

async function listSessions() {
  const appState = await ensureAppSessionPool();
  const entries = activePoolEntries(appState);
  let result = null;
  let gatewayError = null;
  try {
    result = await gatewayCall("sessions.list", { limit: 200 }, { timeoutMs: 10000 });
  } catch (error) {
    gatewayError = error instanceof Error ? error.message : String(error);
  }
  const gatewaySessions = new Map(
    (Array.isArray(result?.sessions) ? result.sessions : []).map((session) => [session.key, normalizeSession(session)]),
  );
  const sessions = entries.map((entry) => {
    const gatewaySession = gatewaySessions.get(entry.key);
    return {
      ...(gatewaySession || {
        key: entry.key,
        sessionId: null,
        agentId: "main",
        kind: "mobile-studio",
        status: "",
        updatedAt: null,
        model: null,
        modelProvider: null,
        runtime: null,
        abortedLastRun: false,
        hasActiveRun: false,
        startedAt: null,
        endedAt: null,
        runtimeMs: null,
        thinkingLevel: null,
        effectiveFastMode: null,
        estimatedCostUsd: null,
        totalTokens: null,
        contextTokens: null,
      }),
      key: entry.key,
      displayName: entry.displayName,
      subject: entry.displayName,
      materialized: Boolean(gatewaySession?.sessionId),
      hasLocalHistory: Boolean(gatewaySession?.sessionId),
      projectPath: appState.projectBindings[entry.key] || "",
    };
  });
  return {
    ok: true,
    sessions,
    defaults: result?.defaults || null,
    count: sessions.length,
    poolSize: sessionPoolSize,
    source: result ? "app+gateway" : "app",
    gatewayError,
  };
}

async function getHistory(url) {
  const sessionKey = url.searchParams.get("sessionKey") || "";
  const limit = Math.min(Number.parseInt(url.searchParams.get("limit") || String(defaultLimit), 10), 200);
  if (!sessionKey.trim()) {
    return { ok: false, status: 400, code: "SESSION_KEY_REQUIRED", message: "sessionKey is required." };
  }
  if (!(await isActivePoolSession(sessionKey))) {
    return { ok: false, status: 404, code: "SESSION_NOT_FOUND", message: "Pool session not found." };
  }
  const params = {
    sessionKey,
    limit,
    maxChars,
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

function scopedTasks(rawTasks, activeSessionKeys) {
  return rawTasks
    .map(normalizeTask)
    .filter((task) => task.sessionKey && activeSessionKeys.has(task.sessionKey));
}

async function getRunState(url) {
  const sessionKey = url.searchParams.get("sessionKey") || "";
  const includeDetails = url.searchParams.get("details") === "1";
  if (!sessionKey.trim()) {
    return { ok: false, status: 400, code: "SESSION_KEY_REQUIRED", message: "sessionKey is required." };
  }

  const sessionsResult = await listSessions();
  const session = sessionsResult.sessions.find((item) => item.key === sessionKey) || null;
  if (!session) return { ok: false, status: 404, code: "SESSION_NOT_FOUND", message: "Pool session not found." };
  const sessionSource = sessionsResult.source;

  const [tasksResult, approvalsResult] = includeDetails
    ? await Promise.allSettled([
        gatewayCall("tasks.list", {}, { timeoutMs: 12000, processTimeoutMs: 15000 }),
        gatewayCall("exec.approvals.get", {}, { timeoutMs: 12000, processTimeoutMs: 15000 }),
      ])
    : [{ status: "fulfilled", value: { tasks: [] } }, { status: "fulfilled", value: null }];

  const tasksRaw = tasksResult.status === "fulfilled" && Array.isArray(tasksResult.value.tasks) ? tasksResult.value.tasks : [];
  const scoped = scopedTasks(tasksRaw, new Set([sessionKey])).sort((a, b) => taskTimestamp(b) - taskTimestamp(a));
  const tasks = scoped.slice(0, 8);
  const approvals = approvalsResult.status === "fulfilled" ? approvalsResult.value : null;

  return {
    ok: true,
    sessionKey,
    session,
    source: sessionSource,
    tasks,
    taskCount: scoped.length,
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

function sanitizeAuditEventForPool(event, activePoolKeys) {
  if (!isPlainObject(event?.meta)) return event;
  if (!Object.hasOwn(event.meta, "sessionKey")) return event;
  const sessionKey = event.meta.sessionKey;
  if (typeof sessionKey === "string" && activePoolKeys.has(sessionKey)) return event;
  const { sessionKey: _externalSessionKey, agentId: _externalAgentId, ...meta } = event.meta;
  return { ...event, meta };
}

async function readPoolAuditEvents(limit, activePoolKeys) {
  const keys = activePoolKeys || new Set(activePoolEntries(await ensureAppSessionPool()).map((entry) => entry.key));
  const events = await readAuditEvents(auditLogPath, limit);
  return events.map((event) => sanitizeAuditEventForPool(event, keys));
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
  const activePoolKeys = new Set(sessions.map((session) => session.key));
  const projects = projectsResult.status === "fulfilled" ? projectsResult.value.projects || [] : [];
  const rawTasks = tasksResult.status === "fulfilled" && Array.isArray(tasksResult.value.tasks) ? tasksResult.value.tasks : [];
  const tasks = scopedTasks(rawTasks, activePoolKeys).sort((a, b) => taskTimestamp(b) - taskTimestamp(a));
  const approvals = approvalsResult.status === "fulfilled" ? approvalsResult.value : null;
  const health = healthResult.status === "fulfilled" ? healthResult.value : null;
  const auditEvents = await readPoolAuditEvents(8, activePoolKeys).catch(() => []);

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

async function resolveChatAttachments(rawAttachments) {
  const items = Array.isArray(rawAttachments) ? rawAttachments : [];
  if (items.length > uploadMaxAttachmentsPerMessage) {
    throw new HttpError(
      400,
      "TOO_MANY_ATTACHMENTS",
      `Attach at most ${uploadMaxAttachmentsPerMessage} file(s) per message.`,
    );
  }
  return Promise.all(
    items.map(async (item) => {
      const id = typeof item === "string" ? item : item?.id;
      return readUploadManifest(id);
    }),
  );
}

const projectAuditActions = new Set(projectActions.map((action) => action.id));
const projectAuditMetaKeys = new Set([
  "action",
  "projectPath",
  "branch",
  "sessionKey",
  "agentId",
  "command",
  "messageLength",
]);

async function classifySendAudit(rawAudit, sessionKey, attachments) {
  const audit = rawAudit && typeof rawAudit === "object" && !Array.isArray(rawAudit) ? rawAudit : null;
  if (audit?.type !== "project_action") return { type: "chat_send", meta: {} };
  const meta = audit.meta && typeof audit.meta === "object" && !Array.isArray(audit.meta) ? audit.meta : null;
  const action = typeof meta?.action === "string" ? meta.action : "";
  const projectPath = typeof meta?.projectPath === "string" ? meta.projectPath.trim() : "";
  const branch = meta?.branch === undefined || typeof meta.branch === "string" ? meta?.branch || "" : null;
  if (
    !meta ||
    !projectAuditActions.has(action) ||
    !projectPath ||
    branch === null ||
    Object.keys(meta).some((key) => !projectAuditMetaKeys.has(key)) ||
    attachments.length > 0
  ) {
    throw new HttpError(
      400,
      "INVALID_PROJECT_ACTION_AUDIT",
      "Project action audit metadata must name an allowed action and project, and cannot include attachments or unknown fields.",
    );
  }
  const state = await ensureAppSessionPool();
  if (state.projectBindings[sessionKey] !== projectPath) {
    throw new HttpError(
      400,
      "INVALID_PROJECT_ACTION_AUDIT",
      "Project action audit metadata must match the project attached to this session.",
    );
  }
  let repositoryBranch = "";
  try {
    const repo = await getRepoRootFromPath(projectPath);
    if (repo.ok && repo.isRepo && repo.rootDisplayPath === projectPath) {
      repositoryBranch = (await runCommand("git", ["-C", repo.rootReal, "branch", "--show-current"], { timeoutMs: 5000 })).trim();
    }
  } catch {
    // Audit remains useful without a branch when the bound repository cannot be safely inspected.
  }
  return {
    type: "project_action",
    meta: { action, projectPath, ...(repositoryBranch ? { branch: repositoryBranch } : {}) },
  };
}

function attachmentPromptBlock(attachments) {
  if (!attachments.length) return "";
  const lines = [
    "",
    "",
    "Allegati gia caricati sul server e leggibili dal filesystem:",
    ...attachments.map((attachment, index) =>
      [
        `${index + 1}. ${attachment.name}`,
        `   path: ${attachment.path}`,
        `   mime: ${attachment.mime}`,
        `   size: ${attachment.size} bytes`,
        `   expiresAt: ${attachment.expiresAt}`,
      ].join("\n"),
    ),
    "",
    "Usa questi path per leggere i file. Se un file deve restare, copialo esplicitamente nel progetto o nell'archivio prima del cleanup.",
  ];
  return lines.join("\n");
}

async function sendMessage(req) {
  const body = await readJson(req);
  const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const attachments = await resolveChatAttachments(body.attachments);
  const idempotencyKey =
    typeof body.idempotencyKey === "string" && body.idempotencyKey.trim()
      ? body.idempotencyKey.trim()
      : `mobile-studio:${randomUUID()}`;
  if (!sessionKey) {
    return { ok: false, status: 400, code: "SESSION_KEY_REQUIRED", message: "sessionKey is required." };
  }
  if (!(await isActivePoolSession(sessionKey))) {
    return { ok: false, status: 404, code: "SESSION_NOT_FOUND", message: "Pool session not found." };
  }
  if (!message && attachments.length === 0) {
    return { ok: false, status: 400, code: "MESSAGE_REQUIRED", message: "message or attachment is required." };
  }
  const audit = await classifySendAudit(body.audit, sessionKey, attachments);
  const outboundMessage = `${message || "Analizza gli allegati caricati."}${attachmentPromptBlock(attachments)}`;
  const result = await gatewayCall(
    "chat.send",
    {
      sessionKey,
      message: outboundMessage,
      deliver: false,
      idempotencyKey,
    },
    { timeoutMs: 20000, processTimeoutMs: 25000 },
  );
  const command = message.startsWith("/") ? message.split(/\s+/)[0].slice(0, 80) : "";
  await writeAuditEventQuiet(auditLogPath, audit.type, {
    ...audit.meta,
    sessionKey,
    agentId: "main",
    command,
    messageLength: outboundMessage.length,
    attachmentCount: attachments.length,
    attachmentBytes: attachments.reduce((total, attachment) => total + (Number(attachment.size) || 0), 0),
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
  if (!sessionKey) {
    return { ok: false, status: 400, code: "SESSION_KEY_REQUIRED", message: "sessionKey is required." };
  }
  if (!(await isActivePoolSession(sessionKey))) {
    return { ok: false, status: 404, code: "SESSION_NOT_FOUND", message: "Pool session not found." };
  }
  const result = await gatewayCall(
    "chat.abort",
    {
      sessionKey,
      ...(runId ? { runId } : {}),
    },
    { timeoutMs: 10000 },
  );
  await writeAuditEventQuiet(auditLogPath, "run_abort", { sessionKey, runId, agentId: "main" });
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
    if (req.method === "GET" && url.pathname === "/api/config") {
      sendJson(res, 200, { ok: true, gitMode });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/sessions") {
      sendJson(res, 200, await listSessions());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/sessions") {
      sendError(res, 405, "SESSION_POOL_FIXED", "Session creation is disabled; Mobile Studio provisions a fixed pool automatically.");
      return;
    }
    if (req.method === "DELETE" && url.pathname === "/api/sessions") {
      sendError(res, 405, "SESSION_POOL_FIXED", "Session deletion is disabled for the fixed Mobile Studio pool.");
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/session-project") {
      const result = await setSessionProject(req);
      if (!result.ok) sendError(res, result.status, result.code, result.message);
      else sendJson(res, 200, result);
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
      sendJson(res, 200, { ok: true, events: await readPoolAuditEvents(limit) });
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
      if (gitMode !== "write") {
        sendError(
          res,
          403,
          "GIT_WRITES_DISABLED",
          "Git writes are disabled. Set MOBILE_STUDIO_GIT_MODE=write and restart Mobile Studio to enable guarded writes.",
        );
        return;
      }
      const result = await switchProjectBranch(req);
      if (!result.ok) sendError(res, result.status, result.code, result.message);
      else sendJson(res, 200, result);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/project/git-action") {
      if (gitMode !== "write") {
        sendError(
          res,
          403,
          "GIT_WRITES_DISABLED",
          "Git writes are disabled. Set MOBILE_STUDIO_GIT_MODE=write and restart Mobile Studio to enable guarded writes.",
        );
        return;
      }
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
    if (req.method === "POST" && url.pathname === "/api/uploads") {
      const attachment = await saveUpload(req);
      sendJson(res, 200, { ok: true, attachment });
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
    if (error instanceof HttpError) {
      sendError(res, error.status, error.code, error.message);
      return;
    }
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
