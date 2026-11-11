# OpenClaw Mobile Studio

Mobile-first control plane for supervising OpenClaw work from a phone.

The app is a small local Node.js service plus a PWA frontend. It is designed to run on a trusted server, bind to loopback, and be exposed through a private network such as Tailscale Serve.

## What It Does

- Chat through a fixed pool of Mobile Studio sessions.
- Open pool sessions and attach or detach projects from Settings.
- See active run state and stop active runs.
- Browse allowed files read-only.
- Inspect Git projects, branches, commits, changes, and diffs.
- Run guarded Git actions: pull, stage all, unstage, commit, and push.
- Launch project-aware agent prompts such as review, explain diff, check, commit plan, and continue.
- Attach Git projects to available chat sessions without stealing the currently selected chat.
- Show a mobile Home/Inbox with active runs, changed projects, and recent audit activity.
- Keep an append-only local audit log for Mobile Studio actions without storing raw prompt text.

## What It Does Not Do

- It is not a VS Code clone.
- It does not expose an arbitrary terminal.
- It does not run agent tools directly from the browser.
- It should not be exposed publicly without a separate security review.

## Requirements

- Node.js 22.19 or newer.
- An installed and configured `openclaw` CLI/Gateway on the same machine.
- Git installed on the server.
- Optional for visual tests: Chromium at `/snap/bin/chromium` or set `CHROMIUM_PATH`.

## Install

```bash
npm install
```

## Run

```bash
npm run dev
```

Default URL:

```text
http://127.0.0.1:8787
```

Production-style start:

```bash
npm start
```

## Configuration

Environment variables:

```text
HOST=127.0.0.1
PORT=8787
MOBILE_STUDIO_TOKEN=
MOBILE_STUDIO_FILE_ROOT=/home/your-user
OPENCLAW_BIN=/path/to/openclaw
MOBILE_STUDIO_SESSION_POOL_SIZE=5
MOBILE_STUDIO_UPLOAD_DIR=./data/chat-uploads
MOBILE_STUDIO_MAX_UPLOAD_BYTES=1073741824
MOBILE_STUDIO_MAX_TOTAL_UPLOAD_BYTES=2147483648
MOBILE_STUDIO_MAX_CONCURRENT_UPLOADS=2
MOBILE_STUDIO_UPLOAD_TTL_MS=604800000
MOBILE_STUDIO_MAX_ATTACHMENTS_PER_MESSAGE=5
```

`MOBILE_STUDIO_TOKEN` is optional. If set, API requests must use:

```text
Authorization: Bearer <token>
```

The service is intended to bind to loopback and sit behind a trusted private reverse proxy or VPN route.

## Sessions And Project Chats

Mobile Studio provisions its fixed pool on the first session-list request. `MOBILE_STUDIO_SESSION_POOL_SIZE` defaults to 5 and must be an integer from 1 through 20. Pool keys and names are stored in the app-owned `data/session-state.json` and remain stable across restart. Empty slots appear immediately, even before the Gateway has a corresponding session. The first explicit user message lazily materializes that exact key through the supported Gateway `chat.send` path with `deliver:false`.

Settings intentionally has no create or delete controls in v0.1. `Open` selects a pool slot and `Detach` clears its project binding without changing Gateway history. POST and DELETE `/api/sessions` return `405 SESSION_POOL_FIXED`.

Mobile Studio does not write, replace, delete, or move the Gateway-owned session index or transcripts. Session metadata is read through `sessions.list`; a Gateway row is merged only when its key exactly matches an app-owned pool key. Existing Gateway sessions and history are otherwise left untouched.

Project `Chat` does not create sessions and does not use the currently selected session by accident. It follows this order:

1. Open the session already attached to that project.
2. Otherwise attach the project to the first session with no project binding.
3. If every session is occupied, show an alert and leave the current view unchanged.

Project bindings are stored server-side in `data/session-state.json`. On migration from the v1 state shape, bound Mobile Studio keys seed the new registry before empty deterministic slots are added. Unbound legacy Gateway sessions are not adopted or deleted. If the configured size is reduced, excess registry entries and bindings stay preserved in app state but are hidden; increasing it makes preserved entries active again. The browser cache is only a startup accelerator.

Existing session state is fail-closed. A missing file is initialized normally, but invalid JSON, an invalid state shape, or an unreadable existing file returns `SESSION_STATE_CORRUPT` or `SESSION_STATE_UNREADABLE` and is never replaced. Before upgrades or manual state maintenance, stop this service and copy `data/session-state.json` to protected storage. To recover, preserve the rejected file for diagnosis, then restore a known-good copy with the service account as owner and restrictive permissions. If no backup exists, an operator may deliberately move the preserved bad file aside while the service is stopped; the next request creates a new pool registry, and prior project bindings must then be reattached. Gateway transcripts are separate and are not part of this file.

## Chat Attachments

The composer can upload files before sending a message. Uploads are streamed to `MOBILE_STUDIO_UPLOAD_DIR`, defaulting to `data/chat-uploads/`, and the message sent to OpenClaw includes filesystem-readable paths plus metadata. Defaults are 1 GB per file, 2 GB across completed and in-progress payloads, 2 concurrent upload requests, 5 attachments per message, and a 7-day TTL. `MOBILE_STUDIO_MAX_TOTAL_UPLOAD_BYTES` and `MOBILE_STUDIO_MAX_CONCURRENT_UPLOADS` control the aggregate and concurrency budgets. Both byte maxima are inclusive.

Expired manifests are rejected during send and removed. Before accepting a new upload, the service removes expired, malformed, partial, and orphaned real directories directly beneath the configured upload root. Manifest payloads must be ordinary files directly inside their own upload directory; cleanup does not follow symlinks or manifest paths outside the root. Capacity and concurrency accounting are race-safe for the supported single server process. Multiple processes must not share one upload root.

Pending attachment queues are separate per session. Switching sessions neither displays nor clears another session's queue, and upload/send completion is attributed to the session where it began. Project actions never carry composer attachments implicitly and do not clear them.

`/api/send` owns audit event semantics. Ordinary sends, including requests claiming `git_action`, `branch_switch`, or another client-selected type, are recorded as `chat_send`. `project_action` is accepted only for a UI-supported action with allowed metadata, no attachments, and a project path that matches the selected session's server-side binding. Server-calculated session, agent, command, length, and attachment fields override client metadata.

## Tailscale Serve Example

Example only; adjust hostnames and paths for your machine:

```bash
tailscale serve --bg --set-path /mobile-studio http://127.0.0.1:8787
```

Then open:

```text
https://your-node.your-tailnet.ts.net/mobile-studio/
```

## Tests

Local quality baseline (no Gateway or browser required):

```bash
npm ci --ignore-scripts
npm run check
npm test
```

`check` runs Node syntax checks on `server.js` and JavaScript files under `lib/`, `public/`, `scripts/`, and `tests/`. It does not execute the application or perform semantic linting. `test` uses Node's built-in runner for pool concurrency/migration and Gateway-file immutability, per-session attachment state, project action prompts, audit metadata/read limits/rotation, and streaming upload regressions. Server tests use disposable copies on OS-assigned loopback ports and never start or mutate the normal service or its session store.

GitHub Actions runs the same install, checks, and non-browser tests on push and pull request with Node 22.19 and 24. Browser tests are deliberately separate.

Visual smoke test against an already running local service:

```bash
npm run visual:smoke
```

With an explicit URL and Chromium:

```bash
MOBILE_STUDIO_URL=http://127.0.0.1:8787/mobile-studio/ \
CHROMIUM_PATH=/path/to/chromium npm run visual:smoke
```

Defaults are `http://127.0.0.1:8787/mobile-studio/` and `/snap/bin/chromium`. The suite includes mocked send/upload/fixed-pool interactions, per-session attachment switching, project-action attachment isolation, and a delayed Settings response regression, but it also reads live sessions, history, attention, audit, files, and Git information. It expects at least one session and the host projects `projects/Bluesky-moderation-analysis`, `projects/openclaw-mobile-studio`, and `projects/COCAttackAnalyzer` (with enough commits to scroll). API latency thresholds also depend on host load. These requirements make the full suite unsuitable for generic CI without fixtures. Settings must render actual session rows; the assertion waits up to 35 seconds for asynchronous loading and still fails if no rows appear.

Run this suite only against a trusted local environment. Mutation interactions are mocked; live project checks inspect Git controls without executing Git writes. Screenshots may contain local information and are written under ignored `test-artifacts/`. Running against another checkout validates that checkout's served frontend, not unserved local server changes; the isolated upload tests cover the stabilization's server fixes.

See [v0.1 stabilization notes](docs/STABILIZATION-v0.1.md) for the local proof and remaining review concerns.

## Security Notes

- Keep the service private by default.
- Keep `MOBILE_STUDIO_FILE_ROOT` narrow.
- File preview blocks common secret/key/database filenames.
- Mobile-originated chat sends use `deliver:false` so they do not automatically post to external channels.
- Project action buttons and risky slash commands require a deliberate second tap/click.
- Git write actions are guarded and do not force-push, rebase, stash, or resolve conflicts.
- Audit logs are local, append-only JSONL, rotate at 1 MB, store metadata only, and use server-selected send event types.

## License

MIT
