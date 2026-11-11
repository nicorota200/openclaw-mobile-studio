# Local v0.1 stabilization — 2026-11-10

The branch `codex/stabilize-v0.1` is prepared for operator review, with the imported work preserved in its own commit. This is a local baseline, not a deployment or a public-exposure security review.

## Provenance and scope

- Isolated worktree: `/home/nicola-rota/projects/.oms-stabilize-v0.1.muzTyF`.
- Before any edit, `pwd`, `git rev-parse --show-toplevel`, `git branch --show-current`, and `git rev-parse HEAD` confirmed the prepared directory, branch, and starting SHA `bff78d46f38760cf9fd8b36867f52c9766e9d973`.
- The supplied preparation receipt reported fetched `origin/main` at `57305e529d732275ef096cdfd53eafd798104a3c`; the clean branch was 0 behind and 2 ahead. No merge, rebase, reset, or history rewrite was performed.
- Imported snapshot commit: `fae9cb1` (`feat: preserve imported Mobile Studio v0.1 baseline`), exactly 10 files, +2287/-117. A separate stabilization commit contains the fixes, tests, workflow, and documentation.
- The primary checkout, live service configuration, Gateway, systemd, Tailscale, and existing runtime data were not modified. No push, PR, or publication was performed. Git-write policy, authentication, SSE, approval handling, and Admin Mode were not redesigned.

## Changes and review findings

1. **Settings smoke race:** the original suite failed with `mobile expected settings session rows`. A fresh browser observed 0 rows at DOMContentLoaded and 7 after asynchronous loading. The assertion now waits up to 35 seconds for an actual visible session row, then retains the nonempty assertion. A fresh-context regression holds the sessions response until after navigation and assertion startup, then requires all 7 fixture rows. No fixed sleep or empty-list exemption was added.
2. **Upload data corruption:** uploading a file named `manifest.json` previously overwrote its bytes with server metadata. New payload filenames have a `file-` prefix; displayed names and existing manifest-based reads remain compatible. The isolated regression failed before the fix and passes after it.
3. **Upload error completion:** a truncated multipart request previously left partial upload data; a request without multipart headers returned 500. Parser and stream failures are now coordinated, partial uploads are cleaned before a response completes, rejected multi-file requests do not generate successful-upload audit events, and disconnected clients release partial files. Tests cover these cases, size rejection, and continued availability. All writes and cleanup during verification were confined to disposable test directories.
4. **Session audit metadata:** imported session create/delete/attach/detach events used types missing from the metadata allowlist, silently discarding their identifying metadata. The allowlist now retains session keys and binding paths while excluding raw session contents.
5. **Quality baseline:** syntax checking covers all existing JavaScript entry points and test scripts. Node tests cover project prompt context and safety instructions, audit filtering/limits/rotation/errors, and the upload regressions. GitHub Actions runs install/check/test on push and PR with Node 22.19.0 and 24, with read-only repository permissions and no browser or Gateway requirement.
6. **Fixed app-owned pool:** first GET/list completes an app registry in `data/session-state.json` under a process-local serialized critical section and replaces it atomically. The configurable size defaults to 5 and accepts only 1–20. Deterministic empty slots are stable across restart; v1 bound Mobile Studio keys seed migration. Concurrent first requests return one identical pool. Only exact-key Gateway rows from `sessions.list` are overlaid, and first explicit messages materialize through `chat.send` with `deliver:false`.
7. **Gateway ownership boundary:** direct `sessions.json` writes and transcript moves were removed from session routes. POST/DELETE `/api/sessions` return `405 SESSION_POOL_FIXED`; Settings exposes only Open and Detach. Disposable tests preserve the inode and content of sentinel Gateway index/transcript files and prove no tombstone directory is created.
8. **OpenClaw compatibility evidence:** installed OpenClaw 2026.9.4 docs identify `sessions.list`, `sessions.create/reset/delete`, and `chat.send`. Its local `chat.send` implementation (`loadChatSendSessionContext` / `prepareChatSendSession`) loads an exact requested key, explicitly authorizes Gateway session creation when no row exists, and admits the missing session through Gateway-owned persistence. Mobile Studio does not invoke the destructive maintenance methods or edit their backing files.
9. **Attachment attribution:** pending UI state is keyed by originating session, including uploading/ready/failed items. Completion and successful-send cleanup use the captured session and item IDs. Project actions opt out of composer attachments and leave queues and drafts intact. Pure unit tests and mocked browser flows cover switching and project-action isolation.
10. **Upload lifecycle:** request abort/error listeners are registered before awaited setup and already-aborted requests fail immediately. Parser/file/output teardown is single-shot for abort, malformed multipart, oversized data, and second files. Busboy is capped at max+1, so max-1 and max succeed while max+1 fails without unbounded buffering. Slow-stream tests prove rejection before a multipart tail arrives.
11. **State recovery:** only `ENOENT` initializes empty app state. Invalid JSON, invalid registry structure, and other read errors now fail closed with actionable `SESSION_STATE_CORRUPT` or `SESSION_STATE_UNREADABLE` responses. The existing file is preserved and atomic temp-file/rename writes remain in place. The README documents stopped-service backup, restore, and deliberate no-backup recovery.
12. **Audit semantics:** `/api/send` selects `chat_send` regardless of arbitrary client type claims. The only exception is a validated UI `project_action`: its action must be in the shared UI action registry, its metadata keys must be allowed, it cannot carry attachments, and its path must match the session's server-side project binding. Calculated audit fields still override client values.
13. **Upload retention and budgets:** reads reject expired manifests, and upload maintenance removes expired, malformed, partial, and orphaned direct-child directories without following symlinks or outside-root manifest paths. Payload bytes are reserved while streaming, with a 2 GiB aggregate default and two-request concurrency default; reservations and slots are released on every success, rejection, and abort path.
14. **Run-state ordering:** task rows are normalized and filtered to the selected session before newest-first sorting and the eight-item response cap, so unrelated newer tasks cannot displace selected-session work.

The imported frontend formatting uses text nodes/textContent for message content and limits generated links to HTTP(S). The new API routes remain behind the existing authorization gate, and chat sends retain `deliver: false`. Review found no reason to change these policies in this phase.

## Commands and results

Local tooling: Node `v24.18.0`, npm `11.16.0`; compatibility tests also used Node `v22.19.0`.

| Command | Result |
| --- | --- |
| `npm ci --ignore-scripts` | Passed; 4 packages installed, npm reported 0 vulnerabilities. |
| `npm run visual:smoke` before stabilization | Failed at the original Settings row assertion, as expected. |
| `node --test tests/uploads.test.mjs` before upload fixes | 1 passed, 2 failed: manifest collision and truncated-upload cleanup. |
| `node --test --test-name-pattern='truncated multipart' tests/uploads.test.mjs` during diagnosis | Confirmed missing multipart headers returned 500 instead of 400. |
| `npm run check && npm test` after pool/upload remediation | Passed: 12 JavaScript files checked, 25 tests passed, 0 failed/skipped. |
| `MOBILE_STUDIO_URL=http://127.0.0.1:<ephemeral>/mobile-studio/ CHROMIUM_PATH=/snap/bin/chromium npm run visual:smoke` | Passed against a disposable copy of this branch without restarting the live service: delayed Settings, fixed-pool controls, per-session attachments, project-action isolation, and all mobile/desktop trusted-host read checks. |
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

Before the final browser run, a read-only SHA-256 comparison showed that the unchanged live service served older `index.html`, `app.js`, and `styles.css` assets (while `project-actions.js` still matched); requesting the new `attachment-state.js` returned the older SPA fallback. The final suite therefore used an ephemeral port and a disposable `/tmp` copy of this branch. Its app state and uploads stayed in that copy, its mutation interactions were mocked, and only the established trusted-host read checks used the local Gateway/files. Both temporary copies were deleted after the run. The live service was not restarted or changed.

## Remaining risks and proof limits

- **Live host dependency:** browser checks require an accessible Gateway plus three named host projects, sufficient commit history, and API response-time thresholds. The README lists these requirements. The unchanged live service served older frontend assets, so this branch's full suite ran through a disposable server copy. Backend mutations were proven only in isolated tests.
- **Pool process boundary:** app-state serialization is process-local. v0.1 is designed for one Mobile Studio server process; multiple server processes sharing the same `data/session-state.json` would need an inter-process lock. Reducing the configured size hides excess entries rather than deleting registry data or bindings.
- **Audit concurrency:** rotation is a size-check/rename/append sequence with one archive; the tests establish sequential behavior, not safety across simultaneous writers or processes. Quiet writes intentionally hide storage errors. Retention and concurrency need separate operational review.
- **Single-process coordination:** session-state serialization, upload concurrency slots, and aggregate upload byte reservations are process-local. Multiple Mobile Studio processes must not share the same state file or upload root without an inter-process lock. The aggregate budget counts managed payload bytes, not filesystem metadata or unrelated files placed manually in the upload root.
- **Filesystem fault limits:** tests cover malformed/orphaned entries, poisoned outside-root manifest paths, symlink non-traversal, aborts, expiry, and quota races, but do not simulate disk exhaustion or hostile concurrent filesystem replacement by another local process.
- **Coverage:** no real chat send, Git write, session creation/deletion, or attachment upload was exercised against live runtime data. Mutating visual interactions are mocked. The workflow was authored but not run on GitHub because no remote publication was authorized.

## File inventory

Imported baseline: `.env.example`, `README.md`, `lib/audit.js`, `package-lock.json`, `package.json`, `public/app.js`, `public/index.html`, `public/styles.css`, `server.js`, `tests/visual-smoke.mjs`.

Stabilization edits: `README.md`, `lib/audit.js`, `package.json`, `server.js`, `tests/visual-smoke.mjs`.

New files now also include `public/attachment-state.js`, `tests/attachment-state.test.mjs`, and `tests/session-pool.test.mjs`.
