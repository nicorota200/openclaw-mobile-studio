export function attachmentQueue(state, sessionKey) {
  if (!sessionKey) return [];
  if (!Array.isArray(state.pendingAttachmentsBySession[sessionKey])) {
    state.pendingAttachmentsBySession[sessionKey] = [];
  }
  return state.pendingAttachmentsBySession[sessionKey];
}

export function removeAttachmentItems(state, sessionKey, localIds) {
  const removed = new Set(localIds);
  state.pendingAttachmentsBySession[sessionKey] = attachmentQueue(state, sessionKey).filter(
    (attachment) => !removed.has(attachment.localId),
  );
}

export function attachmentItemsForSend(state, sessionKey, includeAttachments = true) {
  if (!includeAttachments) return [];
  return attachmentQueue(state, sessionKey).filter((item) => item.status === "uploaded" && item.attachment);
}
