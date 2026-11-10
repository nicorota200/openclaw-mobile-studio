# OpenClaw Mobile Studio

Mobile-first control plane for supervising OpenClaw work from a phone.

The app is a small local Node.js service plus a PWA frontend. It is designed to run on a trusted server, bind to loopback, and be exposed through a private network such as Tailscale Serve.

## What It Does

- Chat with existing OpenClaw sessions.
- Manage Mobile Studio chat sessions from Settings.
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
OPENCLAW_SESSIONS_DIR=/path/to/.openclaw/agents/main/sessions
MOBILE_STUDIO_UPLOAD_DIR=./data/chat-uploads
MOBILE_STUDIO_MAX_UPLOAD_BYTES=1073741824
MOBILE_STUDIO_UPLOAD_TTL_MS=604800000
MOBILE_STUDIO_MAX_ATTACHMENTS_PER_MESSAGE=5
```

`MOBILE_STUDIO_TOKEN` is optional. If set, API requests must use:

```text
Authorization: Bearer <token>
```

The service is intended to bind to loopback and sit behind a trusted private reverse proxy or VPN route.

## Sessions And Project Chats

Mobile Studio treats sessions as a finite pool. The Settings view is the management surface:

- `New session` creates a local Mobile Studio session and adds it to the pool.
- `Detach` clears the project binding from a session without deleting its history.
- `Delete` removes the session from the active pool. Session files are moved to `data/deleted-sessions/` so the app no longer uses them, while manual recovery remains possible.

Project `Chat` does not create sessions and does not use the currently selected session by accident. It follows this order:

1. Open the session already attached to that project.
2. Otherwise attach the project to the first session with no project binding.
3. If every session is occupied, show an alert and leave the current view unchanged.

Project bindings are stored server-side in `data/session-state.json`. The browser cache is only a startup accelerator.

## Chat Attachments

The composer can upload files before sending a message. Uploads are streamed to `MOBILE_STUDIO_UPLOAD_DIR`, defaulting to `data/chat-uploads/`, and the message sent to OpenClaw includes filesystem-readable paths plus metadata. Defaults are 1 GB per file, 5 attachments per message, and 7 days before cleanup.

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

`check` runs Node syntax checks on `server.js` and JavaScript files under `lib/`, `public/`, `scripts/`, and `tests/`. It does not execute the application or perform semantic linting. `test` uses Node's built-in runner for project action prompts, audit metadata/read limits/rotation, and upload regressions. Upload tests start disposable copies of the server on OS-assigned loopback ports with temporary data and an unavailable Gateway executable. They never start the normal service or use its session store.

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

Defaults are `http://127.0.0.1:8787/mobile-studio/` and `/snap/bin/chromium`. The suite includes mocked send/upload/session-management interactions and a delayed Settings response regression, but it also reads live sessions, history, attention, audit, files, and Git information. It expects at least one session and the host projects `projects/Bluesky-moderation-analysis`, `projects/openclaw-mobile-studio`, and `projects/COCAttackAnalyzer` (with enough commits to scroll). API latency thresholds also depend on host load. These requirements make the full suite unsuitable for generic CI without fixtures. Settings must render actual session rows; the assertion waits up to 35 seconds for asynchronous loading and still fails if no rows appear.

Run this suite only against a trusted local environment. Mutation interactions are mocked; live project checks inspect Git controls without executing Git writes. Screenshots may contain local information and are written under ignored `test-artifacts/`. Running against another checkout validates that checkout's served frontend, not unserved local server changes; the isolated upload tests cover the stabilization's server fixes.

See [v0.1 stabilization notes](docs/STABILIZATION-v0.1.md) for the local proof and remaining review concerns.

## Security Notes

- Keep the service private by default.
- Keep `MOBILE_STUDIO_FILE_ROOT` narrow.
- File preview blocks common secret/key/database filenames.
- Mobile-originated chat sends use `deliver:false` so they do not automatically post to external channels.
- Project action buttons and risky slash commands require a deliberate second tap/click.
- Git write actions are guarded and do not force-push, rebase, stash, or resolve conflicts.
- Audit logs are local, append-only JSONL, rotate at 1 MB, and store metadata only.

## License

MIT
