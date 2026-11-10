import assert from "node:assert/strict";
import test from "node:test";
import { attachmentItemsForSend, attachmentQueue, removeAttachmentItems } from "../public/attachment-state.js";

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
