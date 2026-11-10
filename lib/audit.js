import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

const maxAuditBytes = 1024 * 1024;
const maxAuditReadBytes = 256 * 1024;

const allowedMetaKeys = {
  project_action: ["sessionKey", "agentId", "command", "messageLength", "action", "projectPath", "branch"],
  chat_send: ["sessionKey", "agentId", "command", "messageLength", "attachmentCount", "attachmentBytes"],
  attachment_upload: ["attachmentId", "name", "mime", "size"],
  git_action: ["action", "projectPath", "branch", "tracking", "changed", "files", "messageLength", "commits"],
  branch_switch: ["projectPath", "branch", "remote", "mode"],
  run_abort: ["sessionKey", "runId", "agentId"],
  session_create: ["sessionKey"],
  session_delete: ["sessionKey"],
  session_project_attach: ["sessionKey", "projectPath"],
  session_project_detach: ["sessionKey", "projectPath"],
};

function cleanAuditValue(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 300);
  return undefined;
}

function cleanAuditMeta(type, meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  const allowed = new Set(allowedMetaKeys[type] || []);
  const clean = {};
  for (const key of allowed) {
    const value = cleanAuditValue(meta[key]);
    if (value !== undefined) clean[key] = value;
  }
  return clean;
}

async function rotateAuditLogIfNeeded(auditLogPath) {
  try {
    const info = await stat(auditLogPath);
    if (info.size < maxAuditBytes) return;
    await rename(auditLogPath, `${auditLogPath}.1`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function writeAuditEvent(auditLogPath, type, meta = {}) {
  const safeType = String(type || "event").slice(0, 80);
  const event = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    type: safeType,
    meta: cleanAuditMeta(safeType, meta),
  };
  await mkdir(dirname(auditLogPath), { recursive: true });
  await rotateAuditLogIfNeeded(auditLogPath);
  await appendFile(auditLogPath, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

export async function writeAuditEventQuiet(auditLogPath, type, meta = {}) {
  try {
    return await writeAuditEvent(auditLogPath, type, meta);
  } catch {
    return null;
  }
}

export async function readAuditEvents(auditLogPath, limit = 40) {
  const safeLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 40, 1), 200);
  let handle;
  try {
    handle = await open(auditLogPath, "r");
    const info = await handle.stat();
    const length = Math.min(info.size, maxAuditReadBytes);
    const start = Math.max(0, info.size - length);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    const lines = text.trim().split(/\r?\n/).filter(Boolean).slice(-safeLimit);
    const events = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // Ignore partially written or malformed historical audit lines.
      }
    }
    return events.reverse();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}
