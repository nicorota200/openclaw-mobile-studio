# Local v0.1 stabilization — 2026-11-10

The branch `codex/stabilize-v0.1` is prepared for operator review, with the imported work preserved in its own commit. This is a local baseline, not a deployment or a public-exposure security review.

## Provenance and scope

- Isolated worktree: `/home/nicola-rota/projects/.oms-stabilize-v0.1.muzTyF`.
- Before any edit, `pwd`, `git rev-parse --show-toplevel`, `git branch --show-current`, and `git rev-parse HEAD` confirmed the prepared directory, branch, and starting SHA `57305e529d732275ef096cdfd53eafd798104a3c`.
- `git rev-parse origin/main` matched that SHA, the fetched target-base SHA in the preparation receipt. `git merge-base --is-ancestor origin/main HEAD` passed. This describes the local remote-tracking ref from the supplied fetch receipt, not a new remote freshness check.
- Imported snapshot commit: `fae9cb1` (`feat: preserve imported Mobile Studio v0.1 baseline`), exactly 10 files, +2287/-117. A separate stabilization commit contains the fixes, tests, workflow, and documentation.
- The primary checkout, live service configuration, Gateway, systemd, Tailscale, and existing runtime data were not modified. No push, PR, or publication was performed. Git-write policy, authentication, SSE, approval handling, and Admin Mode were not redesigned.

## Changes and review findings

1. **Settings smoke race:** the original suite failed with `mobile expected settings session rows`. A fresh browser observed 0 rows at DOMContentLoaded and 7 after asynchronous loading. The assertion now waits up to 35 seconds for an actual visible session row, then retains the nonempty assertion. A fresh-context regression holds the sessions response until after navigation and assertion startup, then requires all 7 fixture rows. No fixed sleep or empty-list exemption was added.
2. **Upload data corruption:** uploading a file named `manifest.json` previously overwrote its bytes with server metadata. New payload filenames have a `file-` prefix; displayed names and existing manifest-based reads remain compatible. The isolated regression failed before the fix and passes after it.
3. **Upload error completion:** a truncated multipart request previously left partial upload data; a request without multipart headers returned 500. Parser and stream failures are now coordinated, partial uploads are cleaned before a response completes, rejected multi-file requests do not generate successful-upload audit events, and disconnected clients release partial files. Tests cover these cases, size rejection, and continued availability. All writes and cleanup during verification were confined to disposable test directories.
4. **Session audit metadata:** imported session create/delete/attach/detach events used types missing from the metadata allowlist, silently discarding their identifying metadata. The allowlist now retains session keys and binding paths while excluding raw session contents.
5. **Quality baseline:** syntax checking covers all existing JavaScript entry points and test scripts. Node tests cover project prompt context and safety instructions, audit filtering/limits/rotation/errors, and the upload regressions. GitHub Actions runs install/check/test on push and PR with Node 22.19.0 and 24, with read-only repository permissions and no browser or Gateway requirement.

The imported frontend formatting uses text nodes/textContent for message content and limits generated links to HTTP(S). The new API routes remain behind the existing authorization gate, and chat sends retain `deliver: false`. Review found no reason to change these policies in this phase.

## Commands and results

Local tooling: Node `v24.18.0`, npm `11.16.0`; compatibility tests also used Node `v22.19.0`.

| Command | Result |
| --- | --- |
| `npm ci --ignore-scripts` | Passed; 4 packages installed, npm reported 0 vulnerabilities. |
| `npm run visual:smoke` before stabilization | Failed at the original Settings row assertion, as expected. |
| `node --test tests/uploads.test.mjs` before upload fixes | 1 passed, 2 failed: manifest collision and truncated-upload cleanup. |
| `node --test --test-name-pattern='truncated multipart' tests/uploads.test.mjs` during diagnosis | Confirmed missing multipart headers returned 500 instead of 400. |
| `npm run check && npm test` after stabilization | Passed: 9 JavaScript files checked, 16 tests passed, 0 failed/skipped. |
| `npx --yes --package=node@22.19.0 -- node --version` | `v22.19.0`. |
| `npx --yes --package=node@22.19.0 -- node scripts/check.mjs && npx --yes --package=node@22.19.0 -- node --test tests/*.test.mjs` | Passed: 9 files checked, 16 tests passed, 0 failed/skipped on the minimum supported Node version. |
| `MOBILE_STUDIO_URL=http://127.0.0.1:8787/mobile-studio/ CHROMIUM_PATH=/snap/bin/chromium npm run visual:smoke` | Passed the full suite: delayed Settings, all existing mocked interaction cases, mobile and desktop live checks. 19 screenshots under ignored `test-artifacts/`. |
| `git diff --check` | Passed. |
| `git merge-base --is-ancestor origin/main HEAD` | Passed against the prepared remote-tracking main. |

The exact read-only browser reproduction was:

```bash
node --input-type=module <<'JS'
import { chromium } from 'playwright';
const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/snap/bin/chromium', headless:true, args:['--no-sandbox','--disable-gpu']});
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8787/mobile-studio/?view=settings', {waitUntil:'domcontentloaded'});
  console.log('Settings rows at DOMContentLoaded:', await page.locator('.settings-session-row').count());
  await page.locator('.settings-session-row').first().waitFor({state:'visible', timeout:35000});
  console.log('Settings rows after async loading:', await page.locator('.settings-session-row').count());
} finally { await browser.close(); }
JS
```

It printed `0`, then `7`. The new delayed-response regression printed `Settings race regression passed: 0 rows before response, 7 after response` in the successful full suite.

To establish what the live browser run covered, the following read-only comparison passed for all four frontend assets:

```bash
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
for (const file of ['index.html', 'app.js', 'styles.css', 'project-actions.js']) {
  const response = await fetch(`http://127.0.0.1:8787/mobile-studio/${file}`);
  assert.equal(response.status, 200);
  assert.ok(Buffer.from(await response.arrayBuffer()).equals(await readFile(`public/${file}`)), `${file} differs from live asset`);
  console.log(`Live asset matches worktree: public/${file}`);
}
JS
```

## Remaining risks and proof limits

- **Live host dependency:** browser checks require the existing service, accessible session/history APIs, at least one session, three named host projects, sufficient commit history, and API response-time thresholds. The README lists these requirements. The served frontend matched this worktree, but the live backend was deliberately not updated. The new backend behavior was proven only in isolated server tests.
- **Session-store coordination:** session creation/deletion writes the Gateway-owned `sessions.json` using read/modify/rename without cross-process coordination. Simultaneous Gateway or Mobile Studio writers can lose updates. Deletion moves multiple files before updating the index and binding state, without transactional rollback. A separate design/compatibility review is needed before relying on concurrent session administration.
- **Audit concurrency:** rotation is a size-check/rename/append sequence with one archive; the tests establish sequential behavior, not safety across simultaneous writers or processes. Quiet writes intentionally hide storage errors. Retention and concurrency need separate operational review.
- **Upload lifecycle and capacity:** cleanup is opportunistic on later uploads; reads do not independently reject expired manifests. No total disk quota or concurrent-upload budget exists. These resource policies remain unchanged. Tests do not simulate disk exhaustion or malicious filesystem changes.
- **Composer attachment state:** pending attachments are shared by the current composer, not partitioned by session. Session switching, pending uploads, and project-action sends merit a focused follow-up UX/correctness review.
- **Coverage:** no real chat send, Git write, session creation/deletion, or attachment upload was exercised against live runtime data. Mutating visual interactions are mocked. The workflow was authored but not run on GitHub because no remote publication was authorized.

## File inventory

Imported baseline: `.env.example`, `README.md`, `lib/audit.js`, `package-lock.json`, `package.json`, `public/app.js`, `public/index.html`, `public/styles.css`, `server.js`, `tests/visual-smoke.mjs`.

Stabilization edits: `README.md`, `lib/audit.js`, `package.json`, `server.js`, `tests/visual-smoke.mjs`.

New files: `.github/workflows/ci.yml`, `scripts/check.mjs`, `tests/audit.test.mjs`, `tests/project-actions.test.mjs`, `tests/uploads.test.mjs`, `docs/STABILIZATION-v0.1.md`.
