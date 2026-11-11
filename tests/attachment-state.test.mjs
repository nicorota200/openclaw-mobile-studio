import assert from "node:assert/strict";
import test from "node:test";
import {
  attachmentFilesWithinLimit,
  attachmentItemsForSend,
  attachmentQueue,
  removeAttachmentItems,
} from "../public/attachment-state.js";

function fixture() {
  return { pendingAttachmentsBySession: {} };
}

test("pending attachments remain partitioned by session across switches and completions", () => {
  const state = fixture();
  const uploadA = { localId: "a", status: "uploading", attachment: null };
  const readyB = { localId: "b", status: "uploaded", attachment: { id: "remote-b" } };
  attachmentQueue(state, "session-a").push(uploadA);
  attachmentQueue(state, "session-b").push(readyB);

  uploadA.status = "uploaded";
  uploadA.attachment = { id: "remote-a" };

  assert.deepEqual(attachmentItemsForSend(state, "session-a").map((item) => item.attachment.id), ["remote-a"]);
  assert.deepEqual(attachmentItemsForSend(state, "session-b").map((item) => item.attachment.id), ["remote-b"]);
  removeAttachmentItems(state, "session-a", ["a"]);
  assert.deepEqual(attachmentQueue(state, "session-a"), []);
  assert.equal(attachmentQueue(state, "session-b")[0], readyB);
});

test("project-action sends opt out without consuming composer attachments", () => {
  const state = fixture();
  const ready = { localId: "composer", status: "uploaded", attachment: { id: "composer-file" } };
  attachmentQueue(state, "session-a").push(ready);

  assert.deepEqual(attachmentItemsForSend(state, "session-a", false), []);
  assert.equal(attachmentQueue(state, "session-a")[0], ready);
});

test("repeated file selections share one total per-session attachment limit", () => {
  const state = fixture();
  const first = attachmentFilesWithinLimit(state, "session-a", ["one", "two", "three"]);
  attachmentQueue(state, "session-a").push(...first.map((name) => ({ name, status: "uploading" })));

  const second = attachmentFilesWithinLimit(state, "session-a", ["four", "five", "six"]);
  attachmentQueue(state, "session-a").push(...second.map((name) => ({ name, status: "uploading" })));

  assert.deepEqual(first, ["one", "two", "three"]);
  assert.deepEqual(second, ["four", "five"]);
  assert.equal(attachmentQueue(state, "session-a").length, 5);
  assert.deepEqual(attachmentFilesWithinLimit(state, "session-a", ["seven"]), []);
  assert.deepEqual(attachmentFilesWithinLimit(state, "session-b", ["other"]), ["other"]);
});
