import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout } from "node:timers/promises";

async function startUploadServer(t, options = {}) {
  // Copy only application code into a disposable root: never use real runtime data.
  const dir = await mkdtemp(join(tmpdir(), "oms-upload-test-"));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    await rm(dir, { recursive: true, force: true });
  });
  const root = new URL("../", import.meta.url);
  await cp(new URL("server.js", root), join(dir, "server.mjs"));
  await cp(new URL("package.json", root), join(dir, "package.json"));
  await cp(new URL("lib/", root), join(dir, "lib"), { recursive: true });
  await cp(new URL("public/", root), join(dir, "public"), { recursive: true });
  await symlink(fileURLToPath(new URL("node_modules/", root)), join(dir, "node_modules"), "dir");
  // The wrapper reports the OS-assigned port without changing production startup.
  await writeFile(join(dir, "start.mjs"), `
    import { Server } from 'node:http';
    const listen = Server.prototype.listen;
    Server.prototype.listen = function (...args) {
      this.once('listening', () => process.send({ port: this.address().port }));
      return listen.apply(this, args);
    };
    await import('./server.mjs');
  `);
  child = spawn(process.execPath, [join(dir, "start.mjs")], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      HOST: "127.0.0.1", PORT: "0",
      MOBILE_STUDIO_TOKEN: "",
      MOBILE_STUDIO_FILE_ROOT: dir,
      MOBILE_STUDIO_UPLOAD_DIR: join(dir, "uploads"),
      MOBILE_STUDIO_MAX_UPLOAD_BYTES: String(options.maxBytes || 64),
      MOBILE_STUDIO_MAX_TOTAL_UPLOAD_BYTES: String(options.maxTotalBytes || 1024),
      MOBILE_STUDIO_MAX_CONCURRENT_UPLOADS: String(options.maxConcurrent || 2),
      MOBILE_STUDIO_UPLOAD_TTL_MS: String(options.ttlMs || 60_000),
      MOBILE_STUDIO_TEST_UPLOAD_SETUP_DELAY_MS: String(options.setupDelayMs || 0),
      OPENCLAW_BIN: "/bin/false",
      OPENCLAW_SESSIONS_DIR: join(dir, "sessions"),
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let errors = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { errors += chunk; });
  const [address] = await once(child, "message", { signal: AbortSignal.timeout(5000) });
  return {
    dir,
    baseUrl: `http://127.0.0.1:${address.port}`,
    url: `http://127.0.0.1:${address.port}/api/uploads`,
    assertAlive() { assert.equal(child.exitCode, null, `upload crashed the server: ${errors}`); },
  };
}

async function upload(server, name, content) {
  const form = new FormData();
  form.append("file", new Blob([content], { type: "text/plain" }), name);
  return fetch(server.url, { method: "POST", body: form, signal: AbortSignal.timeout(5000) });
}

async function responseJson(response) {
  let body = "";
  response.setEncoding("utf8");
  for await (const chunk of response) body += chunk;
  return JSON.parse(body);
}

async function beginSlowMultipart(server, initialBody) {
  const req = request(server.url, {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=fixture" },
  });
  req.on("error", () => {});
  req.write(initialBody);
  const [response] = await once(req, "response", { signal: AbortSignal.timeout(3000) });
  return { req, response };
}

test("uploads named manifest.json retain their original bytes separately from metadata", async (t) => {
  const server = await startUploadServer(t);
  const response = await upload(server, "manifest.json", "user file contents");
  assert.equal(response.status, 200);
  const { attachment } = await response.json();
  assert.equal(attachment.name, "manifest.json");
  assert.equal(attachment.size, 18);
  assert.equal(await readFile(attachment.path, "utf8"), "user file contents");
  const manifest = JSON.parse(await readFile(join(server.dir, "uploads", attachment.id, "manifest.json"), "utf8"));
  assert.equal(manifest.path, attachment.path);
  server.assertAlive();
});

test("oversized uploads return 413, clean partial files, and keep the server available", async (t) => {
  const server = await startUploadServer(t);
  const response = await upload(server, "large.txt", "x".repeat(128));
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "UPLOAD_TOO_LARGE");
  assert.deepEqual(await readdir(join(server.dir, "uploads")), []);
  assert.equal((await upload(server, "small.txt", "ok")).status, 200);
  server.assertAlive();
});

test("truncated multipart uploads return 400 and leave the server available", async (t) => {
  const server = await startUploadServer(t);
  const response = await fetch(server.url, {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=fixture" },
    body: '--fixture\r\nContent-Disposition: form-data; name="file"; filename="sample.txt"\r\nContent-Type: text/plain\r\n\r\nunfinished',
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "UPLOAD_PARSE_ERROR");
  // A second malformed request also proves the process survives parser errors.
  const next = await fetch(server.url, { method: "POST", signal: AbortSignal.timeout(5000) });
  assert.equal(next.status, 400);
  assert.deepEqual(await readdir(join(server.dir, "uploads")), []);
  assert.equal((await upload(server, "small.txt", "ok")).status, 200);
  server.assertAlive();
});

test("multiple files are rejected and cleaned without recording a successful upload", async (t) => {
  const server = await startUploadServer(t);
  const form = new FormData();
  form.append("file", new Blob(["first"]), "first.txt");
  form.append("file", new Blob(["second"]), "second.txt");
  const response = await fetch(server.url, { method: "POST", body: form, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "TOO_MANY_FILES");
  assert.deepEqual(await readdir(join(server.dir, "uploads")), []);
  await assert.rejects(readFile(join(server.dir, "data", "audit-log.jsonl")), { code: "ENOENT" });
  server.assertAlive();
});

test("missing file fields return 400 without creating attachment data", async (t) => {
  const server = await startUploadServer(t);
  const form = new FormData();
  form.append("description", "no file");
  const response = await fetch(server.url, { method: "POST", body: form, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "FILE_REQUIRED");
  assert.deepEqual(await readdir(join(server.dir, "uploads")), []);
});

async function waitUntil(predicate) {
  const deadline = Date.now() + 3000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, "timed out waiting for upload cleanup state");
    await setTimeout(10);
  }
}

test("client disconnect cleans a partial upload and keeps the server available", async (t) => {
  const server = await startUploadServer(t);
  const req = request(server.url, {
    method: "POST", headers: { "content-type": "multipart/form-data; boundary=fixture" },
  });
  req.on("error", () => {});
  t.after(() => req.destroy());
  req.write('--fixture\r\nContent-Disposition: form-data; name="file"; filename="partial.txt"\r\n\r\npartial');
  const uploads = () => readdir(join(server.dir, "uploads")).catch(() => []);
  await waitUntil(async () => (await uploads()).length === 1);
  req.destroy();
  await waitUntil(async () => (await uploads()).length === 0);
  assert.equal((await upload(server, "small.txt", "ok")).status, 200);
  server.assertAlive();
});

test("upload maximum is inclusive at max-1, max, and max+1 bytes", async (t) => {
  const server = await startUploadServer(t, { maxBytes: 64 });
  assert.equal((await upload(server, "under.bin", "x".repeat(63))).status, 200);
  assert.equal((await upload(server, "exact.bin", "x".repeat(64))).status, 200);
  const over = await upload(server, "over.bin", "x".repeat(65));
  assert.equal(over.status, 413);
  assert.equal((await over.json()).error.code, "UPLOAD_TOO_LARGE");
  server.assertAlive();
});

test("expired attachment manifests are rejected on send and removed", async (t) => {
  const server = await startUploadServer(t, { ttlMs: 20 });
  const uploadResponse = await upload(server, "short-lived.txt", "abc");
  assert.equal(uploadResponse.status, 200);
  const { attachment } = await uploadResponse.json();
  await setTimeout(Math.max(0, Date.parse(attachment.expiresAt) - Date.now()) + 20);

  const response = await fetch(`${server.baseUrl}/api/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionKey: "agent:main:mobile-studio:session:pool-1",
      message: "read attachment",
      attachments: [{ id: attachment.id }],
    }),
  });
  assert.equal(response.status, 410);
  assert.equal((await response.json()).error.code, "ATTACHMENT_EXPIRED");
  assert.deepEqual(await readdir(join(server.dir, "uploads")), []);
  server.assertAlive();
});

test("upload maintenance removes expired, malformed, partial, and orphaned directories without leaving the root", async (t) => {
  const server = await startUploadServer(t);
  const uploadRoot = join(server.dir, "uploads");
  const outsideRoot = join(server.dir, "outside-sentinel");
  await mkdir(uploadRoot, { recursive: true });
  await mkdir(outsideRoot);
  await writeFile(join(outsideRoot, "keep.txt"), "keep");

  const malformedId = "11111111-1111-4111-8111-111111111111";
  await mkdir(join(uploadRoot, malformedId));
  await writeFile(join(uploadRoot, malformedId, "manifest.json"), "{broken");

  await mkdir(join(uploadRoot, "orphan-directory"));
  await writeFile(join(uploadRoot, "orphan-directory", "file-partial.txt"), "partial");

  const missingId = "22222222-2222-4222-8222-222222222222";
  await mkdir(join(uploadRoot, missingId));
  await writeFile(
    join(uploadRoot, missingId, "manifest.json"),
    JSON.stringify({
      id: missingId,
      name: "missing.txt",
      size: 7,
      path: join(uploadRoot, missingId, "file-missing.txt"),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );

  const expiredId = "33333333-3333-4333-8333-333333333333";
  const expiredDir = join(uploadRoot, expiredId);
  await mkdir(expiredDir);
  await writeFile(join(expiredDir, "file-expired.txt"), "old");
  await writeFile(
    join(expiredDir, "manifest.json"),
    JSON.stringify({
      id: expiredId,
      name: "expired.txt",
      size: 3,
      path: join(expiredDir, "file-expired.txt"),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }),
  );

  const poisonedId = "44444444-4444-4444-8444-444444444444";
  await mkdir(join(uploadRoot, poisonedId));
  await writeFile(
    join(uploadRoot, poisonedId, "manifest.json"),
    JSON.stringify({
      id: poisonedId,
      name: "outside.txt",
      size: 4,
      path: join(outsideRoot, "keep.txt"),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  await symlink(outsideRoot, join(uploadRoot, "outside-link"), "dir");

  const response = await upload(server, "fresh.txt", "fresh");
  assert.equal(response.status, 200);
  const { attachment } = await response.json();
  assert.deepEqual((await readdir(uploadRoot)).sort(), [attachment.id, "outside-link"].sort());
  assert.equal(await readFile(join(outsideRoot, "keep.txt"), "utf8"), "keep");
  server.assertAlive();
});

test("upload maintenance rejects manifest and payload symlinks without touching their targets", async (t) => {
  const server = await startUploadServer(t);
  const uploadRoot = join(server.dir, "uploads");
  const outsideRoot = join(server.dir, "outside-upload-targets");
  await mkdir(uploadRoot, { recursive: true });
  await mkdir(outsideRoot);

  const externalManifest = join(outsideRoot, "manifest-target.json");
  const externalPayload = join(outsideRoot, "payload-target.txt");
  await writeFile(externalManifest, '{"poisoned":true}\n');
  await writeFile(externalPayload, "outside payload must survive");

  const manifestLinkId = "55555555-5555-4555-8555-555555555555";
  const manifestLinkDir = join(uploadRoot, manifestLinkId);
  await mkdir(manifestLinkDir);
  await symlink(externalManifest, join(manifestLinkDir, "manifest.json"), "file");

  const payloadLinkId = "66666666-6666-4666-8666-666666666666";
  const payloadLinkDir = join(uploadRoot, payloadLinkId);
  const payloadLinkPath = join(payloadLinkDir, "file-linked.txt");
  await mkdir(payloadLinkDir);
  await symlink(externalPayload, payloadLinkPath, "file");
  await writeFile(
    join(payloadLinkDir, "manifest.json"),
    JSON.stringify({
      id: payloadLinkId,
      name: "linked.txt",
      size: 28,
      path: payloadLinkPath,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );

  const response = await upload(server, "valid.txt", "valid");
  assert.equal(response.status, 200);
  const { attachment } = await response.json();
  assert.deepEqual(await readdir(uploadRoot), [attachment.id]);
  assert.equal(await readFile(externalManifest, "utf8"), '{"poisoned":true}\n');
  assert.equal(await readFile(externalPayload, "utf8"), "outside payload must survive");
  assert.equal(await readFile(attachment.path, "utf8"), "valid");
  server.assertAlive();
});

test("aggregate upload capacity is enforced across completed uploads", async (t) => {
  const server = await startUploadServer(t, { maxTotalBytes: 8 });
  assert.equal((await upload(server, "first.txt", "12345")).status, 200);
  const rejected = await upload(server, "second.txt", "6789");
  assert.equal(rejected.status, 507);
  assert.equal((await rejected.json()).error.code, "UPLOAD_CAPACITY_EXCEEDED");
  assert.equal((await readdir(join(server.dir, "uploads"))).length, 1);
  assert.equal((await upload(server, "fits.txt", "678")).status, 200);
  assert.equal((await readdir(join(server.dir, "uploads"))).length, 2);
  server.assertAlive();
});

test("aggregate capacity reservations prevent concurrent uploads from oversubscribing storage", async (t) => {
  const server = await startUploadServer(t, { maxTotalBytes: 8, maxConcurrent: 2 });
  const responses = await Promise.all([
    upload(server, "left.txt", "12345"),
    upload(server, "right.txt", "67890"),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort((a, b) => a - b), [200, 507]);
  const rejected = responses.find((response) => response.status === 507);
  assert.equal((await rejected.json()).error.code, "UPLOAD_CAPACITY_EXCEEDED");
  assert.equal((await readdir(join(server.dir, "uploads"))).length, 1);
  server.assertAlive();
});

test("concurrent upload limit rejects excess work and releases its slot after abort", async (t) => {
  const server = await startUploadServer(t, { maxConcurrent: 1 });
  const held = request(server.url, {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=fixture" },
  });
  held.on("error", () => {});
  t.after(() => held.destroy());
  held.write('--fixture\r\nContent-Disposition: form-data; name="file"; filename="held.txt"\r\n\r\nheld');
  const uploads = () => readdir(join(server.dir, "uploads")).catch(() => []);
  await waitUntil(async () => (await uploads()).length === 1);

  const rejected = await upload(server, "second.txt", "second");
  assert.equal(rejected.status, 429);
  assert.equal((await rejected.json()).error.code, "UPLOAD_CONCURRENCY_LIMIT");
  held.destroy();
  await waitUntil(async () => (await uploads()).length === 0);
  assert.equal((await upload(server, "after.txt", "after")).status, 200);
  server.assertAlive();
});

test("slow oversized input is rejected before the client sends the multipart tail", async (t) => {
  const server = await startUploadServer(t, { maxBytes: 64 });
  const { req, response } = await beginSlowMultipart(
    server,
    `--fixture\r\nContent-Disposition: form-data; name="file"; filename="slow.txt"\r\n\r\n${"x".repeat(65)}`,
  );
  assert.equal(response.statusCode, 413);
  assert.equal((await responseJson(response)).error.code, "UPLOAD_TOO_LARGE");
  req.destroy();
  assert.deepEqual(await readdir(join(server.dir, "uploads")), []);
  server.assertAlive();
});

test("slow second-file input is rejected before the second body or final boundary", async (t) => {
  const server = await startUploadServer(t);
  const { req, response } = await beginSlowMultipart(
    server,
    '--fixture\r\nContent-Disposition: form-data; name="file"; filename="first.txt"\r\n\r\nfirst\r\n' +
      '--fixture\r\nContent-Disposition: form-data; name="file"; filename="second.txt"\r\n\r\ns',
  );
  assert.equal(response.statusCode, 400);
  assert.equal((await responseJson(response)).error.code, "TOO_MANY_FILES");
  req.destroy();
  assert.deepEqual(await readdir(join(server.dir, "uploads")), []);
  server.assertAlive();
});

test("abort before upload-root setup completes settles and leaves no partial upload", async (t) => {
  const server = await startUploadServer(t, { setupDelayMs: 200 });
  const req = request(server.url, {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=fixture" },
  });
  req.on("error", () => {});
  req.write('--fixture\r\nContent-Disposition: form-data; name="file"; filename="early.txt"\r\n\r\nearly');
  req.destroy();
  await setTimeout(300);
  assert.deepEqual(await readdir(join(server.dir, "uploads")).catch(() => []), []);
  assert.equal((await upload(server, "small.txt", "ok")).status, 200);
  server.assertAlive();
});
