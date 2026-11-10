import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.env.MOBILE_STUDIO_URL || "http://127.0.0.1:8787/mobile-studio/";
const chromiumPath = process.env.CHROMIUM_PATH || "/snap/bin/chromium";
const artifactsDir = new URL("../test-artifacts/", import.meta.url);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function visibleBox(page, selector, label) {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "visible", timeout: 30_000 });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    const box = await locator.boundingBox().catch(() => null);
    if (box && box.width > 0 && box.height > 0) return box;
    await page.waitForTimeout(250);
  }
  throw new Error(`${label} has no visible box`);
}

async function checkNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(overflow <= 2, `${label} has horizontal overflow of ${overflow}px`);
}

async function checkChatContentContained(page, label) {
  const result = await page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const list = document.querySelector("#messageList");
    const listOverflow = list ? list.scrollWidth - list.clientWidth : 0;
    const offenders = [];
    for (const element of document.querySelectorAll("#chatView, #messageList, #composer, .message, .message-content, .message-content pre")) {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && (rect.left < -1 || rect.right > viewportWidth + 1)) {
        offenders.push({
          selector: element.id ? `#${element.id}` : `.${Array.from(element.classList).join(".")}`,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        });
      }
    }
    return { listOverflow, offenders };
  });
  assert(result.listOverflow <= 2, `${label} message list has internal horizontal overflow of ${result.listOverflow}px`);
  assert(result.offenders.length === 0, `${label} chat elements escape viewport: ${JSON.stringify(result.offenders)}`);
}

async function checkChatLayoutNoOverlap(page, label) {
  const layout = await page.evaluate(() => {
    const box = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
        overflowY: getComputedStyle(element).overflowY,
      };
    };
    return {
      chat: box("#chatView"),
      run: box("#runPanel"),
      list: box("#messageList"),
      composer: box("#composer"),
    };
  });

  assert(layout.chat?.overflowY === "hidden", `${label} chat view should clip overflow`);
  assert(layout.list?.overflowY === "auto", `${label} message list should be the scroll container`);
  assert(layout.list && layout.composer, `${label} missing chat layout boxes`);
  assert(
    layout.list.bottom <= layout.composer.top + 1,
    `${label} message list overlaps composer by ${layout.list.bottom - layout.composer.top}px`,
  );
  if (layout.run?.height > 0) {
    assert(
      layout.run.bottom <= layout.list.top + 1,
      `${label} run panel overlaps message list by ${layout.run.bottom - layout.list.top}px`,
    );
  }
}

async function timedJson(page, path, maxMs, label) {
  const started = Date.now();
  const response = await page.request.get(new URL(path, baseUrl).href);
  const elapsed = Date.now() - started;
  assert(response.ok(), `${label} returned HTTP ${response.status()}`);
  assert(elapsed <= maxMs, `${label} took ${elapsed}ms, expected <= ${maxMs}ms`);
  return response.json();
}

async function checkChatApiResponsiveness(page, name) {
  const sessions = await timedJson(page, "api/sessions", 3000, `${name} sessions API`);
  const sessionKey = sessions.sessions?.[0]?.key;
  assert(sessionKey, `${name} sessions API returned no session key`);
  const encoded = encodeURIComponent(sessionKey);
  await timedJson(page, `api/history?sessionKey=${encoded}&limit=80`, 3000, `${name} history API`);
  await timedJson(page, `api/run-state?sessionKey=${encoded}`, 3000, `${name} run-state API`);
}

async function checkHome(page, name) {
  const attention = await timedJson(page, "api/attention", 5000, `${name} attention API`);
  assert(attention.summary, `${name} attention API returned no summary`);
  await timedJson(page, "api/audit?limit=8", 3000, `${name} audit API`);
  await page.goto(`${baseUrl}?view=home`, { waitUntil: "domcontentloaded" });
  await visibleBox(page, "#homeSummary", `${name} home summary`);
  await visibleBox(page, "#attentionList", `${name} attention list`);
  await visibleBox(page, "#homeAuditList", `${name} activity list`);
  await visibleBox(page, ".home-actions", `${name} home actions`);
  await checkNoHorizontalOverflow(page, `${name} home`);

  const title = (await page.locator("#viewTitle").textContent())?.trim();
  assert(title === "Home", `${name} expected Home title, got "${title}"`);
  const metrics = await page.locator(".home-metric").count();
  assert(metrics === 4, `${name} expected 4 home metrics, got ${metrics}`);
  const actionCount = await page.locator(".home-action").count();
  assert(actionCount === 3, `${name} expected 3 home actions, got ${actionCount}`);

  await page.evaluate(() => {
    document.querySelector("#homeView")?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: new URL(`${name}-home.png`, artifactsDir).pathname, fullPage: true });
}

async function checkChat(page, name) {
  await page.goto(`${baseUrl}?view=chat`, { waitUntil: "domcontentloaded" });
  await checkChatApiResponsiveness(page, name);
  await page.waitForFunction(() => document.querySelector("#sessionSelect")?.options.length > 0, null, {
    timeout: 35_000,
  });
  await page.waitForFunction(() => !document.querySelector("#runPanel")?.hidden, null, { timeout: 35_000 });

  const title = (await page.locator("#viewTitle").textContent())?.trim();
  assert(title === "Mobile Studio", `${name} expected Chat title, got "${title}"`);
  const selectedSessionLabel = (await page.locator("#sessionSelect option:checked").textContent())?.trim() || "";
  assert(!selectedSessionLabel.startsWith("telegram:"), `${name} selected session label is too technical`);

  await visibleBox(page, "#runPanel", `${name} run panel`);
  await visibleBox(page, "#messageList", `${name} message list`);
  await visibleBox(page, "#composer", `${name} composer`);
  await checkNoHorizontalOverflow(page, name);
  await checkChatLayoutNoOverlap(page, `${name} chat`);
  await checkChatContentContained(page, `${name} chat`);

  const composer = await page.locator("#composer").boundingBox();
  const viewport = page.viewportSize();
  assert(composer && viewport && composer.y + composer.height <= viewport.height + 1, `${name} composer is clipped`);

  await page.screenshot({ path: new URL(`${name}-chat.png`, artifactsDir).pathname, fullPage: true });
}

async function checkMessageFormatting(browser) {
  const sessionKey = "agent:main:telegram:group:formatting";
  const sessionsPayload = {
    ok: true,
    sessions: [
      {
        key: sessionKey,
        sessionId: "formatting-session",
        agentId: "main",
        kind: "group",
        displayName: "Formatting",
        subject: "Formatting",
        status: "idle",
        hasLocalHistory: true,
      },
    ],
  };
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(({ key, sessions }) => {
    localStorage.setItem("oms.selectedSessionKey", key);
    localStorage.setItem("oms.sessions.v1", JSON.stringify(sessions.sessions));
  }, { key: sessionKey, sessions: sessionsPayload });
  const page = await context.newPage();
  page.setDefaultTimeout(35_000);
  await page.route("**/api/sessions", (route) => route.fulfill({ json: sessionsPayload }));
  await page.route("**/api/history?**", (route) =>
    route.fulfill({
      json: {
        ok: true,
        source: "test",
        messages: [
          {
            role: "assistant",
            timestamp: Date.now() - 1000,
            content: [{ type: "text", content: "'''text\nPulito\n\n- uno\n- due\n'''" }],
          },
          {
            role: "assistant",
            timestamp: Date.now(),
            content:
              "Piano consigliato: farei **un commit unico**, perche le modifiche sono intrecciate.\n\n" +
              "**Da mettere in stage:**\n\n" +
              "```bash\n" +
              "git add .env.example README.md lib/audit.js package.json package-lock.json server.js public/index.html public/app.js public/styles.css tests/visual-smoke.mjs\n" +
              "```\n\n" +
              "Copre:\n" +
              "- allegati chat con upload locale streaming\n" +
              "- session pool gestito da Settings e binding progetto-sessione\n" +
              "- rendering messaggi/chat layout\n\n" +
              "**Messaggio commit:** `feat: add chat attachments and managed project sessions`",
          },
        ],
      },
    }),
  );
  await page.route("**/api/run-state?**", (route) =>
    route.fulfill({ json: { ok: true, session: { key: sessionKey, status: "idle" }, tasks: [] } }),
  );
  await page.goto(`${baseUrl}?view=chat`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#messageList")?.textContent?.includes("Pulito"));

  const text = (await page.locator("#messageList").textContent()) || "";
  assert(!text.includes("'''text"), "raw text fence marker leaked into message rendering");
  assert((await page.locator(".message-content ul li").count()) === 2, "message bullets were not rendered as list items");
  assert((await page.locator(".message-content strong").count()) >= 3, "bold markdown was not rendered as strong text");
  assert((await page.locator(".message-content pre code").count()) === 1, "fenced code was not rendered as a code block");
  await checkNoHorizontalOverflow(page, "message formatting");
  await checkChatLayoutNoOverlap(page, "message formatting");
  await checkChatContentContained(page, "message formatting");
  await page.screenshot({ path: new URL("mobile-message-formatting.png", artifactsDir).pathname, fullPage: true });
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await context.close();
}

async function checkChatMessageOrderAndComposer(browser) {
  const sessionKey = "agent:main:telegram:group:order-composer";
  const sessionsPayload = {
    ok: true,
    sessions: [
      {
        key: sessionKey,
        sessionId: "order-composer-session",
        agentId: "main",
        kind: "group",
        displayName: "Order Composer",
        subject: "Order Composer",
        status: "idle",
        hasLocalHistory: true,
      },
    ],
  };
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(({ key, sessions }) => {
    localStorage.setItem("oms.selectedSessionKey", key);
    localStorage.setItem("oms.sessions.v1", JSON.stringify(sessions.sessions));
  }, { key: sessionKey, sessions: sessionsPayload });
  const page = await context.newPage();
  page.setDefaultTimeout(35_000);
  let sent = false;
  await page.route("**/api/sessions", (route) => route.fulfill({ json: sessionsPayload }));
  await page.route("**/api/history?**", (route) =>
    route.fulfill({
      json: {
        ok: true,
        source: "test",
        messages: sent
          ? [
              {
                role: "assistant",
                timestamp: Date.now() + 1000,
                content: "Risposta dopo richiesta",
              },
            ]
          : [],
      },
    }),
  );
  await page.route("**/api/run-state?**", (route) =>
    route.fulfill({ json: { ok: true, session: { key: sessionKey, status: "idle" }, tasks: [] } }),
  );
  await page.route("**/api/send", async (route) => {
    sent = true;
    await route.fulfill({ json: { ok: true, idempotencyKey: "order-composer-send" } });
  });

  await page.goto(`${baseUrl}?view=chat`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#sessionSelect option:checked")?.textContent?.trim() === "Order Composer");
  await page.locator("#messageInput").fill("Prima richiesta");
  await page.locator("#sendButton").click();
  await page.waitForFunction(() => document.querySelector("#messageList")?.textContent?.includes("Risposta dopo richiesta"));

  const messageTexts = await page.locator("#messageList .message-content").evaluateAll((nodes) =>
    nodes.map((node) => node.textContent?.trim() || ""),
  );
  assert(messageTexts[0]?.includes("Prima richiesta"), `request rendered after response: ${messageTexts.join(" | ")}`);
  assert(messageTexts[1]?.includes("Risposta dopo richiesta"), `assistant response was not second: ${messageTexts.join(" | ")}`);

  const commandRow = await page.locator(".command-row").boundingBox();
  const composer = await page.locator("#composer").boundingBox();
  assert(commandRow && commandRow.height <= 32, `command row is too tall: ${commandRow?.height}`);
  assert(composer && composer.height <= 130, `empty composer is too tall: ${composer?.height}`);
  await checkNoHorizontalOverflow(page, "chat message order and composer");
  await checkChatLayoutNoOverlap(page, "chat message order and composer");
  await checkChatContentContained(page, "chat message order and composer");
  await page.screenshot({ path: new URL("mobile-message-order-composer.png", artifactsDir).pathname, fullPage: true });
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await context.close();
}

async function checkAttachmentComposer(browser) {
  const sessionKey = "agent:main:telegram:group:attachments";
  const otherSessionKey = "agent:main:telegram:group:attachments-other";
  const sessionsPayload = {
    ok: true,
    sessions: [
      {
        key: sessionKey,
        sessionId: "attachments-session",
        agentId: "main",
        kind: "group",
        displayName: "Attachments",
        subject: "Attachments",
        status: "idle",
        hasLocalHistory: true,
      },
      {
        key: otherSessionKey,
        sessionId: "attachments-other-session",
        agentId: "main",
        kind: "group",
        displayName: "Attachments Other",
        subject: "Attachments Other",
        status: "idle",
        hasLocalHistory: true,
      },
    ],
  };
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(({ key, sessions }) => {
    localStorage.setItem("oms.selectedSessionKey", key);
    localStorage.setItem("oms.sessions.v1", JSON.stringify(sessions.sessions));
  }, { key: sessionKey, sessions: sessionsPayload });
  const page = await context.newPage();
  page.setDefaultTimeout(35_000);
  await page.route("**/api/sessions", (route) => route.fulfill({ json: sessionsPayload }));
  await page.route("**/api/history?**", (route) => route.fulfill({ json: { ok: true, messages: [], source: "test" } }));
  await page.route("**/api/run-state?**", (route) =>
    route.fulfill({ json: { ok: true, session: { key: sessionKey, status: "idle" }, tasks: [] } }),
  );
  let uploadCount = 0;
  await page.route("**/api/uploads", async (route) => {
    await route.request().postDataBuffer();
    uploadCount += 1;
    await route.fulfill({
      json: {
        ok: true,
        attachment: {
          id: uploadCount === 1 ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222",
          name: uploadCount === 1 ? "sample.jpg" : "other.jpg",
          originalName: uploadCount === 1 ? "sample.jpg" : "other.jpg",
          mime: "image/jpeg",
          size: 12,
          path: "/tmp/mobile-studio-test/sample.jpg",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
      },
    });
  });
  let sendPayload = null;
  await page.route("**/api/send", async (route) => {
    sendPayload = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true, idempotencyKey: sendPayload.idempotencyKey, result: { ok: true } } });
  });

  await page.goto(`${baseUrl}?view=chat`, { waitUntil: "domcontentloaded" });
  await page.locator("#fileInput").setInputFiles({
    name: "sample.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("fake-jpeg"),
  });
  await page.waitForFunction(() => document.querySelector(".attachment-chip")?.textContent?.includes("ready"));
  await page.locator("#sessionSelect").selectOption(otherSessionKey);
  await page.waitForFunction(() => document.querySelectorAll(".attachment-chip").length === 0);
  await page.locator("#fileInput").setInputFiles({
    name: "other.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("other-jpeg"),
  });
  await page.waitForFunction(() => document.querySelector(".attachment-chip")?.textContent?.includes("other.jpg"));
  await page.locator("#sessionSelect").selectOption(sessionKey);
  await page.waitForFunction(() => document.querySelector(".attachment-chip")?.textContent?.includes("sample.jpg"));
  await page.locator("#messageInput").fill("Guarda questa foto");
  await page.locator("#sendButton").click();
  for (let attempt = 0; attempt < 20 && !sendPayload; attempt += 1) {
    await page.waitForTimeout(250);
  }
  assert(sendPayload, "attachment send did not call /api/send");
  assert(sendPayload.message === "Guarda questa foto", "attachment send changed the user message");
  assert(sendPayload.attachments?.[0]?.id === "11111111-1111-4111-8111-111111111111", "attachment id missing from send payload");
  await page.locator("#sessionSelect").selectOption(otherSessionKey);
  await page.waitForFunction(() => document.querySelector(".attachment-chip")?.textContent?.includes("other.jpg"));
  await checkNoHorizontalOverflow(page, "attachment composer");
  await page.screenshot({ path: new URL("mobile-attachment-composer.png", artifactsDir).pathname, fullPage: true });
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await context.close();
}

async function checkFiles(page, name) {
  await page.goto(`${baseUrl}?view=files`, { waitUntil: "domcontentloaded" });
  await visibleBox(page, "#fileBrowserScreen", `${name} files screen`);
  await visibleBox(page, ".files-toolbar", `${name} files toolbar`);
  await visibleBox(page, "#projectsShortcut", `${name} projects shortcut`);
  await visibleBox(page, "#workspaceShortcut", `${name} workspace shortcut`);
  await checkNoHorizontalOverflow(page, `${name} files`);

  const title = (await page.locator("#viewTitle").textContent())?.trim();
  assert(title === "Files", `${name} expected Files title, got "${title}"`);
  const fileKinds = await page.locator(".file-row-kind").evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim()));
  assert(!fileKinds.includes("LINK"), `${name} file browser still renders LINK kind`);

  await page.screenshot({ path: new URL(`${name}-files.png`, artifactsDir).pathname, fullPage: true });
}

async function checkSettingsSessionRows(page, name) {
  // DOMContentLoaded and the list container precede the async sessions response.
  await page.locator("#settingsSessionList .settings-session-row").first().waitFor({
    state: "visible",
    timeout: 35_000,
  });
  const sessionRows = await page.locator("#settingsSessionList .settings-session-row").count();
  assert(sessionRows > 0, `${name} expected settings session rows`);
}

async function checkDelayedSettingsSessions(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  let releaseSessions;
  const sessionsReady = new Promise((resolve) => { releaseSessions = resolve; });
  const sessions = Array.from({ length: 7 }, (_, index) => ({
    key: `agent:main:mobile-studio:session:delayed-${index}`,
    displayName: `Delayed session ${index + 1}`,
    status: "idle",
    projectPath: "",
  }));
  await page.route("**/api/sessions", async (route) => {
    await sessionsReady;
    await route.fulfill({ json: { ok: true, sessions } });
  });
  try {
    await page.goto(`${baseUrl}?view=settings`, { waitUntil: "domcontentloaded" });
    assert(await page.locator(".settings-session-row").count() === 0, "delayed Settings fixture loaded too early");
    // Start the same product assertion while the response is still held back.
    const rowsReady = checkSettingsSessionRows(page, "delayed Settings");
    releaseSessions();
    await rowsReady;
    assert(await page.locator(".settings-session-row").count() === 7, "delayed Settings did not render all 7 sessions");
    console.log("Settings race regression passed: 0 rows before response, 7 after response");
  } finally {
    releaseSessions();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await context.close();
  }
}

async function checkSettingsTheme(page, name) {
  await page.goto(`${baseUrl}?view=settings`, { waitUntil: "domcontentloaded" });
  await visibleBox(page, ".settings-section", `${name} settings section`);
  await visibleBox(page, ".theme-control", `${name} theme control`);
  await visibleBox(page, "#settingsSessionList", `${name} settings session list`);
  await checkNoHorizontalOverflow(page, `${name} settings`);

  const title = (await page.locator("#viewTitle").textContent())?.trim();
  assert(title === "Settings", `${name} expected Settings title, got "${title}"`);
  const themeButtons = await page.locator(".theme-option").count();
  assert(themeButtons === 2, `${name} expected 2 theme buttons, got ${themeButtons}`);
  await checkSettingsSessionRows(page, name);

  await page.locator('[data-theme-choice="light"]').click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  const lightBg = await page.locator(".app-shell").evaluate((node) => getComputedStyle(node).backgroundColor);
  assert(lightBg === "rgb(255, 255, 255)", `${name} expected white light theme background, got ${lightBg}`);
  await page.screenshot({ path: new URL(`${name}-settings-light.png`, artifactsDir).pathname, fullPage: true });

  await page.locator('[data-theme-choice="dark"]').click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  const darkBg = await page.locator("body").evaluate((node) => getComputedStyle(node).backgroundColor);
  assert(darkBg !== "rgb(17, 24, 32)", `${name} dark theme should be darker than the previous background`);
  await page.screenshot({ path: new URL(`${name}-settings-dark.png`, artifactsDir).pathname, fullPage: true });
}

async function checkProjectGitActions(page, name) {
  await page.goto(`${baseUrl}?view=files&path=projects/Bluesky-moderation-analysis&tab=changes`, {
    waitUntil: "domcontentloaded",
  });
  await visibleBox(page, "#projectWorkbench", `${name} project workbench`);
  await visibleBox(page, ".project-action-launcher", `${name} project action launcher`);
  await visibleBox(page, ".project-git-actions", `${name} git actions`);
  await visibleBox(page, ".project-commit-form", `${name} commit form`);
  await checkNoHorizontalOverflow(page, `${name} project git actions`);
  const viewport = page.viewportSize();
  const projectPanel = await page.locator("#projectPanel").boundingBox();
  if (viewport?.width <= 520) {
    assert(
      projectPanel && projectPanel.y + projectPanel.height >= viewport.height - 24,
      `${name} project panel leaves dead space below the workbench`,
    );
  }

  const buttons = await page.locator(".project-git-action-button").count();
  assert(buttons === 4, `${name} expected 4 Git action buttons, got ${buttons}`);
  const agentButtons = await page.locator(".project-action-button").count();
  assert(agentButtons === 5, `${name} expected 5 project action buttons, got ${agentButtons}`);
  const textarea = page.locator(".project-commit-form textarea");
  await textarea.fill("Draft commit message");
  await textarea.focus();
  await page.waitForTimeout(4500);
  assert((await textarea.inputValue()) === "Draft commit message", `${name} commit message draft was lost during polling`);
  const textareaStillFocused = await page.evaluate(() => document.activeElement?.matches(".project-commit-form textarea"));
  assert(textareaStillFocused, `${name} commit message input lost focus during polling`);

  const title = (await page.locator("#viewTitle").textContent())?.trim();
  assert(title === "Files", `${name} expected Files title in project view, got "${title}"`);

  await page.evaluate(() => {
    document.querySelector("#projectPanel")?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: new URL(`${name}-project-git.png`, artifactsDir).pathname, fullPage: true });
}

async function checkWorkspaceProjectWorkbench(page, name) {
  const workspaceProjectPath = "projects/openclaw-mobile-studio";
  const projects = await timedJson(page, "api/projects", 5000, `${name} projects API`);
  assert(
    projects.projects?.some((project) => project.path === workspaceProjectPath),
    `${name} projects API did not include Mobile Studio project`,
  );

  await page.goto(`${baseUrl}?view=files&path=${encodeURIComponent(workspaceProjectPath)}&tab=changes`, {
    waitUntil: "domcontentloaded",
  });
  await visibleBox(page, "#projectWorkbench", `${name} Mobile Studio project workbench`);
  await visibleBox(page, ".project-action-launcher", `${name} Mobile Studio project action launcher`);
  await visibleBox(page, ".project-git-actions", `${name} Mobile Studio project git actions`);
  await checkNoHorizontalOverflow(page, `${name} Mobile Studio project`);

  const title = (await page.locator("#projectTitle").textContent())?.trim();
  assert(title === "openclaw-mobile-studio", `${name} expected workspace project title, got "${title}"`);
}

async function checkProjectCommitGraph(page, name) {
  const graphProjectPath = "projects/COCAttackAnalyzer";
  await page.goto(`${baseUrl}?view=files&path=${encodeURIComponent(graphProjectPath)}&tab=commits`, {
    waitUntil: "domcontentloaded",
  });
  await visibleBox(page, "#projectWorkbench", `${name} commit workbench`);
  await visibleBox(page, ".project-commit-list", `${name} commit list`);
  await visibleBox(page, ".commit-graph-card", `${name} commit graph`);
  await checkNoHorizontalOverflow(page, `${name} commit graph`);

  const commitRows = await page.locator(".project-commit-list .commit-row").count();
  assert(commitRows > 3, `${name} expected multiple commit rows, got ${commitRows}`);
  const graphNodes = await page.locator(".commit-graph-node").count();
  const graphLines = await page.locator(".commit-graph-line").count();
  assert(graphNodes >= commitRows, `${name} expected graph nodes for commits, got ${graphNodes} nodes and ${commitRows} rows`);
  assert(graphLines >= commitRows, `${name} expected graph lines for commits, got ${graphLines} lines and ${commitRows} rows`);

  const listScroll = await page.locator(".project-commit-list").evaluate((node) => ({
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    overflowY: getComputedStyle(node).overflowY,
  }));
  assert(listScroll.overflowY === "auto", `${name} commit list overflow is ${listScroll.overflowY}, expected auto`);
  assert(
    listScroll.scrollHeight > listScroll.clientHeight,
    `${name} commit list is not scrollable: ${listScroll.scrollHeight} <= ${listScroll.clientHeight}`,
  );

  await page.evaluate(() => {
    document.querySelector("#projectPanel")?.scrollTo(0, 0);
    document.querySelector(".project-commit-list")?.scrollTo(0, 0);
    document.querySelector(".commit-graph-viewport")?.scrollTo(0, 0);
  });
  await page.screenshot({ path: new URL(`${name}-project-commits.png`, artifactsDir).pathname, fullPage: true });
}

async function checkCachedSessionFirstPaint(browser) {
  const cachedKey = "agent:main:telegram:group:cached-smoke";
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(({ key }) => {
    localStorage.setItem(
      "oms.sessions.v1",
      JSON.stringify([
        {
          key,
          sessionId: "cached-smoke-session",
          agentId: "main",
          kind: "group",
          displayName: "Cached Smoke Session",
          channel: "telegram",
          subject: "Cached Smoke Session",
          status: "cached",
          updatedAt: Date.now(),
          hasLocalHistory: true,
        },
      ]),
    );
    localStorage.setItem("oms.selectedSessionKey", key);
    localStorage.setItem(
      `oms.messages.${encodeURIComponent(key)}`,
      JSON.stringify([{ role: "user", content: "cached first paint", timestamp: Date.now() }]),
    );
  }, { key: cachedKey });
  const page = await context.newPage();
  page.setDefaultTimeout(35_000);
  await page.route("**/api/sessions", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await route.continue();
  });
  await page.goto(`${baseUrl}?view=chat`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelector("#sessionSelect option:checked")?.textContent?.trim() === "Cached Smoke Session",
    null,
    { timeout: 700 },
  );
  const cachedMessage = (await page.locator("#messageList").textContent()) || "";
  assert(cachedMessage.includes("cached first paint"), "cached message did not render before sessions API returned");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await context.close();
}

async function checkPendingMessagesStayInSession(browser) {
  const sessionA = "agent:main:telegram:group:pending-a";
  const sessionB = "agent:main:telegram:group:pending-b";
  const sessionsPayload = {
    ok: true,
    sessions: [
      {
        key: sessionA,
        sessionId: "pending-a",
        agentId: "main",
        kind: "group",
        displayName: "Pending A",
        subject: "Pending A",
        status: "idle",
        hasLocalHistory: true,
      },
      {
        key: sessionB,
        sessionId: "pending-b",
        agentId: "main",
        kind: "group",
        displayName: "Pending B",
        subject: "Pending B",
        status: "idle",
        hasLocalHistory: true,
      },
    ],
  };
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(({ key }) => {
    localStorage.setItem("oms.selectedSessionKey", key);
  }, { key: sessionA });
  const page = await context.newPage();
  page.setDefaultTimeout(35_000);
  await page.route("**/api/sessions", (route) => route.fulfill({ json: sessionsPayload }));
  await page.route("**/api/history?**", (route) => route.fulfill({ json: { ok: true, messages: [], source: "test" } }));
  await page.route("**/api/run-state?**", (route) =>
    route.fulfill({ json: { ok: true, session: { key: sessionA, status: "idle" }, tasks: [] } }),
  );
  let sendCount = 0;
  await page.route("**/api/send", async (route) => {
    sendCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await route.fulfill({ json: { ok: true, idempotencyKey: "visual-smoke-send" } });
  });
  await page.goto(`${baseUrl}?view=chat`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#sessionSelect option:checked")?.textContent?.trim() === "Pending A");
  await page.locator("#messageInput").fill("/new");
  await page.locator("#sendButton").click();
  await page.waitForFunction(() => document.querySelector("#sendButton")?.textContent?.trim() === "Confirm");
  assert(sendCount === 0, "/new sent before second confirmation click");
  await page.locator("#sendButton").click();
  await page.waitForFunction(() => document.querySelector("#messageList")?.textContent?.includes("/new"), null, {
    timeout: 700,
  });
  await page.locator("#sessionSelect").selectOption(sessionB);
  await page.waitForFunction(() => document.querySelector("#sessionSelect option:checked")?.textContent?.trim() === "Pending B");
  const otherSessionText = (await page.locator("#messageList").textContent()) || "";
  assert(!otherSessionText.includes("/new"), "pending /new leaked into another session");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await context.close();
}

async function checkNewCommandHidesOldHistory(browser) {
  const sessionKey = "agent:main:telegram:group:new-reset";
  const sessionsPayload = {
    ok: true,
    sessions: [
      {
        key: sessionKey,
        sessionId: "new-reset",
        agentId: "main",
        kind: "group",
        displayName: "New Reset",
        subject: "New Reset",
        status: "idle",
        hasLocalHistory: true,
      },
    ],
  };
  const oldHistoryPayload = {
    ok: true,
    messages: [{ role: "assistant", content: "old message before reset", timestamp: 1 }],
    source: "test",
  };
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(({ key }) => {
    localStorage.setItem("oms.selectedSessionKey", key);
  }, { key: sessionKey });
  const page = await context.newPage();
  page.setDefaultTimeout(35_000);
  await page.route("**/api/sessions", (route) => route.fulfill({ json: sessionsPayload }));
  await page.route("**/api/history?**", (route) => route.fulfill({ json: oldHistoryPayload }));
  await page.route("**/api/run-state?**", (route) =>
    route.fulfill({ json: { ok: true, session: { key: sessionKey, status: "idle" }, tasks: [] } }),
  );
  let sendCount = 0;
  await page.route("**/api/send", (route) => {
    sendCount += 1;
    route.fulfill({ json: { ok: true, idempotencyKey: "new-reset-send" } });
  });
  await page.goto(`${baseUrl}?view=chat`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#messageList")?.textContent?.includes("old message before reset"));
  await page.locator("#messageInput").fill("/new");
  await page.locator("#sendButton").click();
  await page.waitForFunction(() => document.querySelector("#sendButton")?.textContent?.trim() === "Confirm");
  assert(sendCount === 0, "/new reset sent before second confirmation click");
  await page.locator("#sendButton").click();
  await page.waitForFunction(() => document.querySelector("#statusText")?.textContent?.includes("New chat accepted"));
  const messageText = (await page.locator("#messageList").textContent()) || "";
  assert(!messageText.includes("old message before reset"), "/new did not hide old history");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await context.close();
}

async function checkProjectActionDoubleTap(browser) {
  const sessionKey = "agent:main:telegram:group:project-action";
  const sessionsPayload = {
    ok: true,
    sessions: [
      {
        key: sessionKey,
        sessionId: "project-action-session",
        agentId: "main",
        kind: "group",
        displayName: "Project Action",
        subject: "Project Action",
        status: "idle",
        hasLocalHistory: true,
      },
    ],
  };
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(({ key, sessions }) => {
    localStorage.setItem("oms.selectedSessionKey", key);
    localStorage.setItem("oms.sessions.v1", JSON.stringify(sessions.sessions));
  }, { key: sessionKey, sessions: sessionsPayload });
  const page = await context.newPage();
  page.setDefaultTimeout(35_000);
  await page.route("**/api/sessions", (route) => route.fulfill({ json: sessionsPayload }));
  await page.route("**/api/history?**", (route) => route.fulfill({ json: { ok: true, messages: [], source: "test" } }));
  await page.route("**/api/run-state?**", (route) =>
    route.fulfill({ json: { ok: true, session: { key: sessionKey, status: "idle" }, tasks: [] } }),
  );
  await page.route("**/api/session-project", async (route) => {
    const payload = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true, sessionKey: payload.sessionKey, projectPath: payload.projectPath || "" } });
  });
  await page.route("**/api/uploads", async (route) => {
    await route.request().postDataBuffer();
    await route.fulfill({
      json: {
        ok: true,
        attachment: {
          id: "33333333-3333-4333-8333-333333333333",
          name: "composer-only.txt",
          mime: "text/plain",
          size: 8,
          path: "/tmp/mobile-studio-test/composer-only.txt",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        },
      },
    });
  });
  const sendPayloads = [];
  await page.route("**/api/send", async (route) => {
    sendPayloads.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true, idempotencyKey: "project-action-send" } });
  });
  await page.goto(`${baseUrl}?view=files&path=projects/Bluesky-moderation-analysis&tab=changes`, {
    waitUntil: "domcontentloaded",
  });
  await visibleBox(page, ".project-action-launcher", "project action double-tap launcher");
  await page.locator("#menuButton").click();
  await page.locator('.nav-item[data-view="chat"]').click();
  await page.locator("#fileInput").setInputFiles({
    name: "composer-only.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("composer"),
  });
  await page.waitForFunction(() => document.querySelector(".attachment-chip")?.textContent?.includes("composer-only.txt"));
  await page.locator("#menuButton").click();
  await page.locator('.nav-item[data-view="files"]').click();
  await visibleBox(page, ".project-action-launcher", "project action double-tap launcher after composer upload");
  await page.locator('.project-action-button[data-project-action="review_changes"]').click();
  await page.waitForFunction(() => document.querySelector("#statusText")?.textContent?.includes("Tap Review again"));
  assert(sendPayloads.length === 0, "project action sent before second tap");
  await page.locator('.project-action-button[data-project-action="review_changes"]').click();
  await page.waitForFunction(() => document.querySelector("#viewTitle")?.textContent?.trim() === "Mobile Studio");
  for (let attempt = 0; attempt < 20 && sendPayloads.length === 0; attempt += 1) {
    await page.waitForTimeout(250);
  }
  assert(sendPayloads.length === 1, `expected one project action send, got ${sendPayloads.length}`);
  assert(sendPayloads[0].audit?.type === "project_action", "project action send missing audit type");
  assert(sendPayloads[0].audit?.meta?.action === "review_changes", "project action audit has wrong action");
  assert(sendPayloads[0].message?.includes("Review the current changes"), "project action prompt is not the Review prompt");
  assert(sendPayloads[0].attachments?.length === 0, "project action implicitly carried composer attachments");
  await page.waitForFunction(() => document.querySelector(".attachment-chip")?.textContent?.includes("composer-only.txt"));
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await context.close();
}

async function checkProjectChatUsesFreeSession(browser) {
  const occupiedKey = "agent:main:mobile-studio:session:occupied";
  const freeKey = "agent:main:mobile-studio:session:free";
  const targetProject = "projects/Bluesky-moderation-analysis";
  const sessionsPayload = {
    ok: true,
    sessions: [
      {
        key: occupiedKey,
        sessionId: "occupied",
        agentId: "main",
        kind: "mobile-studio",
        displayName: "Occupied Slot",
        subject: "Occupied Slot",
        status: "idle",
        hasLocalHistory: true,
        projectPath: "projects/OtherProject",
      },
      {
        key: freeKey,
        sessionId: "free",
        agentId: "main",
        kind: "mobile-studio",
        displayName: "Free Slot",
        subject: "Free Slot",
        status: "idle",
        hasLocalHistory: false,
        projectPath: "",
      },
    ],
  };
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(({ key }) => {
    localStorage.setItem("oms.selectedSessionKey", key);
  }, { key: occupiedKey });
  const page = await context.newPage();
  page.setDefaultTimeout(35_000);
  let attached = null;
  await page.route("**/api/sessions", (route) => route.fulfill({ json: sessionsPayload }));
  await page.route("**/api/history?**", (route) => route.fulfill({ json: { ok: true, messages: [], source: "test" } }));
  await page.route("**/api/run-state?**", (route) =>
    route.fulfill({ json: { ok: true, session: { key: freeKey, status: "idle" }, tasks: [] } }),
  );
  await page.route("**/api/session-project", async (route) => {
    attached = route.request().postDataJSON();
    const session = sessionsPayload.sessions.find((item) => item.key === attached.sessionKey);
    if (session) session.projectPath = attached.projectPath || "";
    await route.fulfill({ json: { ok: true, sessionKey: attached.sessionKey, projectPath: attached.projectPath || "" } });
  });
  await page.goto(`${baseUrl}?view=files&path=${encodeURIComponent(targetProject)}&tab=changes`, {
    waitUntil: "domcontentloaded",
  });
  await visibleBox(page, "#projectWorkbench", "project chat free session workbench");
  await page.locator("#projectChatButton").click();
  await page.waitForFunction(() => document.querySelector("#viewTitle")?.textContent?.trim() === "Mobile Studio");
  await page.waitForFunction(
    (key) => document.querySelector("#sessionSelect")?.value === key,
    freeKey,
  );
  assert(attached?.sessionKey === freeKey, `project attached to wrong session: ${attached?.sessionKey}`);
  assert(attached?.projectPath === targetProject, `project attach path mismatch: ${attached?.projectPath}`);
  await checkNoHorizontalOverflow(page, "project chat free session");
  await checkChatLayoutNoOverlap(page, "project chat free session");
  await page.screenshot({ path: new URL("mobile-project-chat-free-session.png", artifactsDir).pathname, fullPage: true });
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await context.close();
}

async function checkSettingsSessionManagement(browser) {
  const firstKey = "agent:main:mobile-studio:session:settings-one";
  const secondKey = "agent:main:mobile-studio:session:settings-two";
  const sessionsPayload = {
    ok: true,
    sessions: [
      {
        key: firstKey,
        sessionId: "settings-one",
        agentId: "main",
        kind: "mobile-studio",
        displayName: "Settings One",
        subject: "Settings One",
        status: "idle",
        hasLocalHistory: true,
        projectPath: "projects/Existing",
      },
      {
        key: secondKey,
        sessionId: null,
        agentId: "main",
        kind: "mobile-studio",
        displayName: "Settings Two",
        subject: "Settings Two",
        status: "",
        hasLocalHistory: false,
        projectPath: "",
      },
    ],
  };
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultTimeout(35_000);
  let sessionMutationRequests = 0;
  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() !== "GET") sessionMutationRequests += 1;
    await route.fulfill({ json: sessionsPayload });
  });
  await page.route("**/api/session-project", async (route) => {
    const payload = route.request().postDataJSON();
    const session = sessionsPayload.sessions.find((item) => item.key === payload.sessionKey);
    if (session) session.projectPath = payload.projectPath || "";
    await route.fulfill({ json: { ok: true, sessionKey: payload.sessionKey, projectPath: payload.projectPath || "" } });
  });
  await page.route("**/api/history?**", (route) => route.fulfill({ json: { ok: true, messages: [], source: "test" } }));
  await page.route("**/api/run-state?**", (route) =>
    route.fulfill({ json: { ok: true, session: { key: secondKey, status: "idle" }, tasks: [] } }),
  );

  await page.goto(`${baseUrl}?view=settings`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll(".settings-session-row").length === 2);
  assert((await page.locator(".settings-copy").textContent())?.includes("fixed session pool"), "fixed-pool Settings copy missing");
  assert((await page.locator('[data-session-action="delete"]').count()) === 0, "fixed pool exposed delete controls");
  assert((await page.locator("#createSessionButton").count()) === 0, "fixed pool exposed create controls");
  await page.locator(`[data-session-key="${firstKey}"] [data-session-action="detach"]`).click();
  await page.waitForFunction((key) => document.querySelector(`[data-session-key="${key}"]`)?.textContent?.includes("Free"), firstKey);
  assert(sessionMutationRequests === 0, "Settings attempted to create or delete a fixed-pool session");
  await checkNoHorizontalOverflow(page, "settings session management");
  await page.screenshot({ path: new URL("mobile-settings-session-management.png", artifactsDir).pathname, fullPage: true });
  await page.locator(`[data-session-key="${secondKey}"] [data-session-action="open"]`).click();
  await page.waitForFunction((key) => document.querySelector("#sessionSelect")?.value === key, secondKey);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await context.close();
}

await mkdir(artifactsDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: chromiumPath,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});

try {
  await checkDelayedSettingsSessions(browser);
  await checkCachedSessionFirstPaint(browser);
  await checkMessageFormatting(browser);
  await checkChatMessageOrderAndComposer(browser);
  await checkAttachmentComposer(browser);
  await checkPendingMessagesStayInSession(browser);
  await checkNewCommandHidesOldHistory(browser);
  await checkProjectActionDoubleTap(browser);
  await checkProjectChatUsesFreeSession(browser);
  await checkSettingsSessionManagement(browser);
  for (const scenario of [
    { name: "mobile", viewport: { width: 390, height: 844 } },
    { name: "desktop", viewport: { width: 1024, height: 768 } },
  ]) {
    const context = await browser.newContext({ viewport: scenario.viewport });
    const page = await context.newPage();
    page.setDefaultTimeout(35_000);
    await checkHome(page, scenario.name);
    await checkChat(page, scenario.name);
    await checkFiles(page, scenario.name);
    await checkSettingsTheme(page, scenario.name);
    await checkProjectGitActions(page, scenario.name);
    await checkWorkspaceProjectWorkbench(page, scenario.name);
    await checkProjectCommitGraph(page, scenario.name);
    await context.close();
  }
} finally {
  await browser.close();
}

console.log(`visual smoke ok: ${new URL(".", artifactsDir).pathname}`);
