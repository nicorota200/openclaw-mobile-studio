import { projectActionLabel, projectActionPrompt, projectActions } from "./project-actions.js";
import {
  attachmentFilesWithinLimit,
  attachmentItemsForSend,
  attachmentQueue,
  removeAttachmentItems,
} from "./attachment-state.js";

const initialParams = new URLSearchParams(window.location.search);

const state = {
  activeView: initialParams.get("view") || localStorage.getItem("oms.activeView") || "home",
  theme: localStorage.getItem("oms.theme") === "light" ? "light" : "dark",
  attention: null,
  attentionLoading: false,
  attentionPollTimer: null,
  sessions: [],
  sessionsLoading: false,
  sessionActionBusy: "",
  selectedSessionKey: localStorage.getItem("oms.selectedSessionKey") || "",
  selectedSession: null,
  messages: [],
  pendingMessages: [],
  runState: null,
  runLoading: false,
  runExpanded: localStorage.getItem("oms.runExpanded") === "1",
  filePath: initialParams.get("path") || localStorage.getItem("oms.filePath") || "",
  fileEntries: [],
  showHidden: localStorage.getItem("oms.showHidden") === "1",
  gitInfo: null,
  gitLoading: false,
  projectInfo: null,
  projectLoading: false,
  projectActionBusy: "",
  projectCommitDrafts: {},
  projectTab: initialParams.get("tab") || localStorage.getItem("oms.projectTab") || "changes",
  projectWorkbenchRenderPending: false,
  projectPollTimer: null,
  selectedProjectPath: localStorage.getItem("oms.selectedProjectPath") || "",
  chatProjectPath: "",
  chatProjectInfo: null,
  chatProjectExpanded: false,
  fileRoot: "/home/nicola-rota",
  selectedFilePath: "",
  fileScreen: "browser",
  pushedReaderHistory: false,
  loading: false,
  filesLoading: false,
  sending: false,
  pendingAttachmentsBySession: {},
  pollTimer: null,
  runPollTimer: null,
  historyPollInFlight: false,
  messageRenderSignature: "",
  confirmationKey: "",
  confirmationTimer: null,
  gitMode: "read",
};

const messageCachePrefix = "oms.messages.";
const messageCacheLimit = 50;
const sessionCacheKey = "oms.sessions.v1";
const sessionCacheLimit = 20;
const basePath = window.location.pathname.replace(/\/[^/]*$/, "/");
const doubleTapWindowMs = 2600;
const riskySlashCommands = new Set(["/new", "/reset", "/compact", "/stop"]);
const commandGroups = [
  {
    title: "Help",
    commands: [
      { label: "Help", value: "/help" },
      { label: "Commands", value: "/commands" },
      { label: "Tools", value: "/tools" },
      { label: "Status", value: "/status" },
    ],
  },
  {
    title: "Session",
    commands: [
      { label: "New", value: "/new" },
      { label: "Reset", value: "/reset" },
      { label: "Compact", value: "/compact " },
      { label: "Stop", value: "/stop" },
    ],
  },
  {
    title: "Options",
    commands: [
      { label: "Think", value: "/think " },
      { label: "Model", value: "/model " },
      { label: "Fast status", value: "/fast status" },
      { label: "Fast auto", value: "/fast auto" },
      { label: "Fast on", value: "/fast on" },
      { label: "Fast off", value: "/fast off" },
      { label: "Fast default", value: "/fast default" },
      { label: "Verbose on", value: "/verbose on" },
      { label: "Verbose off", value: "/verbose off" },
      { label: "Verbose full", value: "/verbose full" },
      { label: "Trace on", value: "/trace on" },
      { label: "Trace off", value: "/trace off" },
      { label: "Trace raw", value: "/trace raw" },
    ],
  },
  {
    title: "Status",
    commands: [
      { label: "Status", value: "/status" },
      { label: "Tasks", value: "/tasks" },
      { label: "Whoami", value: "/whoami" },
      { label: "Context", value: "/context" },
    ],
  },
  {
    title: "Skills",
    commands: [{ label: "Skill", value: "/skill " }],
  },
];
const allCommands = commandGroups.flatMap((group) => group.commands.map((command) => ({ ...command, group: group.title })));

function appUrl(path) {
  const cleanPath = path.startsWith("/") ? path.slice(1) : path;
  return `${basePath}${cleanPath}`;
}

const els = {
  viewTitle: document.getElementById("viewTitle"),
  menuButton: document.getElementById("menuButton"),
  sideMenu: document.getElementById("sideMenu"),
  closeMenuButton: document.getElementById("closeMenuButton"),
  navItems: Array.from(document.querySelectorAll(".nav-item[data-view]")),
  homeView: document.getElementById("homeView"),
  homeSummary: document.getElementById("homeSummary"),
  homeUpdatedAt: document.getElementById("homeUpdatedAt"),
  attentionList: document.getElementById("attentionList"),
  homeProjectList: document.getElementById("homeProjectList"),
  homeAuditList: document.getElementById("homeAuditList"),
  homeActions: Array.from(document.querySelectorAll("[data-home-action]")),
  settingsView: document.getElementById("settingsView"),
  themeOptions: Array.from(document.querySelectorAll("[data-theme-choice]")),
  settingsSessionList: document.getElementById("settingsSessionList"),
  chatView: document.getElementById("chatView"),
  filesView: document.getElementById("filesView"),
  fileBrowserScreen: document.getElementById("fileBrowserScreen"),
  fileReaderScreen: document.getElementById("fileReaderScreen"),
  gitScreen: document.getElementById("gitScreen"),
  statusStrip: document.getElementById("statusStrip"),
  statusText: document.getElementById("statusText"),
  sessionSelect: document.getElementById("sessionSelect"),
  sessionMeta: document.getElementById("sessionMeta"),
  chatProjectStrip: document.getElementById("chatProjectStrip"),
  runPanel: document.getElementById("runPanel"),
  messageList: document.getElementById("messageList"),
  composer: document.getElementById("composer"),
  commandButton: document.getElementById("commandButton"),
  commandHint: document.getElementById("commandHint"),
  commandPalette: document.getElementById("commandPalette"),
  attachmentList: document.getElementById("attachmentList"),
  fileInput: document.getElementById("fileInput"),
  attachButton: document.getElementById("attachButton"),
  messageInput: document.getElementById("messageInput"),
  sendButton: document.getElementById("sendButton"),
  refreshButton: document.getElementById("refreshButton"),
  filesRefreshButton: document.getElementById("filesRefreshButton"),
  gitButton: document.getElementById("gitButton"),
  projectWorkbench: document.getElementById("projectWorkbench"),
  projectTitle: document.getElementById("projectTitle"),
  projectMeta: document.getElementById("projectMeta"),
  gitModeBadge: document.getElementById("gitModeBadge"),
  projectChatButton: document.getElementById("projectChatButton"),
  branchSelect: document.getElementById("branchSelect"),
  branchMeta: document.getElementById("branchMeta"),
  projectTabs: Array.from(document.querySelectorAll(".project-tab[data-project-tab]")),
  projectPanel: document.getElementById("projectPanel"),
  fileOptionsButton: document.getElementById("fileOptionsButton"),
  fileOptionsMenu: document.getElementById("fileOptionsMenu"),
  showHiddenToggle: document.getElementById("showHiddenToggle"),
  projectsShortcut: document.getElementById("projectsShortcut"),
  workspaceShortcut: document.getElementById("workspaceShortcut"),
  gitBackButton: document.getElementById("gitBackButton"),
  fileBackButton: document.getElementById("fileBackButton"),
  fileRoot: document.getElementById("fileRoot"),
  fileBreadcrumbs: document.getElementById("fileBreadcrumbs"),
  fileList: document.getElementById("fileList"),
  filePreviewMeta: document.getElementById("filePreviewMeta"),
  filePreviewContent: document.getElementById("filePreviewContent"),
  gitMeta: document.getElementById("gitMeta"),
  gitContent: document.getElementById("gitContent"),
};

function setStatus(text, kind = "") {
  els.statusStrip.classList.remove("ok", "error");
  if (kind) els.statusStrip.classList.add(kind);
  els.statusText.textContent = text;
}

function clearConfirmation({ render = true } = {}) {
  state.confirmationKey = "";
  clearTimeout(state.confirmationTimer);
  state.confirmationTimer = null;
  if (els.sendButton) els.sendButton.textContent = "Send";
  if (render) renderProjectWorkbench();
}

function armConfirmation(key, message) {
  state.confirmationKey = key;
  clearTimeout(state.confirmationTimer);
  state.confirmationTimer = setTimeout(() => clearConfirmation(), doubleTapWindowMs);
  setStatus(message);
  renderProjectWorkbench();
}

function consumeConfirmation(key, message) {
  if (state.confirmationKey === key) {
    clearConfirmation({ render: false });
    return true;
  }
  armConfirmation(key, message);
  return false;
}

function isConfirmationArmed(key) {
  return state.confirmationKey === key;
}

function openMenu() {
  els.sideMenu.classList.add("open");
  els.sideMenu.setAttribute("aria-hidden", "false");
}

function closeMenu() {
  els.sideMenu.classList.remove("open");
  els.sideMenu.setAttribute("aria-hidden", "true");
}

function applyTheme(theme = state.theme) {
  state.theme = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = state.theme;
  localStorage.setItem("oms.theme", state.theme);
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = state.theme === "light" ? "#ffffff" : "#05080d";
  for (const option of els.themeOptions) {
    const active = option.dataset.themeChoice === state.theme;
    option.classList.toggle("active", active);
    option.setAttribute("aria-pressed", String(active));
  }
}

function setView(view) {
  state.activeView = ["home", "chat", "files", "settings"].includes(view) ? view : "home";
  localStorage.setItem("oms.activeView", state.activeView);
  els.homeView.hidden = state.activeView !== "home";
  els.chatView.hidden = state.activeView !== "chat";
  els.filesView.hidden = state.activeView !== "files";
  els.settingsView.hidden = state.activeView !== "settings";
  els.homeView.classList.toggle("active-view", state.activeView === "home");
  els.chatView.classList.toggle("active-view", state.activeView === "chat");
  els.filesView.classList.toggle("active-view", state.activeView === "files");
  els.settingsView.classList.toggle("active-view", state.activeView === "settings");
  els.viewTitle.textContent =
    state.activeView === "files"
      ? "Files"
      : state.activeView === "chat"
        ? "Mobile Studio"
        : state.activeView === "settings"
          ? "Settings"
          : "Home";
  els.refreshButton.textContent = "Refresh";
  for (const item of els.navItems) item.classList.toggle("active", item.dataset.view === state.activeView);
  closeMenu();
  if (state.activeView === "home") {
    loadAttention({ quiet: Boolean(state.attention) }).catch((error) => setStatus(error.message, "error"));
    startAttentionPolling();
  } else {
    stopAttentionPolling();
  }
  if (state.activeView === "files" && state.fileEntries.length === 0) {
    loadFiles().catch((error) => setStatus(error.message, "error"));
  }
  if (state.activeView === "files") startProjectPolling();
  if (state.activeView === "settings") {
    loadSessions().catch((error) => setStatus(error.message, "error"));
  }
  if (state.activeView === "chat") {
    startChatPolling();
    startRunPolling();
    refreshChatProject({ quiet: true }).catch(() => {});
    refreshRunState({ quiet: true }).catch(() => {});
  } else {
    stopChatPolling();
    stopRunPolling();
  }
}

function setFileScreen(screen) {
  state.fileScreen = screen;
  const isReader = screen === "reader";
  const isGit = screen === "git";
  els.fileBrowserScreen.hidden = isReader || isGit;
  els.fileReaderScreen.hidden = !isReader;
  els.gitScreen.hidden = !isGit;
  els.fileBrowserScreen.classList.toggle("active-file-screen", !isReader && !isGit);
  els.fileReaderScreen.classList.toggle("active-file-screen", isReader);
  els.gitScreen.classList.toggle("active-file-screen", isGit);
  if (state.activeView === "files") els.viewTitle.textContent = isReader ? "Viewer" : isGit ? "Git" : "Files";
}

function api(path, options = {}) {
  return fetch(appUrl(path), {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const message = data.error?.message || `HTTP ${res.status}`;
      throw new Error(message);
    }
    return data;
  });
}

function uploadAttachment(file, item) {
  return new Promise((resolveUpload, rejectUpload) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append("file", file, file.name || "upload");
    xhr.open("POST", appUrl("/api/uploads"));
    xhr.responseType = "json";
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      item.progress = Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100)));
      renderAttachments();
    });
    xhr.addEventListener("load", () => {
      const data = xhr.response || {};
      if (xhr.status < 200 || xhr.status >= 300 || data.ok === false) {
        rejectUpload(new Error(data.error?.message || `Upload failed (${xhr.status})`));
        return;
      }
      resolveUpload(data.attachment);
    });
    xhr.addEventListener("error", () => rejectUpload(new Error("Upload failed")));
    xhr.addEventListener("abort", () => rejectUpload(new Error("Upload aborted")));
    xhr.send(form);
  });
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  }).format(date);
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "";
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const minuteRest = minutes % 60;
  return minuteRest ? `${hours}h ${minuteRest}m` : `${hours}h`;
}

function elapsedFrom(value) {
  const started = Number(value);
  if (!Number.isFinite(started) || started <= 0) return "";
  return formatDuration(Date.now() - started);
}

function formatBytes(value) {
  if (typeof value !== "number") return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function cacheKeyForSession(sessionKey) {
  return `${messageCachePrefix}${encodeURIComponent(sessionKey)}`;
}

function sessionResetKey(sessionKey) {
  return `oms.sessionResetAt.${encodeURIComponent(sessionKey)}`;
}

function sessionResetAt(sessionKey) {
  if (!sessionKey) return 0;
  const value = Number(localStorage.getItem(sessionResetKey(sessionKey)) || 0);
  return Number.isFinite(value) ? value : 0;
}

function markSessionReset(sessionKey, timestamp = Date.now()) {
  if (!sessionKey) return;
  localStorage.setItem(sessionResetKey(sessionKey), String(timestamp));
}

function filterMessagesForSession(sessionKey, messages) {
  const resetAt = sessionResetAt(sessionKey);
  if (!resetAt) return messages;
  return messages.filter((message) => {
    const timestamp = messageTimeMs(message);
    return timestamp > 0 && timestamp >= resetAt;
  });
}

function loadCachedMessages(sessionKey) {
  if (!sessionKey) return [];
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKeyForSession(sessionKey)) || "[]");
    return Array.isArray(cached) ? filterMessagesForSession(sessionKey, cached) : [];
  } catch {
    return [];
  }
}

function cacheMessages(sessionKey, messages) {
  if (!sessionKey || !Array.isArray(messages)) return;
  try {
    const visibleMessages = filterMessagesForSession(sessionKey, dedupeMessages(messages));
    localStorage.setItem(cacheKeyForSession(sessionKey), JSON.stringify(visibleMessages.slice(-messageCacheLimit)));
  } catch {
    // Ignore storage pressure; the live gateway response remains authoritative.
  }
}

function compactSessionForCache(session) {
  return {
    key: session.key || "",
    sessionId: session.sessionId || null,
    agentId: session.agentId || "",
    kind: session.kind || "",
    displayName: displayNameForSession(session),
    channel: session.channel || "",
    subject: session.subject || "",
    status: session.status || "",
    updatedAt: session.updatedAt ?? null,
    model: session.model || null,
    modelProvider: session.modelProvider || null,
    runtime: session.runtime || null,
    abortedLastRun: session.abortedLastRun === true,
    hasActiveRun: session.hasActiveRun === true,
    hasLocalHistory: session.hasLocalHistory === true,
    startedAt: session.startedAt ?? null,
    endedAt: session.endedAt ?? null,
    runtimeMs: session.runtimeMs ?? null,
    thinkingLevel: session.thinkingLevel || null,
    effectiveFastMode: session.effectiveFastMode ?? null,
    estimatedCostUsd: session.estimatedCostUsd ?? null,
    totalTokens: session.totalTokens ?? null,
    contextTokens: session.contextTokens ?? null,
    projectPath: session.projectPath || "",
  };
}

function loadCachedSessions() {
  try {
    const cached = JSON.parse(localStorage.getItem(sessionCacheKey) || "[]");
    return Array.isArray(cached) ? cached.filter((session) => session?.key).slice(0, sessionCacheLimit) : [];
  } catch {
    return [];
  }
}

function cacheSessions(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) return;
  try {
    localStorage.setItem(sessionCacheKey, JSON.stringify(sessions.map(compactSessionForCache).slice(0, sessionCacheLimit)));
  } catch {
    // Session cache is only a startup accelerator.
  }
}

function hydrateCachedSessions() {
  if (state.sessions.length > 0) return false;
  const cached = loadCachedSessions();
  if (cached.length === 0) return false;
  state.sessions = cached;
  renderSessions();
  renderRunPanel();
  hydrateCachedMessages();
  return true;
}

function hydrateCachedMessages() {
  if (!state.selectedSessionKey || state.messages.length > 0) return false;
  const cached = loadCachedMessages(state.selectedSessionKey);
  if (cached.length === 0) return false;
  state.messages = cached;
  state.loading = false;
  renderMessages({ force: true });
  return true;
}

function chatProjectKey(sessionKey = state.selectedSessionKey) {
  return sessionKey ? `oms.chatProjectPath.${encodeURIComponent(sessionKey)}` : "";
}

function sessionByKey(sessionKey) {
  return state.sessions.find((session) => session.key === sessionKey) || null;
}

function projectPathForSession(sessionKey = state.selectedSessionKey) {
  const session = sessionByKey(sessionKey);
  if (session && Object.prototype.hasOwnProperty.call(session, "projectPath")) return session.projectPath || "";
  if (session?.projectPath) return session.projectPath;
  const legacyKey = chatProjectKey(sessionKey);
  return legacyKey ? localStorage.getItem(legacyKey) || "" : "";
}

function loadChatProjectAttachment() {
  state.chatProjectPath = projectPathForSession();
  state.chatProjectInfo = null;
  state.chatProjectExpanded = false;
  renderChatProjectStrip();
}

async function setSessionProjectPath(sessionKey, projectPath) {
  const result = await api("/api/session-project", {
    method: "POST",
    body: JSON.stringify({ sessionKey, projectPath }),
  });
  const session = sessionByKey(sessionKey);
  if (session) session.projectPath = result.projectPath || "";
  const key = chatProjectKey(sessionKey);
  if (key) {
    if (result.projectPath) localStorage.setItem(key, result.projectPath);
    else localStorage.removeItem(key);
  }
  if (sessionKey === state.selectedSessionKey) {
    state.chatProjectPath = result.projectPath || "";
    state.chatProjectInfo = null;
    renderChatProjectStrip();
  }
  renderSessions();
  renderSettingsSessions();
  return result;
}

async function clearChatProjectAttachment() {
  const key = chatProjectKey();
  if (key) localStorage.removeItem(key);
  if (state.selectedSessionKey && state.selectedSession?.projectPath) {
    await setSessionProjectPath(state.selectedSessionKey, "");
  }
  state.chatProjectPath = "";
  state.chatProjectInfo = null;
  state.chatProjectExpanded = false;
  renderChatProjectStrip();
  stopProjectPolling();
}

function parentPath(path) {
  if (!path) return "";
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function isProjectsPath(path = state.filePath) {
  return (
    path === "projects" ||
    path.startsWith("projects/") ||
    path === ".openclaw/workspace/projects" ||
    path.startsWith(".openclaw/workspace/projects/")
  );
}

function projectPathFromFilePath(path = state.filePath) {
  const parts = String(path || "").split("/").filter(Boolean);
  if (parts[0] === "projects" && parts[1]) return `projects/${parts[1]}`;
  if (parts[0] === ".openclaw" && parts[1] === "workspace" && parts[2] === "projects" && parts[3]) {
    return `.openclaw/workspace/projects/${parts[3]}`;
  }
  return "";
}

function fileIcon(type) {
  if (type === "directory") return "Dir";
  if (type === "file") return "File";
  return "Item";
}

function rawTextFromContent(content, depth = 0) {
  if (depth > 4) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item?.type === "toolCall" || item?.type === "toolResult") return "";
        if (item?.type === "text" && typeof item.text === "string") return item.text;
        if (typeof item?.text === "string") return item.text;
        if (typeof item?.content === "string") return item.content;
        if (typeof item?.output === "string") return item.output;
        if (Array.isArray(item?.content)) return rawTextFromContent(item.content, depth + 1);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content?.text === "string") return content.text;
  if (typeof content?.content === "string") return content.content;
  if (typeof content?.output === "string") return content.output;
  if (Array.isArray(content?.content)) return rawTextFromContent(content.content, depth + 1);
  return "";
}

function normalizeMessageText(value) {
  let text = String(value || "").replace(/\r\n?/g, "\n").trim();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
      try {
        const parsed = JSON.parse(text);
        const extracted = rawTextFromContent(parsed, 1).trim();
        if (extracted && extracted !== text) {
          text = extracted;
          continue;
        }
      } catch {
        // Keep the original text when it only looks like JSON.
      }
    }

    const fence = text.match(/^(```|''')([A-Za-z0-9_-]+)?[ \t]*\n([\s\S]*?)\n\1$/);
    const lang = fence?.[2]?.toLowerCase() || "";
    if (fence && (!lang || ["text", "plain", "markdown", "md"].includes(lang))) {
      text = fence[3].trim();
      continue;
    }

    const looseTextFence = text.match(/^(```|''')text[ \t]*\n?([\s\S]*)$/i);
    if (looseTextFence) {
      text = looseTextFence[2].replace(/(```|''')\s*$/g, "").trim();
      continue;
    }
    break;
  }
  return text;
}

function textFromContent(content) {
  return normalizeMessageText(rawTextFromContent(content));
}

function firstToolCallFromContent(content) {
  if (!Array.isArray(content)) return null;
  return content.find((item) => item?.type === "toolCall" || item?.toolCallId || item?.name || item?.input) || null;
}

function firstToolResultFromContent(content) {
  if (!Array.isArray(content)) return null;
  return content.find((item) => item?.type === "toolResult" || item?.toolCallId || item?.toolUseId) || null;
}

function unquoteShellArg(value) {
  const text = String(value || "").trim();
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1);
  }
  return text;
}

function summarizeShellCommand(command) {
  const text = String(command || "").trim();
  if (!text) return "";
  const bashMatch = text.match(/^\/?bin\/bash\s+-lc\s+([\s\S]+)$/) || text.match(/^bash\s+-lc\s+([\s\S]+)$/);
  const clean = bashMatch ? unquoteShellArg(bashMatch[1]) : text;
  return clean
    .replace(/\s+/g, " ")
    .replace(/^git status --short --branch$/, "check git status")
    .replace(/^git status --short$/, "check git status")
    .replace(/^sed -n '([^']+)' ([^ ]+)$/, "print lines $1 from $2")
    .slice(0, 140);
}

function cwdLabel(cwd) {
  if (!cwd) return "";
  const parts = String(cwd).split("/").filter(Boolean);
  return parts.at(-1) || "";
}

function toolLabel(name) {
  const raw = String(name || "").toLowerCase();
  if (raw.includes("apply_patch")) return "🩹 Apply Patch";
  if (raw.includes("bash") || raw.includes("exec") || raw.includes("shell")) return "🛠️ Bash";
  return `🛠️ ${name || "Tool"}`;
}

function toolActivityText(message, callIndex) {
  if (message.role === "toolResult") {
    const result = firstToolResultFromContent(message.content);
    const name = result?.toolName || result?.name || message.toolName || "Tool";
    return `${toolLabel(name)} completed`;
  }

  const calls = Array.isArray(message.content)
    ? message.content.filter((item) => item?.type === "toolCall" || item?.name || item?.input)
    : [];
  const call = calls[callIndex] || firstToolCallFromContent(message.content);
  if (!call) return "";
  const name = call.toolName || call.name || "Tool";
  if (String(name).includes("apply_patch")) return toolLabel(name);
  const input = call.input || call.arguments || {};
  const command = summarizeShellCommand(input.command || input.cmd || "");
  const cwd = cwdLabel(input.cwd || input.workdir || "");
  return [toolLabel(name), command, cwd ? `(${cwd})` : ""].filter(Boolean).join(" ");
}

function toolCallId(item) {
  return item?.id || item?.toolCallId || item?.toolUseId || item?.tool_use_id || "";
}

function isToolMessage(message) {
  if (message.role === "toolResult") return true;
  if (!Array.isArray(message.content)) return false;
  return message.content.some((item) => item?.type === "toolCall" || item?.type === "toolResult");
}

function messageTimeMs(message) {
  const value = message?.timestamp || message?.__openclaw?.recordTimestampMs || 0;
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function messageSeq(message) {
  const seq = Number(message?.__openclaw?.seq);
  return Number.isFinite(seq) ? seq : null;
}

function messageText(message) {
  return textFromContent(message?.content).trim();
}

function pendingMessageText(message) {
  return messageText(message);
}

function isPendingMessageAccepted(pending, messages) {
  const pendingText = pendingMessageText(pending);
  if (!pendingText) return true;
  return messages.some((message) => message.role === "user" && messageText(message) === pendingText);
}

function visibleMessagesWithPending() {
  const pending = state.pendingMessages.filter(
    (message) => message.sessionKey === state.selectedSessionKey && !isPendingMessageAccepted(message, state.messages),
  );
  return [...state.messages, ...pending];
}

function sortMessagesChronologically(messages) {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const leftSeq = messageSeq(left.message);
      const rightSeq = messageSeq(right.message);
      if (leftSeq !== null && rightSeq !== null && leftSeq !== rightSeq) return leftSeq - rightSeq;

      const leftTime = messageTimeMs(left.message);
      const rightTime = messageTimeMs(right.message);
      if (leftTime > 0 && rightTime > 0 && leftTime !== rightTime) return leftTime - rightTime;

      return left.index - right.index;
    })
    .map((item) => item.message);
}

function shouldDropDuplicateTextMessage(previous, current) {
  if (!previous || !current) return false;
  if (isToolMessage(previous) || isToolMessage(current)) return false;
  if (previous.role !== current.role) return false;

  const previousText = messageText(previous);
  const currentText = messageText(current);
  if (!previousText || previousText !== currentText) return false;

  const previousSeq = messageSeq(previous);
  const currentSeq = messageSeq(current);
  if (previousSeq !== null && currentSeq !== null && currentSeq - previousSeq <= 2) return true;

  const previousTime = messageTimeMs(previous);
  const currentTime = messageTimeMs(current);
  return previousTime > 0 && currentTime > 0 && Math.abs(currentTime - previousTime) <= 10000;
}

function dedupeMessages(messages) {
  const deduped = [];
  for (const message of messages) {
    if (shouldDropDuplicateTextMessage(deduped.at(-1), message)) continue;
    deduped.push(message);
  }
  return deduped;
}

function resultExitSuffix(message) {
  const text = textFromContent(message.content);
  const match = text.match(/(?:exit code|exited with code|exit)\s+(\d+)/i);
  const code = match?.[1] || (message.isError ? "1" : "");
  return code && code !== "0" ? ` exit ${code}` : "";
}

function buildVisibleMessages(messages) {
  messages = dedupeMessages(sortMessagesChronologically(messages));
  let latestUserTextIndex = -1;
  messages.forEach((message, index) => {
    if (!isToolMessage(message) && message.role === "user" && messageText(message)) latestUserTextIndex = index;
  });
  const assistantReplyAfterLatestUser = messages.some(
    (message, index) =>
      index > latestUserTextIndex && !isToolMessage(message) && message.role === "assistant" && messageText(message),
  );
  const showLiveActivity = latestUserTextIndex >= 0 && !assistantReplyAfterLatestUser;

  const visible = [];
  const activityIndexByCallId = new Map();
  messages.forEach((message, index) => {
    const text = messageText(message);
    if (!isToolMessage(message) && text.trim()) {
      visible.push({ kind: "message", message, text });
      return;
    }
    if (!showLiveActivity || index <= latestUserTextIndex) return;
    if (Array.isArray(message.content)) {
      const calls = message.content.filter(
        (item) =>
          item?.type === "toolCall" ||
          (message.role !== "toolResult" && item?.type !== "toolResult" && item?.name && item?.input),
      );
      calls.forEach((_, callIndex) => {
        const call = calls[callIndex];
        const activity = toolActivityText(message, callIndex);
        if (!activity) return;
        const activityItem = { kind: "activity", message, text: activity };
        visible.push(activityItem);
        const id = toolCallId(call);
        if (id) activityIndexByCallId.set(id, visible.length - 1);
      });
      if (message.role === "toolResult") {
        const result = firstToolResultFromContent(message.content);
        const id = toolCallId(result || message);
        const suffix = resultExitSuffix(message);
        if (id && activityIndexByCallId.has(id)) {
          const activity = visible[activityIndexByCallId.get(id)];
          activity.text = `${activity.text}${suffix}`;
          return;
        }
        const activity = toolActivityText(message, 0);
        if (activity) visible.push({ kind: "activity", message, text: `${activity}${suffix}` });
      }
    }
  });
  return visible;
}

function displayNameForSession(session) {
  const key = session.key || "";
  const rawName = String(session.displayName || "").trim();
  const subject = String(session.subject || "").trim();
  const usefulName = rawName && !rawName.startsWith("telegram:") ? rawName : "";
  if (key.includes(":telegram:group:")) return subject || usefulName || `Telegram group ${key.split(":").at(-1)}`;
  if (key.includes(":telegram:direct:")) return usefulName || subject || "Direct chat";
  if (usefulName) return usefulName;
  if (key.endsWith(":main")) return "Main";
  return key.replace(/^agent:[^:]+:/, "");
}

function renderSessions() {
  const previousSessionKey = state.selectedSessionKey;
  els.sessionSelect.innerHTML = "";
  if (state.sessions.length === 0) {
    const option = document.createElement("option");
    option.textContent = "No sessions";
    option.value = "";
    els.sessionSelect.append(option);
    els.sessionSelect.disabled = true;
    return;
  }
  els.sessionSelect.disabled = false;
  for (const session of state.sessions) {
    const option = document.createElement("option");
    option.value = session.key;
    option.textContent = session.projectPath ? `${displayNameForSession(session)} · ${session.projectPath.split("/").at(-1)}` : displayNameForSession(session);
    els.sessionSelect.append(option);
  }
  if (!state.sessions.some((session) => session.key === state.selectedSessionKey)) {
    state.selectedSessionKey = state.sessions[0]?.key || "";
  }
  if (state.selectedSessionKey !== previousSessionKey) {
    state.messages = [];
    state.pendingMessages = [];
    state.messageRenderSignature = "";
    if (state.selectedSessionKey) localStorage.setItem("oms.selectedSessionKey", state.selectedSessionKey);
  }
  els.sessionSelect.value = state.selectedSessionKey;
  state.selectedSession = state.sessions.find((session) => session.key === state.selectedSessionKey) || null;
  loadChatProjectAttachment();
  renderAttachments();
  renderSessionMeta();
  renderSettingsSessions();
}

function renderSessionMeta(sessionInfo) {
  const session = state.selectedSession;
  if (!session) {
    els.sessionMeta.textContent = "";
    return;
  }
  const bits = [
    session.agentId ? `agent ${session.agentId}` : null,
    session.runtime ? `runtime ${session.runtime}` : null,
    session.model ? session.model : null,
    session.status ? `status ${session.status}` : null,
    session.projectPath ? `project ${session.projectPath.split("/").at(-1)}` : null,
    sessionInfo?.status && sessionInfo.status !== session.status ? `status ${sessionInfo.status}` : null,
  ].filter(Boolean);
  els.sessionMeta.textContent = bits.join(" · ");
}

function renderSettingsSessions() {
  if (!els.settingsSessionList) return;
  els.settingsSessionList.innerHTML = "";
  if (state.sessionsLoading && state.sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "settings-session-empty";
    empty.textContent = "Loading sessions...";
    els.settingsSessionList.append(empty);
    return;
  }
  if (state.sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "settings-session-empty";
    empty.textContent = "No sessions available.";
    els.settingsSessionList.append(empty);
    return;
  }
  for (const session of state.sessions) {
    const row = document.createElement("article");
    row.className = "settings-session-row";
    row.dataset.sessionKey = session.key;

    const main = document.createElement("div");
    main.className = "settings-session-main";
    const title = document.createElement("strong");
    title.textContent = displayNameForSession(session);
    const meta = document.createElement("span");
    meta.textContent = [
      session.projectPath ? `Project: ${session.projectPath}` : "Free",
      runStatusLabel(session),
      session.hasLocalHistory ? "history" : "empty",
    ]
      .filter(Boolean)
      .join(" · ");
    main.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "settings-session-actions";
    const open = document.createElement("button");
    open.type = "button";
    open.dataset.sessionAction = "open";
    open.textContent = "Open";
    const detach = document.createElement("button");
    detach.type = "button";
    detach.dataset.sessionAction = "detach";
    detach.textContent = "Detach";
    detach.disabled = !session.projectPath || Boolean(state.sessionActionBusy);
    actions.append(open, detach);
    row.append(main, actions);
    els.settingsSessionList.append(row);
  }
}

function isActiveRunSession(session) {
  if (!session) return false;
  const status = String(session.status || "").toLowerCase();
  return session.hasActiveRun === true || ["queued", "starting", "running", "waiting", "waiting_approval"].includes(status);
}

function runStatusLabel(session) {
  if (state.runLoading && !state.runState) return "checking";
  if (!session) return "unknown";
  const status = String(session.status || "").toLowerCase();
  if (status === "waiting_approval" || status === "waiting") return "waiting";
  if (isActiveRunSession(session)) return status || "running";
  if (session.abortedLastRun) return "aborted";
  return status || "idle";
}

function runStatusTone(label) {
  if (["running", "starting", "queued"].includes(label)) return "active";
  if (label === "waiting") return "waiting";
  if (["failed", "error", "aborted"].includes(label)) return "danger";
  return "idle";
}

function renderRunPanel() {
  if (!state.selectedSessionKey) {
    els.runPanel.hidden = true;
    els.runPanel.innerHTML = "";
    return;
  }
  const runState = state.runState || {};
  const session = runState.session || state.selectedSession || null;
  const label = runStatusLabel(session);
  const active = isActiveRunSession(session);
  const startedText = active ? elapsedFrom(session?.startedAt) : formatDuration(session?.runtimeMs);
  const modelText = [session?.model, session?.thinkingLevel ? `think ${session.thinkingLevel}` : ""].filter(Boolean).join(" · ");
  const tokenText = session?.totalTokens ? `${Math.round(session.totalTokens / 1000)}k tok` : "";
  const tasks = Array.isArray(runState.tasks) ? runState.tasks.slice(0, 3) : [];

  els.runPanel.hidden = false;
  els.runPanel.innerHTML = "";

  const summary = document.createElement("div");
  summary.className = "run-summary";

  const statusGroup = document.createElement("button");
  statusGroup.type = "button";
  statusGroup.className = "run-status-button";
  statusGroup.setAttribute("aria-expanded", String(state.runExpanded));
  statusGroup.addEventListener("click", () => {
    state.runExpanded = !state.runExpanded;
    localStorage.setItem("oms.runExpanded", state.runExpanded ? "1" : "0");
    renderRunPanel();
    if (state.runExpanded) refreshRunState({ quiet: true }).catch(() => {});
  });

  const dot = document.createElement("span");
  dot.className = `run-dot ${runStatusTone(label)}`;
  const title = document.createElement("strong");
  title.textContent = label === "idle" || label === "done" ? "No active run" : `Run ${label}`;
  const meta = document.createElement("span");
  meta.textContent = [startedText, modelText, tokenText].filter(Boolean).join(" · ");
  statusGroup.append(dot, title, meta);
  summary.append(statusGroup);

  const actions = document.createElement("div");
  actions.className = "run-actions";
  const details = document.createElement("button");
  details.type = "button";
  details.className = "run-detail-button";
  details.textContent = state.runExpanded ? "Hide" : "Details";
  details.addEventListener("click", () => {
    state.runExpanded = !state.runExpanded;
    localStorage.setItem("oms.runExpanded", state.runExpanded ? "1" : "0");
    renderRunPanel();
    if (state.runExpanded) refreshRunState({ quiet: true }).catch(() => {});
  });
  actions.append(details);

  if (active) {
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "run-stop-button";
    stop.textContent = "Stop";
    stop.addEventListener("click", () => abortSelectedRun().catch((error) => setStatus(error.message, "error")));
    actions.append(stop);
  }
  summary.append(actions);
  els.runPanel.append(summary);

  if (!state.runExpanded) return;

  const detail = document.createElement("div");
  detail.className = "run-detail";

  const facts = document.createElement("div");
  facts.className = "run-facts";
  const factItems = [
    session?.runtime ? `runtime ${session.runtime}` : "",
    session?.effectiveFastMode === true ? "fast on" : session?.effectiveFastMode === false ? "fast off" : "",
    session?.estimatedCostUsd ? `$${session.estimatedCostUsd.toFixed(4)}` : "",
    runState.approvals?.configured ? "approvals configured" : "",
  ].filter(Boolean);
  facts.textContent = factItems.length ? factItems.join(" · ") : "No additional run metadata.";
  detail.append(facts);

  if (tasks.length > 0) {
    const list = document.createElement("div");
    list.className = "run-task-list";
    for (const task of tasks) {
      const row = document.createElement("div");
      row.className = "run-task-row";
      const taskName = document.createElement("strong");
      taskName.textContent = task.title || task.id || "Task";
      const taskMeta = document.createElement("span");
      taskMeta.textContent = [task.status, task.runtime, formatDuration(task.runtimeMs)].filter(Boolean).join(" · ");
      row.append(taskName, taskMeta);
      list.append(row);
    }
    detail.append(list);
  }

  els.runPanel.append(detail);
}

function attentionToneClass(tone) {
  if (tone === "danger") return "danger";
  if (tone === "waiting") return "waiting";
  if (tone === "active") return "active";
  return "idle";
}

function renderHomeMetric(label, value, tone = "") {
  const item = document.createElement("div");
  item.className = `home-metric ${tone ? `home-metric-${tone}` : ""}`;
  const number = document.createElement("strong");
  number.textContent = String(value ?? 0);
  const text = document.createElement("span");
  text.textContent = label;
  item.append(number, text);
  return item;
}

function renderHome() {
  const data = state.attention;
  els.homeSummary.innerHTML = "";
  els.attentionList.innerHTML = "";
  els.homeProjectList.innerHTML = "";
  els.homeAuditList.innerHTML = "";

  if (state.attentionLoading && !data) {
    els.homeSummary.append(renderHomeMetric("Loading", "..."));
    els.attentionList.innerHTML = '<div class="loading-state">Loading attention state...</div>';
    els.homeUpdatedAt.textContent = "";
    return;
  }

  const summary = data?.summary || {};
  els.homeSummary.append(
    renderHomeMetric("Runs", summary.activeRuns || 0, summary.activeRuns ? "active" : ""),
    renderHomeMetric("Projects", summary.changedProjects || 0, summary.changedProjects ? "active" : ""),
    renderHomeMetric("Tasks", (summary.activeTasks || 0) + (summary.failedTasks || 0), summary.failedTasks ? "danger" : ""),
    renderHomeMetric(
      "Health",
      summary.healthOk === false ? "!" : summary.healthOk === true ? "OK" : "n/a",
      summary.healthOk === false ? "danger" : summary.healthOk === true ? "active" : "",
    ),
  );
  els.homeUpdatedAt.textContent = data?.updatedAt ? formatTime(data.updatedAt) : "";

  const items = Array.isArray(data?.items) ? data.items : [];
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state home-empty";
    empty.textContent = "Nothing needs attention.";
    els.attentionList.append(empty);
  } else {
    for (const item of items) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `attention-row ${attentionToneClass(item.tone)}`;
      row.addEventListener("click", () => openAttentionItem(item).catch((error) => setStatus(error.message, "error")));
      const marker = document.createElement("span");
      marker.className = "attention-marker";
      const main = document.createElement("span");
      main.className = "attention-main";
      const title = document.createElement("strong");
      title.textContent = item.title || item.type || "Item";
      const meta = document.createElement("span");
      const duration = item.durationMs ? formatDuration(item.durationMs) : "";
      meta.textContent = [item.type, item.meta, duration].filter(Boolean).join(" · ");
      main.append(title, meta);
      const action = document.createElement("span");
      action.className = "attention-action";
      action.textContent = item.projectPath ? "Open" : item.sessionKey ? "Chat" : "View";
      row.append(marker, main, action);
      els.attentionList.append(row);
    }
  }

  renderHomeProjects(data?.projects || []);
  renderHomeAudit(data?.auditEvents || []);
}

function renderHomeProjects(projects) {
  const visible = projects.slice(0, 6);
  if (visible.length === 0) {
    els.homeProjectList.innerHTML = '<div class="mini-empty">No repositories found.</div>';
    return;
  }
  for (const project of visible) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "mini-row";
    row.addEventListener("click", () => openProjectFromHome(project.path).catch((error) => setStatus(error.message, "error")));
    const title = document.createElement("strong");
    title.textContent = project.name;
    const meta = document.createElement("span");
    meta.textContent = [
      project.branch,
      project.changes ? `${project.changes} changed` : "clean",
      project.ahead ? `ahead ${project.ahead}` : "",
      project.behind ? `behind ${project.behind}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    row.append(title, meta);
    els.homeProjectList.append(row);
  }
}

function auditTitle(event) {
  const type = event?.type || "event";
  const meta = event?.meta || {};
  const labels = {
    project_action: "Project action",
    git_action: "Git action",
    branch_switch: "Branch switch",
    chat_send: "Chat send",
    run_abort: "Run stop",
  };
  if (type === "project_action" && meta.action) return `Project: ${projectActionLabel(meta.action)}`;
  if (type === "git_action" && meta.action) return `Git: ${gitActionLabel(meta.action)}`;
  return labels[type] || type.replace(/_/g, " ");
}

function auditMetaText(event) {
  const meta = event?.meta || {};
  return [
    meta.projectPath ? meta.projectPath.split("/").at(-1) : "",
    meta.branch || "",
    meta.sessionKey ? "chat" : "",
    event?.ts ? formatTime(event.ts) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function renderHomeAudit(events) {
  const visible = events.slice(0, 6);
  if (visible.length === 0) {
    els.homeAuditList.innerHTML = '<div class="mini-empty">No activity yet.</div>';
    return;
  }
  for (const event of visible) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "mini-row";
    row.disabled = !event.meta?.sessionKey && !event.meta?.projectPath;
    row.addEventListener("click", () => openAuditEvent(event).catch((error) => setStatus(error.message, "error")));
    const title = document.createElement("strong");
    title.textContent = auditTitle(event);
    const meta = document.createElement("span");
    meta.textContent = auditMetaText(event);
    row.append(title, meta);
    els.homeAuditList.append(row);
  }
}

async function openAuditEvent(event) {
  const meta = event?.meta || {};
  if (meta.projectPath) {
    await openProjectFromHome(meta.projectPath);
    return;
  }
  if (meta.sessionKey) {
    await openSessionFromHome(meta.sessionKey);
  }
}

async function openAttentionItem(item) {
  if (item.projectPath) {
    await openProjectFromHome(item.projectPath);
    return;
  }
  if (item.sessionKey) {
    await openSessionFromHome(item.sessionKey);
  }
}

async function openProjectFromHome(path) {
  if (!path) return;
  setView("files");
  await navigateFiles(path);
  setProjectTab("changes");
}

async function openSessionFromHome(sessionKey) {
  if (!sessionKey) return;
  state.selectedSessionKey = sessionKey;
  localStorage.setItem("oms.selectedSessionKey", sessionKey);
  setView("chat");
  hydrateCachedSessions();
  hydrateCachedMessages();
  renderSessions();
  renderMessages({ force: true });
  await refreshAll();
}

function visibleMessageSignature(visibleMessages) {
  const parts = visibleMessages.map((item) => {
    const message = item.message || {};
    return [
      item.kind,
      message.role || "",
      message.pendingStatus || "",
      message.timestamp || message.__openclaw?.recordTimestampMs || "",
      item.text,
    ].join("\u001f");
  });
  return [state.selectedSessionKey, state.loading ? "loading" : "ready", parts.join("\u001e")].join("\u001d");
}

function appendInlineFormatted(parent, text) {
  const pattern = /(`[^`\n]+`|https?:\/\/[^\s<>()]+|\*\*[^*\n]+?\*\*)/g;
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > lastIndex) parent.append(document.createTextNode(text.slice(lastIndex, match.index)));
    const token = match[0];
    if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else if (token.startsWith("**")) {
      const strong = document.createElement("strong");
      appendInlineFormatted(strong, token.slice(2, -2));
      parent.append(strong);
    } else {
      const link = document.createElement("a");
      link.href = token;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = token;
      parent.append(link);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) parent.append(document.createTextNode(text.slice(lastIndex)));
}

function appendMessageParagraph(container, lines) {
  const paragraph = document.createElement("p");
  lines.forEach((line, index) => {
    if (index > 0) paragraph.append(document.createElement("br"));
    appendInlineFormatted(paragraph, line);
  });
  container.append(paragraph);
}

function appendMessageList(container, lines, ordered) {
  const list = document.createElement(ordered ? "ol" : "ul");
  for (const line of lines) {
    const item = document.createElement("li");
    appendInlineFormatted(item, line.replace(ordered ? /^\d+[.)]\s+/ : /^[-*]\s+/, ""));
    list.append(item);
  }
  container.append(list);
}

function appendMessageTextBlock(container, text) {
  const blocks = text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trimEnd());
    if (lines.every((line) => /^[-*]\s+/.test(line))) {
      appendMessageList(container, lines, false);
    } else if (lines.every((line) => /^\d+[.)]\s+/.test(line))) {
      appendMessageList(container, lines, true);
    } else {
      appendMessageParagraph(container, lines);
    }
  }
}

function renderMessageContent(container, text) {
  container.innerHTML = "";
  const lines = String(text || "").split("\n");
  let buffer = [];
  let fence = null;
  let codeLines = [];

  const flushText = () => {
    if (!buffer.length) return;
    appendMessageTextBlock(container, buffer.join("\n"));
    buffer = [];
  };

  const flushCode = () => {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = codeLines.join("\n");
    pre.append(code);
    container.append(pre);
    codeLines = [];
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^(```|''')([A-Za-z0-9_-]+)?\s*$/);
    if (fenceMatch) {
      if (fence === fenceMatch[1]) {
        flushCode();
        fence = null;
      } else if (!fence) {
        flushText();
        fence = fenceMatch[1];
        codeLines = [];
      } else {
        codeLines.push(line);
      }
      continue;
    }
    if (fence) codeLines.push(line);
    else buffer.push(line);
  }
  if (fence && codeLines.length) buffer.push(codeLines.join("\n"));
  flushText();
}

function renderMessages({ force = false } = {}) {
  const visibleMessages = buildVisibleMessages(visibleMessagesWithPending());
  const signature = visibleMessageSignature(visibleMessages);
  if (!force && signature === state.messageRenderSignature) return;
  state.messageRenderSignature = signature;
  const distanceFromBottom = els.messageList.scrollHeight - els.messageList.scrollTop - els.messageList.clientHeight;
  const shouldStickToBottom = force || distanceFromBottom < 140;
  els.messageList.innerHTML = "";
  if (state.loading && visibleMessages.length === 0) {
    const div = document.createElement("div");
    div.className = "loading-state";
    div.textContent = "Loading conversation...";
    els.messageList.append(div);
    return;
  }
  if (visibleMessages.length === 0) {
    const div = document.createElement("div");
    div.className = "empty-state";
    div.textContent = "No visible messages in this session.";
    els.messageList.append(div);
    return;
  }
  for (const item of visibleMessages) {
    const { message, text } = item;
    const article = document.createElement("article");
    const role = message.role || "system";
    const messageClass = item.kind === "activity" ? "activity" : role === "user" || role === "assistant" ? role : "system";
    article.className = `message ${messageClass}`;
    if (message.pendingStatus) article.classList.add(`message-${message.pendingStatus}`);

    const roleEl = document.createElement("div");
    roleEl.className = "message-role";
    roleEl.textContent = item.kind === "activity" ? "working" : message.pendingStatus || role;

    const contentEl = document.createElement("div");
    contentEl.className = "message-content";
    renderMessageContent(contentEl, text);

    const timeEl = document.createElement("div");
    timeEl.className = "message-time";
    timeEl.textContent = formatTime(message.timestamp || message.__openclaw?.recordTimestampMs);

    article.append(roleEl, contentEl, timeEl);
    els.messageList.append(article);
  }
  requestAnimationFrame(() => {
    if (shouldStickToBottom) {
      els.messageList.scrollTop = els.messageList.scrollHeight;
      return;
    }
    els.messageList.scrollTop = Math.max(0, els.messageList.scrollHeight - els.messageList.clientHeight - distanceFromBottom);
  });
}

function renderBreadcrumbs() {
  els.fileBreadcrumbs.innerHTML = "";
  const rootButton = document.createElement("button");
  rootButton.type = "button";
  rootButton.textContent = "home";
  rootButton.addEventListener("click", () => navigateFiles(""));
  els.fileBreadcrumbs.append(rootButton);

  const parts = state.filePath.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    const separator = document.createElement("span");
    separator.textContent = "/";
    els.fileBreadcrumbs.append(separator);

    current = current ? `${current}/${part}` : part;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = part;
    button.addEventListener("click", () => navigateFiles(button.dataset.path || ""));
    button.dataset.path = current;
    els.fileBreadcrumbs.append(button);
  }
}

function updateFileControls() {
  const inProject = Boolean(projectPathFromFilePath());
  els.gitButton.hidden = inProject || !isProjectsPath();
  els.fileOptionsButton.hidden = inProject;
  els.filesRefreshButton.hidden = inProject;
  els.fileOptionsMenu.hidden = inProject || els.fileOptionsMenu.hidden;
  els.showHiddenToggle.checked = state.showHidden;
}

function renderFileList() {
  els.fileList.innerHTML = "";
  renderBreadcrumbs();
  updateFileControls();
  renderProjectWorkbench();
  const projectMode = Boolean(projectPathFromFilePath());
  const showFileBrowser = !projectMode || state.projectTab === "files";
  els.fileBrowserScreen.classList.toggle("project-detail-mode", projectMode && !showFileBrowser);
  els.fileBreadcrumbs.hidden = !showFileBrowser;
  els.fileList.hidden = !showFileBrowser;
  if (!showFileBrowser) return;
  if (state.filesLoading) {
    const div = document.createElement("div");
    div.className = "loading-state";
    div.textContent = "Loading files...";
    els.fileList.append(div);
    return;
  }
  if (state.filePath) {
    const upButton = document.createElement("button");
    upButton.className = "file-row";
    upButton.type = "button";
    upButton.addEventListener("click", () => navigateFiles(parentPath(state.filePath)));
    upButton.innerHTML = '<span class="file-row-kind">Up</span><span class="file-row-name">..</span><span class="file-row-meta">Parent</span>';
    els.fileList.append(upButton);
  }
  if (state.fileEntries.length === 0) {
    const div = document.createElement("div");
    div.className = "empty-state";
    div.textContent = "This folder is empty.";
    els.fileList.append(div);
    return;
  }
  for (const entry of state.fileEntries) {
    const row = document.createElement("button");
    row.className = "file-row";
    row.type = "button";
    row.disabled = !entry.accessible;
    row.addEventListener("click", () => {
      if (entry.type === "directory") navigateFiles(entry.path);
      else openFile(entry);
    });

    const kind = document.createElement("span");
    kind.className = "file-row-kind";
    kind.textContent = fileIcon(entry.type);

    const name = document.createElement("span");
    name.className = "file-row-name";
    name.textContent = entry.name;

    const meta = document.createElement("span");
    meta.className = "file-row-meta";
    const size = entry.type === "file" ? formatBytes(entry.size) : entry.type;
    meta.textContent = entry.accessible ? size : "Outside root";

    row.append(kind, name, meta);
    els.fileList.append(row);
  }
}

function createGitBlock(title, lines, emptyText) {
  const section = document.createElement("section");
  section.className = "git-block";
  const h2 = document.createElement("h2");
  h2.textContent = title;
  section.append(h2);
  const pre = document.createElement("pre");
  pre.textContent = lines.length > 0 ? lines.join("\n") : emptyText;
  section.append(pre);
  return section;
}

function gitStatusLabel(code) {
  const normalized = code || "?";
  const map = {
    M: "Modified",
    A: "Added",
    D: "Deleted",
    R: "Renamed",
    C: "Copied",
    U: "Conflict",
    "??": "Untracked",
  };
  return map[normalized] || map[normalized[0]] || normalized;
}

function changeCounts(info = state.projectInfo) {
  const entries = info?.statusEntries || [];
  return {
    total: entries.length,
    staged: entries.filter((entry) => entry.staged).length,
    unstaged: entries.filter((entry) => entry.unstaged).length,
    untracked: entries.filter((entry) => entry.untracked).length,
  };
}

function projectMetaText(info = state.projectInfo) {
  if (!info?.isRepo) return "";
  const counts = changeCounts(info);
  const parts = [
    info.branch || "detached",
    info.tracking ? `tracks ${info.tracking}` : "",
    info.ahead ? `ahead ${info.ahead}` : "",
    info.behind ? `behind ${info.behind}` : "",
    counts.total === 0 ? "clean" : `${counts.total} changed`,
  ].filter(Boolean);
  return parts.join(" · ");
}

function changeStatsText(entry) {
  const stats = entry?.stats || {};
  if (stats.binary) return "binary";
  const added = Number.isFinite(stats.added) ? stats.added : 0;
  const deleted = Number.isFinite(stats.deleted) ? stats.deleted : 0;
  return `+${added} -${deleted}`;
}

function changeKindText(entry) {
  if (entry.untracked) return "untracked";
  if (entry.staged && entry.unstaged) return "staged + working";
  if (entry.staged) return "staged";
  return "working";
}

function gitActionState(info) {
  const counts = changeCounts(info);
  const unstaged = counts.unstaged + counts.untracked;
  const hasUpstream = Boolean(info?.tracking);
  return {
    counts,
    unstaged,
    pullDisabled: state.projectActionBusy || !hasUpstream || counts.total > 0 || !info?.behind,
    pullReason: !hasUpstream
      ? "No upstream"
      : counts.total > 0
        ? "Commit or clear changes before pull"
        : !info?.behind
          ? "Up to date"
          : "",
    stageDisabled: state.projectActionBusy || unstaged === 0,
    stageReason: unstaged === 0 ? "Nothing to stage" : "",
    unstageDisabled: state.projectActionBusy || counts.staged === 0,
    unstageReason: counts.staged === 0 ? "Nothing staged" : "",
    commitDisabled: state.projectActionBusy || counts.staged === 0,
    commitReason: counts.staged === 0 ? "Stage changes first" : "",
    pushDisabled: state.projectActionBusy || !hasUpstream || Boolean(info?.behind) || !info?.ahead,
    pushReason: !hasUpstream
      ? "No upstream"
      : info?.behind
        ? "Pull before push"
        : !info?.ahead
          ? "Nothing to push"
          : "",
  };
}

function projectCommitDraftKey(path = state.projectInfo?.repositoryPath || projectPathFromFilePath() || state.selectedProjectPath) {
  return path ? `commit:${path}` : "";
}

function getProjectCommitDraft(path) {
  const key = projectCommitDraftKey(path);
  return key ? state.projectCommitDrafts[key] || "" : "";
}

function setProjectCommitDraft(path, message) {
  const key = projectCommitDraftKey(path);
  if (!key) return;
  if (message) state.projectCommitDrafts[key] = message;
  else delete state.projectCommitDrafts[key];
}

function isProjectCommitInputActive() {
  return Boolean(document.activeElement?.matches?.(".project-commit-form textarea"));
}

function renderBranchControl() {
  const info = state.projectInfo;
  els.branchSelect.innerHTML = "";
  if (!info?.isRepo) {
    els.branchSelect.disabled = true;
    els.branchMeta.textContent = "";
    return;
  }
  const branches = [
    ...(info.branches?.local || []).map((name) => ({ name, label: name, kind: "local" })),
    ...(info.branches?.remote || [])
      .filter((name) => !name.endsWith(`/${info.branch}`) || !(info.branches?.local || []).includes(info.branch))
      .map((name) => ({ name: name.replace(/^[^/]+\//, ""), label: name, kind: "remote" })),
  ];
  const seen = new Set();
  for (const branch of branches) {
    if (seen.has(`${branch.kind}:${branch.name}:${branch.label}`)) continue;
    seen.add(`${branch.kind}:${branch.name}:${branch.label}`);
    const option = document.createElement("option");
    option.value = branch.name;
    option.textContent = branch.kind === "remote" ? `${branch.name} (${branch.label})` : branch.label;
    els.branchSelect.append(option);
  }
  if (![...els.branchSelect.options].some((option) => option.value === info.branch)) {
    const option = document.createElement("option");
    option.value = info.branch;
    option.textContent = info.branch;
    els.branchSelect.prepend(option);
  }
  els.branchSelect.value = info.branch;
  const counts = changeCounts(info);
  const readOnly = state.gitMode !== "write";
  els.branchSelect.disabled = readOnly || counts.total > 0;
  els.branchMeta.textContent = readOnly
    ? "Branch switching is disabled in Git read-only mode."
    : counts.total > 0
      ? "Switch blocked: working tree has changes."
      : "Switch changes the repo branch for Codex too.";
}

function renderChatProjectStrip() {
  const info = state.chatProjectInfo;
  if (!info?.isRepo) {
    els.chatProjectStrip.hidden = true;
    els.chatProjectStrip.innerHTML = "";
    return;
  }
  const counts = changeCounts(info);
  els.chatProjectStrip.hidden = false;
  els.chatProjectStrip.innerHTML = "";
  const summary = document.createElement("button");
  summary.type = "button";
  summary.className = "project-strip-summary";
  summary.setAttribute("aria-expanded", String(state.chatProjectExpanded));
  const title = document.createElement("strong");
  title.textContent = info.repositoryName;
  const meta = document.createElement("span");
  meta.textContent = projectMetaText(info);
  const count = document.createElement("em");
  count.textContent = counts.total === 0 ? "clean" : `${counts.total} changes`;
  summary.append(title, meta, count);
  summary.addEventListener("click", () => {
    state.chatProjectExpanded = !state.chatProjectExpanded;
    renderChatProjectStrip();
  });
  els.chatProjectStrip.append(summary);

  if (!state.chatProjectExpanded) return;
  const list = document.createElement("div");
  list.className = "project-strip-change-list";
  const entries = info.statusEntries || [];
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "project-strip-empty";
    empty.textContent = "Working tree clean.";
    list.append(empty);
  } else {
    for (const entry of entries) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "project-strip-change";
      row.addEventListener("click", async () => {
        setView("files");
        await navigateFiles(info.repositoryPath);
        setProjectTab("changes");
      });
      const status = document.createElement("span");
      status.className = "git-badge";
      status.textContent = gitStatusLabel(entry.code);
      const path = document.createElement("strong");
      path.textContent = entry.rawPath || entry.path;
      const stats = document.createElement("span");
      stats.className = "project-strip-stats";
      stats.textContent = changeStatsText(entry);
      row.append(status, path, stats);
      list.append(row);
    }
  }
  const open = document.createElement("button");
  open.type = "button";
  open.className = "project-strip-open";
  open.textContent = "Open changes";
  open.addEventListener("click", async () => {
    setView("files");
    await navigateFiles(info.repositoryPath);
    setProjectTab("changes");
  });
  list.append(open);
  els.chatProjectStrip.append(list);
}

function renderProjectWorkbench({ deferWhileComposing = false } = {}) {
  if (deferWhileComposing && isProjectCommitInputActive()) {
    state.projectWorkbenchRenderPending = true;
    return;
  }
  state.projectWorkbenchRenderPending = false;
  const info = state.projectInfo;
  const activeProjectPath = projectPathFromFilePath();
  const showWorkbench = Boolean(activeProjectPath);
  const showProjectPanel = showWorkbench && state.projectTab !== "files";
  els.gitModeBadge.textContent = state.gitMode === "write" ? "Git writes enabled" : "Git read only";
  els.gitModeBadge.classList.toggle("write", state.gitMode === "write");
  els.gitModeBadge.classList.toggle("read", state.gitMode !== "write");
  els.projectWorkbench.hidden = !showWorkbench;
  els.projectPanel.hidden = !showProjectPanel;
  for (const tab of els.projectTabs) tab.classList.toggle("active", tab.dataset.projectTab === state.projectTab);
  if (!activeProjectPath) {
    els.projectPanel.innerHTML = "";
    els.projectChatButton.disabled = true;
    renderChatProjectStrip();
    return;
  }
  if (!showProjectPanel) {
    els.projectPanel.innerHTML = "";
    renderChatProjectStrip();
  }
  if (state.projectLoading && !info) {
    els.projectTitle.textContent = activeProjectPath.split("/").at(-1) || "Project";
    els.projectMeta.textContent = "Loading repository...";
    els.projectChatButton.disabled = true;
    if (showProjectPanel) els.projectPanel.innerHTML = '<div class="loading-state">Loading project...</div>';
    renderChatProjectStrip();
    return;
  }
  if (!info?.isRepo) {
    els.projectTitle.textContent = activeProjectPath.split("/").at(-1) || "Project";
    els.projectMeta.textContent = "No Git repository found.";
    els.projectChatButton.disabled = true;
    if (showProjectPanel) els.projectPanel.innerHTML = '<div class="empty-state">This folder is under projects, but it is not a Git repository.</div>';
    renderChatProjectStrip();
    return;
  }
  els.projectTitle.textContent = info.repositoryName;
  els.projectMeta.textContent = projectMetaText(info);
  els.projectChatButton.disabled = false;
  els.projectChatButton.textContent = state.chatProjectPath === info.repositoryPath ? "In chat" : "Chat";
  renderBranchControl();
  if (!showProjectPanel) {
    renderChatProjectStrip();
    return;
  }
  if (state.projectTab === "commits") renderProjectCommits();
  else renderProjectChanges();
  renderChatProjectStrip();
}

function renderProjectActionLauncher(info) {
  const panel = document.createElement("section");
  panel.className = "project-action-launcher";
  const title = document.createElement("div");
  title.className = "project-action-title";
  const heading = document.createElement("strong");
  heading.textContent = "Agent actions";
  const meta = document.createElement("span");
  meta.textContent = state.selectedSessionKey ? "Send to selected chat" : "Select a chat first";
  title.append(heading, meta);
  panel.append(title);

  const list = document.createElement("div");
  list.className = "project-action-list";
  for (const action of projectActions) {
    const confirmKey = `project-action:${info?.repositoryPath || projectPathFromFilePath()}:${action.id}`;
    const armed = isConfirmationArmed(confirmKey);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `project-action-button${armed ? " armed" : ""}`;
    button.disabled = !state.selectedSessionKey || state.sending;
    button.dataset.projectAction = action.id;
    const label = document.createElement("strong");
    label.textContent = armed ? "Tap again" : action.label;
    const hint = document.createElement("span");
    hint.textContent = armed ? action.label : action.hint;
    button.append(label, hint);
    button.addEventListener("click", () => sendProjectAction(action.id, info).catch((error) => setStatus(error.message, "error")));
    list.append(button);
  }
  panel.append(list);
  return panel;
}

function renderProjectChanges() {
  const info = state.projectInfo;
  const counts = changeCounts(info);
  els.projectPanel.innerHTML = "";

  const summary = document.createElement("section");
  summary.className = "project-summary";
  for (const [label, value] of [
    ["Changed", counts.total === 0 ? "clean" : String(counts.total)],
    ["Staged", String(counts.staged)],
    ["Untracked", String(counts.untracked)],
  ]) {
    const item = document.createElement("div");
    item.innerHTML = `<span></span><strong></strong>`;
    item.querySelector("span").textContent = label;
    item.querySelector("strong").textContent = value;
    summary.append(item);
  }
  els.projectPanel.append(summary);
  els.projectPanel.append(renderProjectActionLauncher(info));
  els.projectPanel.append(renderProjectGitActions(info));

  const entries = info.diffEntries || [];
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Working tree clean.";
    els.projectPanel.append(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "change-list";
  for (const entry of entries) {
    const article = document.createElement("article");
    article.className = "change-card";
    const header = document.createElement("button");
    header.className = "change-header";
    header.type = "button";
    header.addEventListener("click", () => openProjectFile(entry.path));
    const badge = document.createElement("span");
    badge.className = "git-badge";
    badge.textContent = gitStatusLabel(entry.code);
    const name = document.createElement("strong");
    name.textContent = entry.rawPath || entry.path;
    const kind = document.createElement("span");
    kind.className = "change-kind";
    kind.textContent = `${changeKindText(entry)} · ${changeStatsText(entry)}`;
    header.append(badge, name, kind);
    article.append(header);
    article.append(renderDiffPreview(entry));
    list.append(article);
  }
  els.projectPanel.append(list);
}

function renderProjectGitActions(info) {
  const stateInfo = gitActionState(info);
  const projectPath = info?.repositoryPath || projectPathFromFilePath() || state.selectedProjectPath;
  const panel = document.createElement("section");
  panel.className = "project-git-actions";

  if (state.gitMode !== "write") {
    panel.classList.add("read-only");
    const heading = document.createElement("strong");
    heading.textContent = "Git read only";
    const note = document.createElement("p");
    note.className = "project-git-actions-note";
    note.textContent =
      "Status, history, branches, changes, and diffs remain available. Enable MOBILE_STUDIO_GIT_MODE=write and restart the server to show guarded write controls.";
    panel.append(heading, note);
    return panel;
  }

  const title = document.createElement("div");
  title.className = "project-git-actions-title";
  const heading = document.createElement("strong");
  heading.textContent = "Git actions";
  const meta = document.createElement("span");
  meta.textContent = state.projectActionBusy ? `Running ${state.projectActionBusy}...` : "Guarded writes";
  title.append(heading, meta);
  panel.append(title);

  const buttons = document.createElement("div");
  buttons.className = "project-git-buttons";
  for (const action of [
    { id: "pull", label: "Pull", disabled: stateInfo.pullDisabled, reason: stateInfo.pullReason },
    { id: "stage_all", label: "Stage all", disabled: stateInfo.stageDisabled, reason: stateInfo.stageReason },
    { id: "unstage_all", label: "Unstage", disabled: stateInfo.unstageDisabled, reason: stateInfo.unstageReason },
    { id: "push", label: "Push", disabled: stateInfo.pushDisabled, reason: stateInfo.pushReason },
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "project-git-action-button";
    button.textContent = action.label;
    button.disabled = Boolean(action.disabled);
    button.title = action.reason || action.label;
    button.addEventListener("click", () => runProjectGitAction(action.id).catch((error) => setStatus(error.message, "error")));
    buttons.append(button);
  }
  panel.append(buttons);

  const form = document.createElement("form");
  form.className = "project-commit-form";
  const input = document.createElement("textarea");
  input.name = "commitMessage";
  input.rows = 2;
  input.placeholder = "Commit message";
  input.disabled = Boolean(state.projectActionBusy);
  input.value = getProjectCommitDraft(projectPath);
  input.addEventListener("input", () => setProjectCommitDraft(projectPath, input.value));
  input.addEventListener("blur", () => {
    if (!state.projectWorkbenchRenderPending) return;
    window.setTimeout(() => {
      if (!isProjectCommitInputActive() && state.projectWorkbenchRenderPending) renderProjectWorkbench();
    }, 0);
  });
  const commit = document.createElement("button");
  commit.type = "submit";
  commit.textContent = "Commit";
  commit.disabled = Boolean(stateInfo.commitDisabled);
  commit.title = stateInfo.commitReason || "Commit staged changes";
  form.append(input, commit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    setProjectCommitDraft(projectPath, input.value);
    runProjectGitAction("commit", { message: input.value }).catch((error) => setStatus(error.message, "error"));
  });
  panel.append(form);

  const reason = [stateInfo.pullReason, stateInfo.commitReason, stateInfo.pushReason].filter(Boolean)[0];
  const note = document.createElement("p");
  note.className = "project-git-actions-note";
  note.textContent = reason || "Review the diffs below before staging or committing.";
  panel.append(note);

  return panel;
}

function commitIdentity(commit) {
  return commit?.fullHash || commit?.hash || "";
}

function buildCommitGraphRows(commits) {
  let lanes = [];
  const rows = [];
  let maxLanes = 1;

  for (const commit of commits) {
    const id = commitIdentity(commit);
    if (!id) continue;

    let laneIndex = lanes.indexOf(id);
    if (laneIndex === -1) {
      laneIndex = lanes.findIndex((lane) => !lane);
      if (laneIndex === -1) {
        laneIndex = lanes.length;
        lanes.push(id);
      } else {
        lanes[laneIndex] = id;
      }
    }

    const before = lanes.slice();
    const parents = Array.isArray(commit.parents) ? commit.parents.filter(Boolean) : [];
    let after = lanes.slice();
    if (parents.length > 0) {
      after[laneIndex] = parents[0];
      for (const parent of parents.slice(1).reverse()) {
        if (!after.includes(parent)) after.splice(laneIndex + 1, 0, parent);
      }
    } else {
      after.splice(laneIndex, 1);
    }
    after = after.filter(Boolean);

    maxLanes = Math.max(maxLanes, before.length, after.length, laneIndex + 1);
    rows.push({ commit, before, after, laneIndex, parents });
    lanes = after;
  }

  return { rows, maxLanes: Math.max(maxLanes, 1) };
}

function appendGraphLine(svg, fromLane, fromY, toLane, toY, laneClass) {
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", String(10 + fromLane * 18));
  line.setAttribute("y1", String(fromY));
  line.setAttribute("x2", String(10 + toLane * 18));
  line.setAttribute("y2", String(toY));
  line.setAttribute("class", `commit-graph-line commit-graph-lane-${laneClass % 6}`);
  svg.append(line);
}

function renderCommitGraph(commits) {
  const { rows, maxLanes } = buildCommitGraphRows(commits);
  const card = document.createElement("section");
  card.className = "commit-graph-card";
  card.setAttribute("aria-label", "Commit graph");

  const head = document.createElement("div");
  head.className = "commit-graph-head";
  const title = document.createElement("strong");
  title.textContent = "Mini graph";
  const meta = document.createElement("span");
  meta.textContent = `${rows.length} commits`;
  head.append(title, meta);
  card.append(head);

  const viewport = document.createElement("div");
  viewport.className = "commit-graph-viewport";

  for (const row of rows) {
    const line = document.createElement("article");
    line.className = "commit-graph-row";

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "commit-graph-svg");
    svg.setAttribute("viewBox", `0 0 ${Math.max(30, maxLanes * 18 + 10)} 42`);
    svg.setAttribute("aria-hidden", "true");

    row.before.forEach((lane, index) => {
      if (index === row.laneIndex) {
        appendGraphLine(svg, index, 0, index, 21, index);
        return;
      }
      const nextIndex = row.after.indexOf(lane);
      if (nextIndex !== -1) appendGraphLine(svg, index, 0, nextIndex, 42, index);
    });

    if (row.parents.length === 0) {
      appendGraphLine(svg, row.laneIndex, 21, row.laneIndex, 42, row.laneIndex);
    } else {
      row.parents.forEach((parent, index) => {
        const parentLane = Math.max(0, row.after.indexOf(parent));
        appendGraphLine(svg, row.laneIndex, 21, parentLane, 42, row.laneIndex + index);
      });
    }

    const node = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    node.setAttribute("cx", String(10 + row.laneIndex * 18));
    node.setAttribute("cy", "21");
    node.setAttribute("r", row.parents.length > 1 ? "5.4" : "4.8");
    node.setAttribute("class", `commit-graph-node commit-graph-lane-${row.laneIndex % 6}`);
    svg.append(node);

    const detail = document.createElement("div");
    detail.className = "commit-graph-detail";
    const subject = document.createElement("strong");
    subject.textContent = row.commit.subject || "(no subject)";
    const metaLine = document.createElement("span");
    metaLine.textContent = [row.commit.hash, row.commit.refs || row.commit.date].filter(Boolean).join(" · ");
    detail.append(subject, metaLine);
    line.append(svg, detail);
    viewport.append(line);
  }

  card.append(viewport);
  return card;
}

function renderProjectCommits() {
  const commits = state.projectInfo?.commits || [];
  els.projectPanel.innerHTML = "";
  if (commits.length === 0) {
    els.projectPanel.innerHTML = '<div class="empty-state">No commits found.</div>';
    return;
  }
  const list = document.createElement("div");
  list.className = "commit-list project-commit-list";
  for (const commit of commits) {
    const row = document.createElement("article");
    row.className = "commit-row";
    const subject = document.createElement("strong");
    subject.textContent = commit.subject || "(no subject)";
    const meta = document.createElement("span");
    meta.textContent = [commit.hash, commit.date, commit.author, commit.refs].filter(Boolean).join(" · ");
    row.append(subject, meta);
    list.append(row);
  }
  els.projectPanel.append(list);
  els.projectPanel.append(renderCommitGraph(commits));
}

function setProjectTab(tab) {
  state.projectTab = ["changes", "files", "commits"].includes(tab) ? tab : "changes";
  localStorage.setItem("oms.projectTab", state.projectTab);
  renderFileList();
  renderProjectWorkbench();
}

function diffLineClass(line) {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git") || line.startsWith("index ")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "delete";
  return "context";
}

function renderDiffPreview(entry) {
  const box = document.createElement("div");
  box.className = "diff-preview";
  if (entry.untracked) {
    const row = document.createElement("div");
    row.className = "diff-line diff-note";
    row.textContent = "Untracked file. Open Files to inspect contents.";
    box.append(row);
    return box;
  }
  const diff = entry.diff || "";
  if (!diff.trim()) {
    const row = document.createElement("div");
    row.className = "diff-line diff-note";
    row.textContent = "No text diff available for this change.";
    box.append(row);
    return box;
  }
  const lines = diff.split("\n").slice(0, 260);
  lines.forEach((line, index) => {
    const row = document.createElement("div");
    row.className = `diff-line ${diffLineClass(line)}`;
    const number = document.createElement("span");
    number.className = "diff-line-number";
    number.textContent = String(index + 1);
    const code = document.createElement("code");
    code.textContent = line || " ";
    row.append(number, code);
    box.append(row);
  });
  if (entry.truncated || diff.split("\n").length > lines.length) {
    const row = document.createElement("div");
    row.className = "diff-line diff-note";
    row.textContent = "Diff truncated.";
    box.append(row);
  }
  return box;
}

function renderGit() {
  els.gitContent.innerHTML = "";
  if (state.gitLoading) {
    els.gitMeta.textContent = "Loading repository...";
    const div = document.createElement("div");
    div.className = "loading-state";
    div.textContent = "Loading Git view...";
    els.gitContent.append(div);
    return;
  }
  const info = state.gitInfo;
  if (!info?.isRepo) {
    els.gitMeta.textContent = state.filePath || "home";
    const div = document.createElement("div");
    div.className = "empty-state";
    div.textContent = "No Git repository found for this folder.";
    els.gitContent.append(div);
    return;
  }
  els.gitMeta.textContent = `${info.repositoryName} · ${info.branch} · ${info.repositoryPath}`;

  const summary = document.createElement("section");
  summary.className = "git-summary";
  const repo = document.createElement("div");
  repo.innerHTML = `<span>Repo</span><strong></strong>`;
  repo.querySelector("strong").textContent = info.repositoryName;
  const branch = document.createElement("div");
  branch.innerHTML = `<span>Branch</span><strong></strong>`;
  branch.querySelector("strong").textContent = info.branch;
  const changes = document.createElement("div");
  changes.innerHTML = `<span>Changes</span><strong></strong>`;
  const changedCount = Math.max((info.statusLines || []).length - 1, 0);
  changes.querySelector("strong").textContent = changedCount === 0 ? "clean" : String(changedCount);
  summary.append(repo, branch, changes);
  els.gitContent.append(summary);

  const statusSection = document.createElement("section");
  statusSection.className = "git-block git-list-block";
  const statusTitle = document.createElement("h2");
  statusTitle.textContent = "Changes";
  statusSection.append(statusTitle);
  const statusEntries = info.statusEntries || [];
  if (statusEntries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "git-empty";
    empty.textContent = "Working tree clean.";
    statusSection.append(empty);
  } else {
    const list = document.createElement("div");
    list.className = "git-list";
    for (const item of statusEntries) {
      const row = document.createElement("div");
      row.className = "git-list-row";
      const badge = document.createElement("span");
      badge.className = "git-badge";
      badge.textContent = gitStatusLabel(item.code);
      const path = document.createElement("strong");
      path.textContent = item.path;
      row.append(badge, path);
      list.append(row);
    }
    statusSection.append(list);
  }
  els.gitContent.append(statusSection);

  const commitsSection = document.createElement("section");
  commitsSection.className = "git-block git-list-block";
  const commitsTitle = document.createElement("h2");
  commitsTitle.textContent = "Recent commits";
  commitsSection.append(commitsTitle);
  const commits = info.commits || [];
  if (commits.length === 0) {
    const empty = document.createElement("p");
    empty.className = "git-empty";
    empty.textContent = "No commits found.";
    commitsSection.append(empty);
  } else {
    const list = document.createElement("div");
    list.className = "commit-list";
    for (const commit of commits) {
      const row = document.createElement("article");
      row.className = "commit-row";
      const subject = document.createElement("strong");
      subject.textContent = commit.subject || "(no subject)";
      const meta = document.createElement("span");
      meta.textContent = [commit.hash, commit.date, commit.author, commit.refs].filter(Boolean).join(" · ");
      row.append(subject, meta);
      list.append(row);
    }
    commitsSection.append(list);
  }
  els.gitContent.append(commitsSection);

  els.gitContent.append(createGitBlock("Remotes", info.remotes || [], "No remotes configured."));
}

function clearPreview(message = "No file selected.") {
  state.selectedFilePath = "";
  els.filePreviewMeta.textContent = message;
  els.filePreviewContent.textContent = "";
}

function closeFileReader({ fromHistory = false } = {}) {
  setFileScreen("browser");
  clearPreview();
  setStatus(state.filePath || "home", "ok");
  if (!fromHistory && state.pushedReaderHistory) {
    state.pushedReaderHistory = false;
    history.back();
  }
  if (fromHistory) state.pushedReaderHistory = false;
}

async function loadAttention({ quiet = false } = {}) {
  state.attentionLoading = !quiet;
  if (!quiet) renderHome();
  try {
    state.attention = await api("/api/attention");
    renderHome();
  } finally {
    state.attentionLoading = false;
  }
}

async function loadSessions() {
  state.sessionsLoading = true;
  renderSettingsSessions();
  try {
    const data = await api("/api/sessions");
    state.sessions = data.sessions || [];
    cacheSessions(state.sessions);
    renderSessions();
    renderRunPanel();
    hydrateCachedMessages();
  } finally {
    state.sessionsLoading = false;
    renderSettingsSessions();
  }
}

async function refreshRunState({ quiet = true } = {}) {
  if (!state.selectedSessionKey) {
    state.runState = null;
    renderRunPanel();
    return;
  }
  if (!quiet) {
    state.runLoading = true;
    renderRunPanel();
  }
  const params = new URLSearchParams({
    sessionKey: state.selectedSessionKey,
    details: state.runExpanded ? "1" : "0",
  });
  try {
    state.runState = await api(`/api/run-state?${params.toString()}`);
    if (state.runState.session) {
      state.selectedSession = {
        ...(state.selectedSession || {}),
        ...state.runState.session,
      };
    }
  } finally {
    state.runLoading = false;
    renderSessionMeta();
    renderRunPanel();
  }
}

async function loadHistory({ quiet = false } = {}) {
  if (!state.selectedSessionKey) return;
  if (state.historyPollInFlight) return;
  const sessionKey = state.selectedSessionKey;
  state.historyPollInFlight = true;
  if (!quiet) {
    hydrateCachedMessages();
  }
  state.loading = !quiet && state.messages.length === 0;
  if (!quiet) renderMessages();
  const params = new URLSearchParams({
    sessionKey,
    limit: "80",
  });
  try {
    const data = await api(`/api/history?${params.toString()}`);
    if (state.selectedSessionKey !== sessionKey) {
      state.loading = false;
      return;
    }
    state.messages = filterMessagesForSession(sessionKey, data.messages || []);
    state.pendingMessages = state.pendingMessages.filter(
      (message) => message.sessionKey !== sessionKey || !isPendingMessageAccepted(message, state.messages),
    );
    cacheMessages(sessionKey, state.messages);
    renderSessionMeta(data.sessionInfo);
    state.loading = false;
    renderMessages();
  } finally {
    state.historyPollInFlight = false;
  }
}

async function refreshAll({ quiet = false } = {}) {
  try {
    if (state.activeView === "home") {
      if (!quiet) setStatus("Loading attention state...");
      await loadAttention({ quiet });
      startAttentionPolling();
      setStatus("Home updated", "ok");
    } else if (state.activeView === "files") {
      await loadFiles({ quiet });
      await loadProjectForCurrentPath({ quiet: true });
      startProjectPolling();
      setStatus(state.filePath || "home", "ok");
    } else if (state.activeView === "chat") {
      if (!quiet) setStatus("Connecting...");
      if (!quiet) hydrateCachedSessions();
      if (!quiet) hydrateCachedMessages();
      await loadSessions();
      await refreshRunState({ quiet: true }).catch(() => {});
      await loadHistory({ quiet });
      await refreshChatProject({ quiet: true }).catch(() => {});
      startChatPolling();
      startRunPolling();
      setStatus("Connected to OpenClaw Gateway", "ok");
    } else if (state.activeView === "settings") {
      await loadSessions();
      setStatus("Settings ready", "ok");
    }
  } catch (error) {
    state.loading = false;
    renderMessages();
    setStatus(error.message, "error");
  }
}

async function loadRuntimeConfig() {
  const config = await api("/api/config");
  state.gitMode = config.gitMode === "write" ? "write" : "read";
  renderProjectWorkbench();
}

async function loadFiles({ quiet = false } = {}) {
  state.filesLoading = !quiet;
  if (!quiet) renderFileList();
  const params = new URLSearchParams({ path: state.filePath, showHidden: state.showHidden ? "1" : "0" });
  const data = await api(`/api/files?${params.toString()}`);
  state.fileRoot = data.root || state.fileRoot;
  state.filePath = data.path || "";
  state.fileEntries = data.entries || [];
  localStorage.setItem("oms.filePath", state.filePath);
  els.fileRoot.textContent = state.fileRoot;
  state.filesLoading = false;
  renderFileList();
  await loadProjectForCurrentPath({ quiet: true });
}

async function loadProjectForCurrentPath({ quiet = false } = {}) {
  const projectPath = projectPathFromFilePath();
  if (!projectPath) {
    state.projectInfo = null;
    state.selectedProjectPath = "";
    localStorage.removeItem("oms.selectedProjectPath");
    renderProjectWorkbench();
    return;
  }
  state.selectedProjectPath = projectPath;
  localStorage.setItem("oms.selectedProjectPath", projectPath);
  state.projectLoading = !quiet;
  if (!quiet) renderProjectWorkbench();
  try {
    const params = new URLSearchParams({ path: projectPath });
    state.projectInfo = await api(`/api/project?${params.toString()}`);
  } finally {
    state.projectLoading = false;
    renderProjectWorkbench();
  }
}

async function refreshSelectedProject({ quiet = true } = {}) {
  const path = projectPathFromFilePath() || state.selectedProjectPath;
  if (!path) return;
  const params = new URLSearchParams({ path });
  if (!quiet) {
    state.projectLoading = true;
    renderProjectWorkbench();
  }
  try {
    state.projectInfo = await api(`/api/project?${params.toString()}`);
    state.selectedProjectPath = state.projectInfo.repositoryPath || path;
    localStorage.setItem("oms.selectedProjectPath", state.selectedProjectPath);
  } finally {
    state.projectLoading = false;
    renderProjectWorkbench({ deferWhileComposing: quiet && !state.projectActionBusy });
  }
}

async function refreshChatProject({ quiet = true } = {}) {
  if (!state.chatProjectPath) {
    renderChatProjectStrip();
    return;
  }
  if (!quiet) {
    state.projectLoading = true;
    renderChatProjectStrip();
  }
  try {
    const params = new URLSearchParams({ path: state.chatProjectPath });
    state.chatProjectInfo = await api(`/api/project?${params.toString()}`);
    if (state.chatProjectInfo?.repositoryPath) {
      state.chatProjectPath = state.chatProjectInfo.repositoryPath;
      const key = chatProjectKey();
      if (key) localStorage.setItem(key, state.chatProjectPath);
    }
  } finally {
    state.projectLoading = false;
    renderChatProjectStrip();
  }
}

async function attachCurrentProjectToChat() {
  const path = state.projectInfo?.repositoryPath || projectPathFromFilePath();
  if (!path) return;
  await loadSessions().catch(() => {});
  const existing = state.sessions.find((session) => session.projectPath === path);
  const target = existing || state.sessions.find((session) => !session.projectPath);
  if (!target) {
    window.alert("Tutte le sessioni sono occupate. Libera una sessione nei Settings prima di aprire questo progetto in chat.");
    setStatus("No free chat session for this project.", "error");
    return;
  }
  state.selectedSessionKey = target.key;
  localStorage.setItem("oms.selectedSessionKey", target.key);
  state.selectedSession = target;
  if (!existing) {
    await setSessionProjectPath(target.key, path);
  }
  state.chatProjectPath = path;
  const key = chatProjectKey();
  if (key) localStorage.setItem(key, path);
  state.chatProjectInfo = state.projectInfo?.repositoryPath === path ? state.projectInfo : null;
  state.chatProjectExpanded = true;
  await refreshChatProject({ quiet: true });
  setView("chat");
  startProjectPolling();
  setStatus(`${path.split("/").at(-1) || "Project"} attached to chat`, "ok");
}

async function sendProjectAction(action, info = state.projectInfo) {
  const path = info?.repositoryPath || projectPathFromFilePath();
  if (!path) return;
  const confirmKey = `project-action:${path}:${action}`;
  if (!consumeConfirmation(confirmKey, `Tap ${projectActionLabel(action)} again to send it to OpenClaw.`)) return;
  await attachCurrentProjectToChat();
  if (state.chatProjectPath !== path || !state.selectedSessionKey) return;
  state.chatProjectInfo = info?.repositoryPath === path ? info : null;
  state.chatProjectExpanded = true;
  await refreshChatProject({ quiet: true }).catch(() => {});
  await sendMessage(
    projectActionPrompt(action, {
      repositoryName: info?.repositoryName,
      repositoryPath: path,
      branch: info?.branch,
      counts: changeCounts(info),
    }),
    {
      includeAttachments: false,
      clearComposer: false,
      audit: {
        type: "project_action",
        meta: {
          action,
          projectPath: path,
          branch: info?.branch || "",
        },
      },
    },
  );
}

async function switchProjectBranch(branch) {
  const path = state.projectInfo?.repositoryPath || projectPathFromFilePath();
  if (!path || !branch || branch === state.projectInfo?.branch) {
    renderBranchControl();
    return;
  }
  const ok = window.confirm(`Switch ${state.projectInfo.repositoryName} to branch "${branch}"?\n\nThis changes the Git branch on disk, so Codex will work on that branch too.`);
  if (!ok) {
    renderBranchControl();
    return;
  }
  setStatus(`Switching to ${branch}...`);
  await api("/api/project/branch", {
    method: "POST",
    body: JSON.stringify({ path, branch }),
  });
  await refreshSelectedProject({ quiet: false });
  await loadFiles({ quiet: true });
  setStatus(`Branch switched to ${branch}`, "ok");
}

function gitActionLabel(action) {
  return {
    pull: "Pull",
    stage_all: "Stage all",
    unstage_all: "Unstage",
    commit: "Commit",
    push: "Push",
  }[action] || action;
}

function gitActionConfirmation(action, info, message = "") {
  const repo = info?.repositoryName || "repository";
  const branch = info?.branch || "current branch";
  const counts = changeCounts(info);
  if (action === "stage_all") return "";
  if (action === "pull") return `Pull ${info.tracking} into ${repo}/${branch}?\n\nOnly fast-forward pulls are allowed.`;
  if (action === "unstage_all") return `Unstage ${counts.staged} staged file(s) in ${repo}?`;
  if (action === "commit") return `Commit ${counts.staged} staged file(s) in ${repo}?\n\n${message}`;
  if (action === "push") return `Push ${info.ahead} commit(s) from ${repo}/${branch} to ${info.tracking}?`;
  return "";
}

async function runProjectGitAction(action, options = {}) {
  const path = state.projectInfo?.repositoryPath || projectPathFromFilePath();
  if (!path || state.projectActionBusy) return;
  const message = String(options.message || "").trim();
  if (action === "commit" && !message) {
    setStatus("Commit message is required.", "error");
    return;
  }
  const confirmation = gitActionConfirmation(action, state.projectInfo, message);
  if (confirmation && !window.confirm(confirmation)) return;

  state.projectActionBusy = gitActionLabel(action);
  renderProjectWorkbench();
  setStatus(`${gitActionLabel(action)} running...`);
  try {
    const result = await api("/api/project/git-action", {
      method: "POST",
      body: JSON.stringify({ path, action, message }),
    });
    if (action === "commit") setProjectCommitDraft(path, "");
    await refreshSelectedProject({ quiet: true });
    await refreshChatProject({ quiet: true }).catch(() => {});
    setStatus(result.message || `${gitActionLabel(action)} complete`, "ok");
  } finally {
    state.projectActionBusy = "";
    renderProjectWorkbench();
  }
}

async function loadGit() {
  state.gitLoading = true;
  renderGit();
  const params = new URLSearchParams({ path: state.filePath });
  state.gitInfo = await api(`/api/git?${params.toString()}`);
  state.gitLoading = false;
  renderGit();
}

async function navigateFiles(path) {
  state.filePath = path || "";
  setFileScreen("browser");
  clearPreview();
  setStatus("Loading files...");
  await loadFiles();
  setStatus(state.filePath || "home", "ok");
  startProjectPolling();
}

async function openGit() {
  if (!isProjectsPath()) return;
  setFileScreen("git");
  setStatus("Loading Git view...");
  try {
    await loadGit();
    setStatus(state.gitInfo?.isRepo ? "Git view ready" : "No Git repository here", state.gitInfo?.isRepo ? "ok" : "");
  } catch (error) {
    state.gitLoading = false;
    renderGit();
    setStatus(error.message, "error");
  }
}

async function openFile(entry) {
  state.selectedFilePath = entry.path;
  setFileScreen("reader");
  if (!state.pushedReaderHistory) {
    history.pushState({ mobileStudioFileReader: true }, "", window.location.href);
    state.pushedReaderHistory = true;
  }
  if (!entry.previewable) {
    els.filePreviewMeta.textContent = entry.path;
    els.filePreviewContent.textContent = entry.accessible
      ? "Preview is not available for this file."
      : "This symlink points outside the allowed root.";
    state.selectedFilePath = entry.path;
    return;
  }
  els.filePreviewMeta.textContent = `Loading ${entry.name}...`;
  els.filePreviewContent.textContent = "";
  try {
    const params = new URLSearchParams({ path: entry.path });
    const data = await api(`/api/file?${params.toString()}`);
    els.filePreviewMeta.textContent = `${data.path} · ${formatBytes(data.size)}`;
    els.filePreviewContent.textContent = data.content;
  } catch (error) {
    els.filePreviewMeta.textContent = error.message;
    els.filePreviewContent.textContent = "";
  }
}

async function openProjectFile(path) {
  const projectPath = state.projectInfo?.repositoryPath || projectPathFromFilePath();
  if (!projectPath) return;
  const filePath = `${projectPath}/${path}`.replace(/\/+/g, "/");
  const name = path.split("/").at(-1) || path;
  await openFile({
    path: filePath,
    name,
    type: "file",
    previewable: true,
    accessible: true,
  });
}

function attachmentStatusText(item) {
  if (item.status === "uploaded") return `${formatBytes(item.size)} · ready`;
  if (item.status === "failed") return item.error || "upload failed";
  return `${formatBytes(item.size)} · ${item.progress || 0}%`;
}

function attachmentsForSession(sessionKey = state.selectedSessionKey) {
  return attachmentQueue(state, sessionKey);
}

function removeSessionAttachments(sessionKey, localIds) {
  removeAttachmentItems(state, sessionKey, localIds);
}

function renderAttachments() {
  const attachments = attachmentsForSession();
  els.attachmentList.innerHTML = "";
  els.attachmentList.hidden = attachments.length === 0;
  for (const item of attachments) {
    const row = document.createElement("div");
    row.className = `attachment-chip attachment-${item.status}`;
    const main = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = item.name;
    const meta = document.createElement("small");
    meta.textContent = attachmentStatusText(item);
    main.append(name, meta);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      removeSessionAttachments(item.sessionKey, [item.localId]);
      renderAttachments();
    });
    row.append(main, remove);
    els.attachmentList.append(row);
  }
}

async function addAttachmentFiles(files) {
  const sessionKey = state.selectedSessionKey;
  if (!sessionKey) return;
  const candidates = Array.from(files || []);
  const selected = attachmentFilesWithinLimit(state, sessionKey, candidates, 5);
  if (selected.length < candidates.length) setStatus("Attach at most 5 files per session.", "error");
  if (selected.length === 0) return;
  for (const file of selected) {
    const item = {
      localId: crypto.randomUUID(),
      sessionKey,
      name: file.name || "upload",
      size: file.size,
      type: file.type || "application/octet-stream",
      status: "uploading",
      progress: 0,
      attachment: null,
      error: "",
    };
    attachmentsForSession(sessionKey).push(item);
    renderAttachments();
    uploadAttachment(file, item)
      .then((attachment) => {
        item.status = "uploaded";
        item.progress = 100;
        item.attachment = attachment;
        item.name = attachment.name || item.name;
        item.size = attachment.size || item.size;
        renderAttachments();
      })
      .catch((error) => {
        item.status = "failed";
        item.error = error.message || "upload failed";
        renderAttachments();
      });
  }
}

function readyAttachmentItems(sessionKey = state.selectedSessionKey) {
  return attachmentItemsForSend(state, sessionKey);
}

function readyAttachments(sessionKey = state.selectedSessionKey) {
  return readyAttachmentItems(sessionKey).map((item) => item.attachment);
}

function hasUploadingAttachments(sessionKey = state.selectedSessionKey) {
  return attachmentsForSession(sessionKey).some((item) => item.status === "uploading");
}

function attachmentSummaryText(attachments) {
  if (!attachments.length) return "";
  return [
    "",
    "",
    "Allegati:",
    ...attachments.map((attachment) => `- ${attachment.name} (${formatBytes(attachment.size)})`),
  ].join("\n");
}

async function sendMessage(message, options = {}) {
  const command = message.trim().split(/\s+/)[0]?.toLowerCase() || "";
  const sessionKey = state.selectedSessionKey;
  const includeAttachments = options.includeAttachments !== false;
  const attachmentItems = attachmentItemsForSend(state, sessionKey, includeAttachments);
  const attachments = attachmentItems.map((item) => item.attachment);
  const isNewCommand = command === "/new";
  if (command === "/new") await clearChatProjectAttachment();
  state.sending = true;
  els.sendButton.disabled = true;
  const localMessage = {
    role: "user",
    content: `${message || "Allegati caricati."}${attachmentSummaryText(attachments)}`,
    sessionKey,
    timestamp: Date.now(),
    pendingStatus: "sending",
  };
  state.pendingMessages.push(localMessage);
  if (options.clearComposer !== false) {
    els.messageInput.value = "";
    autosizeInput();
  }
  renderMessages();
  setStatus("Sending to OpenClaw...");
  const idempotencyKey = `mobile-studio:${crypto.randomUUID()}`;
  try {
    await api("/api/send", {
      method: "POST",
      body: JSON.stringify({
        sessionKey,
        message,
        attachments: attachments.map((attachment) => ({ id: attachment.id })),
        idempotencyKey,
        audit: options.audit || undefined,
      }),
    });
    localMessage.pendingStatus = "accepted";
    if (isNewCommand) {
      markSessionReset(sessionKey);
      state.pendingMessages = state.pendingMessages.filter((pending) => pending !== localMessage);
      if (state.selectedSessionKey === sessionKey) {
        state.messages = [];
        cacheMessages(sessionKey, []);
        renderMessages({ force: true });
      }
      setStatus("New chat accepted by Gateway", "ok");
      await loadSessions().catch(() => {});
    } else {
      setStatus("Message accepted by Gateway", "ok");
    }
    if (includeAttachments) removeSessionAttachments(sessionKey, attachmentItems.map((item) => item.localId));
    renderAttachments();
    if (state.selectedSessionKey === sessionKey) {
      await refreshRunState({ quiet: true }).catch(() => {});
      await loadHistory({ quiet: true });
    }
    startChatPolling();
    startRunPolling();
  } catch (error) {
    localMessage.pendingStatus = "failed";
    setStatus(error instanceof Error ? error.message : "Message failed", "error");
    renderMessages();
  } finally {
    state.sending = false;
    els.sendButton.disabled = false;
    if (state.selectedSessionKey === sessionKey) els.messageInput.focus();
  }
}

async function openSettingsSession(sessionKey) {
  if (!sessionKey) return;
  state.selectedSessionKey = sessionKey;
  localStorage.setItem("oms.selectedSessionKey", sessionKey);
  state.selectedSession = sessionByKey(sessionKey);
  loadChatProjectAttachment();
  setView("chat");
  await refreshRunState({ quiet: true }).catch(() => {});
  await loadHistory({ quiet: true }).catch(() => {});
  await refreshChatProject({ quiet: true }).catch(() => {});
}

async function detachSettingsSession(sessionKey) {
  if (!sessionKey || state.sessionActionBusy) return;
  state.sessionActionBusy = `detach:${sessionKey}`;
  renderSettingsSessions();
  try {
    await setSessionProjectPath(sessionKey, "");
    await loadSessions();
    setStatus("Project detached from session", "ok");
  } finally {
    state.sessionActionBusy = "";
    renderSettingsSessions();
  }
}

async function abortSelectedRun() {
  if (!state.selectedSessionKey) return;
  setStatus("Stopping run...");
  await api("/api/abort", {
    method: "POST",
    body: JSON.stringify({
      sessionKey: state.selectedSessionKey,
    }),
  });
  setStatus("Stop requested", "ok");
  await refreshRunState({ quiet: true }).catch(() => {});
  await loadHistory({ quiet: true }).catch(() => {});
}

function stopChatPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function startChatPolling() {
  if (state.activeView !== "chat" || !state.selectedSessionKey) return;
  stopChatPolling();
  state.pollTimer = setInterval(async () => {
    if (document.hidden || state.activeView !== "chat" || !state.selectedSessionKey) return;
    try {
      await loadHistory({ quiet: true });
    } catch {
      stopChatPolling();
    }
  }, 2500);
}

function stopRunPolling() {
  clearInterval(state.runPollTimer);
  state.runPollTimer = null;
}

function startRunPolling() {
  if (state.activeView !== "chat" || !state.selectedSessionKey) return;
  stopRunPolling();
  state.runPollTimer = setInterval(async () => {
    if (document.hidden || state.activeView !== "chat" || !state.selectedSessionKey) return;
    try {
      await refreshRunState({ quiet: true });
    } catch {
      stopRunPolling();
    }
  }, 8000);
}

function stopProjectPolling() {
  clearInterval(state.projectPollTimer);
  state.projectPollTimer = null;
}

function stopAttentionPolling() {
  clearInterval(state.attentionPollTimer);
  state.attentionPollTimer = null;
}

function startAttentionPolling() {
  if (state.activeView !== "home") return;
  stopAttentionPolling();
  state.attentionPollTimer = setInterval(async () => {
    if (document.hidden || state.activeView !== "home") return;
    try {
      await loadAttention({ quiet: true });
    } catch {
      stopAttentionPolling();
    }
  }, 12000);
}

function startProjectPolling() {
  stopProjectPolling();
  if (!state.chatProjectPath && !state.selectedProjectPath && !projectPathFromFilePath()) return;
  state.projectPollTimer = setInterval(async () => {
    if (document.hidden) return;
    try {
      if (state.activeView === "chat") await refreshChatProject({ quiet: true });
      else await refreshSelectedProject({ quiet: true });
    } catch {
      stopProjectPolling();
    }
  }, 4000);
}

function autosizeInput() {
  els.messageInput.style.height = "auto";
  els.messageInput.style.height = `${Math.min(els.messageInput.scrollHeight, 150)}px`;
}

function setCommandPaletteOpen(open) {
  els.commandPalette.hidden = !open;
  els.commandButton.setAttribute("aria-expanded", String(open));
}

function commandQuery() {
  const value = els.messageInput.value.trimStart();
  return value.startsWith("/") ? value.slice(1).toLowerCase() : "";
}

function filteredCommands() {
  const query = commandQuery();
  if (!query) return allCommands;
  return allCommands.filter((command) => {
    const haystack = `${command.label} ${command.value} ${command.group}`.toLowerCase();
    return haystack.includes(query);
  });
}

function insertCommand(value) {
  els.messageInput.value = value;
  autosizeInput();
  renderCommandPalette();
  setCommandPaletteOpen(false);
  els.messageInput.focus();
  const caret = value.length;
  els.messageInput.setSelectionRange(caret, caret);
}

function renderCommandPalette() {
  const commands = filteredCommands();
  els.commandPalette.innerHTML = "";
  if (commands.length === 0) {
    const empty = document.createElement("div");
    empty.className = "command-empty";
    empty.textContent = "No commands";
    els.commandPalette.append(empty);
    return;
  }

  const groups = new Map();
  for (const command of commands) {
    if (!groups.has(command.group)) groups.set(command.group, []);
    groups.get(command.group).push(command);
  }

  for (const [group, items] of groups) {
    const section = document.createElement("section");
    section.className = "command-group";
    const title = document.createElement("p");
    title.className = "command-group-title";
    title.textContent = group;
    section.append(title);
    const list = document.createElement("div");
    list.className = "command-list";
    for (const item of items) {
      const button = document.createElement("button");
      button.className = "command-item";
      button.type = "button";
      button.dataset.command = item.value;
      button.innerHTML = `<span>${item.label}</span><code>${item.value}</code>`;
      list.append(button);
    }
    section.append(list);
    els.commandPalette.append(section);
  }
}

els.sessionSelect.addEventListener("change", async () => {
  state.selectedSessionKey = els.sessionSelect.value;
  localStorage.setItem("oms.selectedSessionKey", state.selectedSessionKey);
  state.selectedSession = state.sessions.find((session) => session.key === state.selectedSessionKey) || null;
  state.runState = null;
  loadChatProjectAttachment();
  state.messages = loadCachedMessages(state.selectedSessionKey);
  state.messageRenderSignature = "";
  renderMessages({ force: true });
  renderAttachments();
  renderRunPanel();
  stopChatPolling();
  stopRunPolling();
  await refreshRunState({ quiet: true }).catch(() => {});
  await loadHistory();
  await refreshChatProject({ quiet: true }).catch(() => {});
  startChatPolling();
  startRunPolling();
  startProjectPolling();
});

els.refreshButton.addEventListener("click", () => refreshAll());

for (const action of els.homeActions) {
  action.addEventListener("click", async () => {
    const name = action.dataset.homeAction;
    if (name === "chat") {
      setView("chat");
      await refreshAll();
    } else if (name === "projects") {
      setView("files");
      await navigateFiles("projects");
    } else if (name === "workspace") {
      setView("files");
      await navigateFiles(".openclaw/workspace");
    }
  });
}

els.filesRefreshButton.addEventListener("click", () => loadFiles().catch((error) => setStatus(error.message, "error")));

els.gitButton.addEventListener("click", openGit);

els.projectsShortcut.addEventListener("click", () => navigateFiles("projects"));

els.workspaceShortcut.addEventListener("click", () => navigateFiles(".openclaw/workspace"));

els.projectChatButton.addEventListener("click", () => {
  attachCurrentProjectToChat().catch((error) => setStatus(error.message, "error"));
});

for (const tab of els.projectTabs) {
  tab.addEventListener("click", () => setProjectTab(tab.dataset.projectTab));
}

els.branchSelect.addEventListener("change", () => {
  switchProjectBranch(els.branchSelect.value).catch((error) => {
    setStatus(error.message, "error");
    renderBranchControl();
  });
});

els.fileOptionsButton.addEventListener("click", () => {
  const isHidden = els.fileOptionsMenu.hidden;
  els.fileOptionsMenu.hidden = !isHidden;
  els.fileOptionsButton.setAttribute("aria-expanded", String(isHidden));
});

els.showHiddenToggle.addEventListener("change", async () => {
  state.showHidden = els.showHiddenToggle.checked;
  localStorage.setItem("oms.showHidden", state.showHidden ? "1" : "0");
  await loadFiles();
});

els.gitBackButton.addEventListener("click", () => {
  setFileScreen("browser");
  setStatus(state.filePath || "home", "ok");
});

els.fileBackButton.addEventListener("click", () => closeFileReader());

els.menuButton.addEventListener("click", openMenu);

els.closeMenuButton.addEventListener("click", closeMenu);

els.sideMenu.addEventListener("click", (event) => {
  if (event.target === els.sideMenu) closeMenu();
});

for (const item of els.navItems) {
  item.addEventListener("click", () => setView(item.dataset.view));
}

for (const option of els.themeOptions) {
  option.addEventListener("click", () => applyTheme(option.dataset.themeChoice));
}

els.settingsSessionList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-session-action]");
  if (!button) return;
  const sessionKey = button.closest("[data-session-key]")?.dataset.sessionKey || "";
  const action = button.dataset.sessionAction;
  if (action === "open") {
    openSettingsSession(sessionKey).catch((error) => setStatus(error.message, "error"));
  } else if (action === "detach") {
    detachSettingsSession(sessionKey).catch((error) => setStatus(error.message, "error"));
  }
});

window.addEventListener("popstate", () => {
  if (state.activeView === "files" && state.fileScreen === "reader") {
    closeFileReader({ fromHistory: true });
  }
});

els.commandButton.addEventListener("click", () => {
  renderCommandPalette();
  setCommandPaletteOpen(els.commandPalette.hidden);
});

els.commandPalette.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-command]");
  if (!button) return;
  insertCommand(button.dataset.command || "");
});

els.attachButton.addEventListener("click", () => els.fileInput.click());

els.fileInput.addEventListener("change", async () => {
  await addAttachmentFiles(els.fileInput.files).catch((error) => setStatus(error.message, "error"));
  els.fileInput.value = "";
});

document.addEventListener("click", (event) => {
  if (els.commandPalette.hidden) return;
  if (els.composer.contains(event.target)) return;
  setCommandPaletteOpen(false);
});

els.messageInput.addEventListener("input", () => {
  autosizeInput();
  clearConfirmation({ render: false });
  if (els.messageInput.value.trimStart().startsWith("/")) {
    renderCommandPalette();
    setCommandPaletteOpen(true);
  } else if (!els.commandPalette.hidden) {
    setCommandPaletteOpen(false);
  }
});

els.messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.commandPalette.hidden) {
    event.preventDefault();
    setCommandPaletteOpen(false);
    return;
  }
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    els.composer.requestSubmit();
  }
});

els.composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = els.messageInput.value.trim();
  const attachments = readyAttachments();
  const hasFailedAttachments = attachmentsForSession().some((item) => item.status === "failed");
  if (state.sending || !state.selectedSessionKey) return;
  if (hasUploadingAttachments()) {
    setStatus("Wait for attachments to finish uploading.", "error");
    return;
  }
  if (hasFailedAttachments) {
    setStatus("Remove failed attachments before sending.", "error");
    return;
  }
  if (!message && attachments.length === 0) return;
  const command = message.split(/\s+/)[0]?.toLowerCase() || "";
  if (riskySlashCommands.has(command)) {
    const key = `slash-command:${state.selectedSessionKey}:${message}`;
    if (!consumeConfirmation(key, `Tap Send again to run ${command}.`)) {
      els.sendButton.textContent = "Confirm";
      return;
    }
  }
  try {
    await sendMessage(message);
  } catch (error) {
    state.sending = false;
    els.sendButton.disabled = false;
    setStatus(error.message, "error");
  }
});

async function initialize() {
  applyTheme();
  setView(["home", "chat", "files", "settings"].includes(state.activeView) ? state.activeView : "home");
  setFileScreen("browser");
  updateFileControls();
  await loadRuntimeConfig();
  await refreshAll();
}

initialize().catch((error) => setStatus(error.message, "error"));
setInterval(() => refreshAll({ quiet: true }), 30000);
