import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAuditEvents, writeAuditEvent, writeAuditEventQuiet } from "../lib/audit.js";

async function auditPath(t) {
  const dir = await mkdtemp(join(tmpdir(), "oms-audit-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "audit.jsonl");
}

test("audit stores allowed metadata without raw messages, bodies or nested values", async (t) => {
  const path = await auditPath(t);
  const event = await writeAuditEvent(path, "chat_send", {
    sessionKey: "session-a", agentId: "x".repeat(400), messageLength: 42,
    attachmentCount: 2, attachmentBytes: 99, command: { text: "nested" },
    message: "synthetic-private-prompt", token: "synthetic-token", body: { text: "private" },
  });
  assert.deepEqual(event.meta, {
    sessionKey: "session-a", agentId: "x".repeat(300), messageLength: 42,
    attachmentCount: 2, attachmentBytes: 99,
  });
  assert.match(event.id, /^[0-9a-f-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(event.ts)));
  assert.deepEqual(await readAuditEvents(path), [event]);
  assert.doesNotMatch(await readFile(path, "utf8"), /synthetic-private-prompt|synthetic-token|nested/);
});

test("audit preserves false and zero, drops invalid scalars and unknown event metadata", async (t) => {
  const path = await auditPath(t);
  const event = await writeAuditEvent(path, "git_action", {
    changed: false, files: 0, commits: Infinity, branch: "", tracking: null, projectPath: [], messageLength: NaN,
  });
  assert.deepEqual(event.meta, { changed: false, files: 0 });
  assert.deepEqual((await writeAuditEvent(path, "custom_event", { message: "private" })).meta, {});
  assert.deepEqual((await writeAuditEvent(path, "chat_send", [])).meta, {});
});

test("attachment audit records size and identity but never filesystem paths or contents", async (t) => {
  const path = await auditPath(t);
  const event = await writeAuditEvent(path, "attachment_upload", {
    attachmentId: "test-id", name: "sample.txt", mime: "text/plain", size: 12,
    path: "/private/sample.txt", content: "synthetic-private-content",
  });
  assert.deepEqual(event.meta, { attachmentId: "test-id", name: "sample.txt", mime: "text/plain", size: 12 });
});

test("session lifecycle events retain identifying metadata without session contents", async (t) => {
  const path = await auditPath(t);
  for (const type of ["session_create", "session_delete", "session_project_attach", "session_project_detach"]) {
    const event = await writeAuditEvent(path, type, {
      sessionKey: "session-a", projectPath: "projects/example", message: "private", entry: { history: "private" },
    });
    assert.deepEqual(event.meta, {
      sessionKey: "session-a",
      ...(type.startsWith("session_project_") ? { projectPath: "projects/example" } : {}),
    });
  }
});

test("audit reads newest first, bounds limits, skips malformed lines and tolerates missing logs", async (t) => {
  const path = await auditPath(t);
  assert.deepEqual(await readAuditEvents(path), []);
  const entries = Array.from({ length: 205 }, (_, id) => ({ id }));
  await writeFile(path, entries.map(JSON.stringify).join("\n") + "\ninvalid-json\n");
  assert.deepEqual(await readAuditEvents(path, 3), [{ id: 204 }, { id: 203 }]);
  await writeFile(path, entries.map(JSON.stringify).join("\n") + "\n");
  assert.equal((await readAuditEvents(path, 999)).length, 200);
  assert.deepEqual(await readAuditEvents(path, -1), [{ id: 204 }]);
  assert.equal((await readAuditEvents(path, "invalid")).length, 40);
});

test("audit reads only a bounded tail and drops its partial first line", async (t) => {
  const path = await auditPath(t);
  await writeFile(path, JSON.stringify({ id: "large", padding: "x".repeat(300_000) }) + '\n{"id":"last"}\n');
  assert.deepEqual(await readAuditEvents(path), [{ id: "last" }]);
});

test("audit rotates at 1 MiB, retains one archive, and starts a readable active log", async (t) => {
  const path = await auditPath(t);
  await writeFile(path, "x".repeat(1024 * 1024 - 1));
  const first = await writeAuditEvent(path, "chat_send", { messageLength: 3 });
  await assert.rejects(stat(`${path}.1`), { code: "ENOENT" });
  const beforeRotation = await readFile(path, "utf8");
  assert.ok(beforeRotation.includes(first.id));
  const second = await writeAuditEvent(path, "chat_send", { messageLength: 4 });
  assert.equal(await readFile(`${path}.1`, "utf8"), beforeRotation);
  assert.deepEqual(await readAuditEvents(path), [second]);
  const replacement = "y".repeat(1024 * 1024);
  await writeFile(path, replacement);
  const third = await writeAuditEvent(path, "chat_send");
  assert.equal(await readFile(`${path}.1`, "utf8"), replacement);
  assert.deepEqual(await readAuditEvents(path), [third]);
});

test("quiet audit writes suppress filesystem errors; explicit writes report them", async (t) => {
  const path = await auditPath(t);
  await writeFile(path, "not a directory");
  assert.equal(await writeAuditEventQuiet(join(path, "child"), "chat_send"), null);
  await assert.rejects(writeAuditEvent(join(path, "child"), "chat_send"));
});
