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

Syntax checks:

```bash
node --check server.js
node --check lib/audit.js
node --check public/app.js
node --check public/project-actions.js
node --check tests/visual-smoke.mjs
```

Visual smoke test:

```bash
npm run visual:smoke
```

With a custom Chromium:

```bash
CHROMIUM_PATH=/path/to/chromium npm run visual:smoke
```

Screenshots are written under `test-artifacts/`.

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
