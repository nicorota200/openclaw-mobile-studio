import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { chromium } from "playwright";

const publicDir = resolve(new URL("../public/", import.meta.url).pathname);
const chromiumPath = process.env.CHROMIUM_PATH || "/snap/bin/chromium";
let gitMode = "read";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function json(res, body) {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const project = {
  ok: true,
  isRepo: true,
  path: "projects/demo",
  repositoryPath: "projects/demo",
  repositoryName: "demo",
  branch: "main",
  tracking: "origin/main",
  ahead: 1,
  behind: 0,
  statusLines: ["## main...origin/main [ahead 1]"],
  statusEntries: [],
  diffEntries: [],
  commits: [],
  remotes: ["origin fixture"],
  branches: { local: ["main", "feature"], remote: ["origin/main", "origin/feature"] },
  clean: true,
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://fixture");
  if (url.pathname === "/api/config") return json(res, { ok: true, gitMode });
  if (url.pathname === "/api/files") {
    return json(res, { ok: true, root: "/fixture", path: "projects/demo", showHidden: false, entries: [] });
  }
  if (url.pathname === "/api/project") return json(res, project);
  if (url.pathname.startsWith("/api/")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"ok":false}');
    return;
  }

  const relativePath = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
  const filePath = resolve(publicDir, relativePath);
  if (filePath !== publicDir && !filePath.startsWith(`${publicDir}/`)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(filePath);
    const type = {
      ".css": "text/css; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".webmanifest": "application/manifest+json; charset=utf-8",
    }[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}/?view=files&path=projects%2Fdemo&tab=changes`;
const browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ["--no-sandbox", "--disable-gpu"] });

try {
  for (const mode of ["read", "write"]) {
    gitMode = mode;
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator("#projectWorkbench").waitFor({ state: "visible" });
    await page.waitForFunction((expected) => document.querySelector("#gitModeBadge")?.textContent?.includes(expected), mode === "write" ? "writes enabled" : "read only");

    const badge = (await page.locator("#gitModeBadge").textContent())?.trim();
    const writeButtons = await page.locator(".project-git-action-button").count();
    const commitForms = await page.locator(".project-commit-form").count();
    const branchDisabled = await page.locator("#branchSelect").isDisabled();
    if (mode === "read") {
      assert(badge === "Git read only", `unexpected read badge: ${badge}`);
      assert(writeButtons === 0, "read mode rendered Git write buttons");
      assert(commitForms === 0, "read mode rendered the commit form");
      assert(branchDisabled, "read mode left branch switching enabled");
      assert((await page.locator(".project-git-actions.read-only").count()) === 1, "read-only explanation missing");
    } else {
      assert(badge === "Git writes enabled", `unexpected write badge: ${badge}`);
      assert(writeButtons === 4, `write mode rendered ${writeButtons} Git buttons`);
      assert(commitForms === 1, "write mode did not render the commit form");
      assert(!branchDisabled, "write mode did not enable clean-worktree branch switching");
    }
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise((resolveClose, rejectClose) => server.close((error) => (error ? rejectClose(error) : resolveClose())));
}

console.log("git mode browser fixture ok: read and write UI states");
