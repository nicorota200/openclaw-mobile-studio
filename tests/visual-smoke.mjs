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

  const composer = await page.locator("#composer").boundingBox();
  const viewport = page.viewportSize();
  assert(composer && viewport && composer.y + composer.height <= viewport.height + 1, `${name} composer is clipped`);

  await page.screenshot({ path: new URL(`${name}-chat.png`, artifactsDir).pathname, fullPage: true });
}

async function checkFiles(page, name) {
  await page.goto(`${baseUrl}?view=files`, { waitUntil: "domcontentloaded" });
  await visibleBox(page, "#fileBrowserScreen", `${name} files screen`);
  await visibleBox(page, ".files-toolbar", `${name} files toolbar`);
  await checkNoHorizontalOverflow(page, `${name} files`);

  const title = (await page.locator("#viewTitle").textContent())?.trim();
  assert(title === "Files", `${name} expected Files title, got "${title}"`);

  await page.screenshot({ path: new URL(`${name}-files.png`, artifactsDir).pathname, fullPage: true });
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

  const buttons = await page.locator(".project-git-action-button").count();
  assert(buttons === 4, `${name} expected 4 Git action buttons, got ${buttons}`);
  const agentButtons = await page.locator(".project-action-button").count();
  assert(agentButtons === 5, `${name} expected 5 project action buttons, got ${agentButtons}`);

  const title = (await page.locator("#viewTitle").textContent())?.trim();
  assert(title === "Files", `${name} expected Files title in project view, got "${title}"`);

  await page.evaluate(() => {
    document.querySelector("#projectPanel")?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: new URL(`${name}-project-git.png`, artifactsDir).pathname, fullPage: true });
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
  const sendPayloads = [];
  await page.route("**/api/send", async (route) => {
    sendPayloads.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true, idempotencyKey: "project-action-send" } });
  });
  await page.goto(`${baseUrl}?view=files&path=projects/Bluesky-moderation-analysis&tab=changes`, {
    waitUntil: "domcontentloaded",
  });
  await visibleBox(page, ".project-action-launcher", "project action double-tap launcher");
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
  await checkCachedSessionFirstPaint(browser);
  await checkPendingMessagesStayInSession(browser);
  await checkNewCommandHidesOldHistory(browser);
  await checkProjectActionDoubleTap(browser);
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
    await checkProjectGitActions(page, scenario.name);
    await context.close();
  }
} finally {
  await browser.close();
}

console.log(`visual smoke ok: ${new URL(".", artifactsDir).pathname}`);
