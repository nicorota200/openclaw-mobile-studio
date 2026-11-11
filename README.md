# OpenClaw Mobile Studio

Mobile-first control plane for supervising OpenClaw work from a phone.

The app is a small local Node.js service plus a PWA frontend. It is designed to run on a trusted server, bind to loopback, and be exposed through a private network such as Tailscale Serve.

## What It Does

- Chat through a fixed pool of Mobile Studio sessions.
- Open pool sessions and attach or detach projects from Settings.
- See active run state and stop active runs.
- Browse allowed files read-only.
- Inspect Git status, history, branches, changes, and diffs in the default read-only mode.
- Optionally enable guarded Git writes: branch switch, pull, stage all, unstage, commit, and push.
- Launch project-aware agent prompts such as review, explain diff, check, commit plan, and continue.
- Attach Git projects to available chat sessions without stealing the currently selected chat.
- Show a mobile Home/Inbox with active runs, changed projects, and recent audit activity.
- Keep an append-only local audit log for Mobile Studio actions without storing raw prompt text.

## What It Does Not Do

- It is not a VS Code clone.
- It does not expose an arbitrary terminal.
- It does not run agent tools directly from the browser.
- It should not be exposed publicly without a separate security review.
- It does not provide multi-user identity or authorization.

## Requirements

- Linux with a user systemd manager.
- Node.js 22.19 through 24.x.
- OpenClaw 2026.9.4 through 2026.9.x, with CLI and Gateway on the same machine.
- Git 2.39 or newer.
- Tailscale 1.70 or newer, connected to a private tailnet.
- Optional for visual tests: Chromium at `/snap/bin/chromium` or set `CHROMIUM_PATH`.

These are the deliberately narrow first-product ranges. Run `npm run doctor` rather than assuming a later OpenClaw Gateway is compatible.

## Quick development install

```bash
npm install
```

## Run

```bash
MOBILE_STUDIO_FILE_ROOT=/home/your-user npm run dev
```

Default URL:

```text
http://127.0.0.1:8787
```

Production-style start:

```bash
npm start
```

For the supported user-systemd installation, Tailscale Serve setup, backup, upgrade, rollback, and uninstall procedures, follow [the operations guide](docs/OPERATIONS.md).

## Configuration

Environment variables:

```text
HOST=127.0.0.1
PORT=8787
MOBILE_STUDIO_TOKEN=
MOBILE_STUDIO_GIT_MODE=read
MOBILE_STUDIO_FILE_ROOT=/home/your-user
MOBILE_STUDIO_AGENT_ID=main
MOBILE_STUDIO_PROJECT_ROOTS=projects,.openclaw/workspace/projects
MOBILE_STUDIO_WORKSPACE_PATH=.openclaw/workspace
MOBILE_STUDIO_BASE_PATH=/mobile-studio
OPENCLAW_BIN=/absolute/path/from-command-v-openclaw
MOBILE_STUDIO_SESSION_POOL_SIZE=5
MOBILE_STUDIO_UPLOAD_DIR=./data/chat-uploads
MOBILE_STUDIO_MAX_UPLOAD_BYTES=1073741824
MOBILE_STUDIO_MAX_TOTAL_UPLOAD_BYTES=2147483648
MOBILE_STUDIO_MAX_CONCURRENT_UPLOADS=2
MOBILE_STUDIO_UPLOAD_TTL_MS=604800000
MOBILE_STUDIO_MAX_ATTACHMENTS_PER_MESSAGE=5
```

`MOBILE_STUDIO_FILE_ROOT` is required and must name an existing readable directory. It is the filesystem boundary for browsing, project discovery, and Git operations. The server fails at startup instead of silently falling back to a maintainer-specific or broad home directory.

`OPENCLAW_BIN` is optional when `openclaw` is executable through the process `PATH`. When set, it may be an executable path or command name. Startup fails with an actionable error when the CLI cannot be found or executed.

`MOBILE_STUDIO_AGENT_ID` defaults to `main` and selects the OpenClaw agent namespace used by the fixed Mobile Studio session pool. Changing it creates or reuses a separate pool for that agent; saved entries for other agents remain preserved but inactive.

`MOBILE_STUDIO_PROJECT_ROOTS` is a comma-separated list of directories relative to `MOBILE_STUDIO_FILE_ROOT`. Mobile Studio scans their immediate child directories for Git repositories. `MOBILE_STUDIO_WORKSPACE_PATH` controls the optional Workspace shortcut and may be set to an empty string to hide it. All configured paths must remain inside the file root.

`MOBILE_STUDIO_BASE_PATH` defaults to `/mobile-studio`, accepts an absolute URL path, and controls the private proxy route. Root access remains available locally. PWA scope and client API URLs follow the path where the frontend is served.

Trusted-tailnet mode accepts only loopback `HOST` values (`127.0.0.1`, `::1`, or `localhost`). Public or wildcard binds fail startup; use Tailscale Serve as the private network edge.

## Doctor

Run the non-interactive preflight with the same environment file used by systemd:

```bash
npm run doctor -- --env-file "$HOME/.config/openclaw-mobile-studio/env"
```

Use `npm run --silent doctor -- --env-file PATH --json` for machine-readable results without npm's command banner. Doctor checks supported versions, safe configuration, data permissions, read-only Gateway probes, Tailscale connectivity/Serve state, and the user systemd manager. It never prints the configured Mobile Studio token.

`MOBILE_STUDIO_TOKEN` must remain empty for the supported PWA deployment. The server retains bearer-token handling only for API compatibility, but the standard browser client does not collect, store, or submit bearer credentials. `npm run doctor` therefore fails when the variable is set.

The service binds to loopback and relies on the private trusted-tailnet route as its supported access boundary. A future application-login design is required before shared-tailnet or public access.

`MOBILE_STUDIO_GIT_MODE` accepts exactly `read` or `write` and defaults to `read` when unset. In `read` mode, Git inspection remains available while the server rejects every direct Git mutation route with `403 GIT_WRITES_DISABLED`. Set it to `write` and restart the service to expose the existing guarded branch switch, pull, stage, unstage, commit, and push actions. This is a server configuration, not an in-app toggle.

## Trusted-tailnet Security Model

The initial supported access boundary is a **single-user private Tailscale tailnet**:

- Keep the backend bound to loopback (`HOST=127.0.0.1`).
- Expose it only with Tailscale Serve and tailnet policy restricted to the owner.
- Do not enable Tailscale Funnel or otherwise publish the route to the internet.
- Treat every principal able to reach the Mobile Studio route as the authorized owner of all enabled capabilities.

There is no application-level user identity or login in this phase. Server bearer-token handling is not a substitute for a correctly restricted tailnet and is not supported by the standard PWA. Shared tailnets, multiple users, and public exposure are outside the supported product contract.

## Sessions And Project Chats

Mobile Studio provisions its fixed pool on the first session-list request. `MOBILE_STUDIO_SESSION_POOL_SIZE` defaults to 5 and must be an integer from 1 through 20. Pool keys and names are stored in the app-owned `data/session-state.json` and remain stable across restart. Empty slots appear immediately, even before the Gateway has a corresponding session. The first explicit user message lazily materializes that exact key through the supported Gateway `chat.send` path with `deliver:false`.

Settings intentionally has no create or delete controls in this release. `Open` selects a pool slot and `Detach` clears its project binding without changing Gateway history. POST and DELETE `/api/sessions` return `405 SESSION_POOL_FIXED`.

Mobile Studio does not write, replace, delete, or move the Gateway-owned session index or transcripts. Session metadata is read through `sessions.list`; a Gateway row is merged only when its key exactly matches an app-owned pool key. Existing Gateway sessions and history are otherwise left untouched.

Project `Chat` does not create sessions and does not use the currently selected session by accident. It follows this order:

1. Open the session already attached to that project.
2. Otherwise attach the project to the first session with no project binding.
3. If every session is occupied, show an alert and leave the current view unchanged.

Project bindings are stored server-side in `data/session-state.json`. On migration from the v1 state shape, bound Mobile Studio keys seed the new registry before empty deterministic slots are added. Unbound legacy Gateway sessions are not adopted or deleted. If the configured size is reduced, excess registry entries and bindings stay preserved in app state but are hidden; increasing it makes preserved entries active again. The browser cache is only a startup accelerator.

Existing session state is fail-closed. A missing file is initialized normally, but every existing file must match the explicit v1 (`version`, `projectBindings`) or v2 (`version`, `poolEntries`, `projectBindings`) schema. Missing or unknown versions, missing registry fields, invalid JSON, invalid shapes, and unreadable files return `SESSION_STATE_CORRUPT` or `SESSION_STATE_UNREADABLE` and are never replaced. Valid v1 state migrates to v2. Before upgrades or manual state maintenance, stop this service and copy `data/session-state.json` to protected storage. To recover, preserve the rejected file for diagnosis, then restore a known-good copy with the service account as owner and restrictive permissions. If no backup exists, an operator may deliberately move the preserved bad file aside while the service is stopped; the next request creates a new pool registry, and prior project bindings must then be reattached. Gateway transcripts are separate and are not part of this file.

## Chat Attachments

The composer can upload files before sending a message. Uploads are streamed to `MOBILE_STUDIO_UPLOAD_DIR`, defaulting to `data/chat-uploads/`, and the message sent to OpenClaw includes filesystem-readable paths plus metadata. Defaults are 1 GB per file, 2 GB across completed and in-progress payloads, 2 concurrent upload requests, 5 attachments per message, and a 7-day TTL. `MOBILE_STUDIO_MAX_TOTAL_UPLOAD_BYTES` and `MOBILE_STUDIO_MAX_CONCURRENT_UPLOADS` control the aggregate and concurrency budgets. Both byte maxima are inclusive.

Expired manifests are rejected during send and removed. Before accepting a new upload, the service removes expired, malformed, partial, and orphaned real directories directly beneath the configured upload root. Manifest payloads must be ordinary files directly inside their own upload directory; cleanup does not follow symlinks or manifest paths outside the root. Capacity and concurrency accounting are race-safe for the supported single server process. Multiple processes must not share one upload root.

Pending attachment queues are separate per session. Switching sessions neither displays nor clears another session's queue, and upload/send completion is attributed to the session where it began. The browser enforces the five-file total across repeated picker selections for each session; the server remains authoritative. Project actions never carry composer attachments implicitly and do not clear them.

`/api/send` owns audit event semantics. Ordinary sends, including requests claiming `git_action`, `branch_switch`, or another client-selected type, are recorded as `chat_send`. `project_action` is accepted only for a UI-supported action with allowed metadata, no attachments, and a project path that matches the selected session's server-side binding. Server-calculated session, agent, command, length, attachment fields, and repository branch override client metadata; the branch is omitted when the bound repository cannot be safely inspected.

Run-state and attention task rows are attributable only when their `sessionKey` exactly matches an active pool session; unscoped and external tasks are excluded before ordering and response limits. Attention and `/api/audit` share one sanitizer that removes an external session identifier and its related agent identifier while preserving non-session project/Git metadata. The local audit log is advisory, best-effort operational context only. Quiet write failures, bounded reads, and rotation mean it is not complete and must not be treated as an authoritative security ledger.

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

Portable local quality baseline (no Gateway or maintainer filesystem required):

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run browser:fixture
```

`check` runs Node syntax checks on `server.js` and JavaScript files under `lib/`, `public/`, `scripts/`, and `tests/`. It does not execute the application or perform semantic linting. `test` uses Node's built-in runner for portable startup configuration and OpenClaw discovery, agent-specific pool behavior, pool concurrency/migration and Gateway-file immutability, per-session attachment state, project action prompts, audit metadata/read limits/rotation, streaming upload regressions, and isolated Git mode API behavior. `browser:fixture` serves disposable UI/API fixtures with configurable project roots and both Git modes. These tests never require the maintainer's Gateway, repositories, filesystem layout, normal service, or session store.

GitHub Actions runs the same install, checks, and non-browser tests on push and pull request with Node 22.19 and 24. Trusted-host browser tests remain deliberately separate.

CI also performs a clean production-only install smoke on both supported Node lines and runs the portable Chromium fixture. These checks do not replace the two independent-host installation trials defined in [`docs/INSTALLATION-TRIAL.md`](docs/INSTALLATION-TRIAL.md).

Trusted-host smoke test against an already running local service:

```bash
npm run browser:host-smoke
```

With an explicit URL and Chromium:

```bash
MOBILE_STUDIO_URL=http://127.0.0.1:8787/mobile-studio/ \
CHROMIUM_PATH=/path/to/chromium npm run visual:smoke
```

`visual:smoke` remains a compatibility alias for `browser:host-smoke`. Defaults are `http://127.0.0.1:8787/mobile-studio/` and `/snap/bin/chromium`. Unlike `browser:fixture`, this trusted-host suite reads live sessions, history, attention, audit, files, and Git information. It expects at least one session and the maintainer-host projects `projects/Bluesky-moderation-analysis`, `projects/openclaw-mobile-studio`, and `projects/COCAttackAnalyzer` (with enough commits to scroll). API latency thresholds also depend on host load. These requirements intentionally keep it outside generic CI. Settings must render actual session rows; the assertion waits up to 35 seconds for asynchronous loading and still fails if no rows appear.

Run this suite only against a trusted local environment. Mutation interactions are mocked; live project checks inspect Git controls without executing Git writes. Screenshots may contain local information and are written under ignored `test-artifacts/`. Running against another checkout validates that checkout's served frontend, not unserved local server changes; isolated server tests cover backend behavior.

Release preparation references:

- [Changelog](CHANGELOG.md)
- [v0.2.0-rc.1 release notes](docs/RELEASE-NOTES-v0.2.0-rc.1.md)
- [Independent installation trial](docs/INSTALLATION-TRIAL.md)
- [v0.1 stabilization notes](docs/STABILIZATION-v0.1.md)

## Security Notes

- Keep the service private by default.
- Keep the backend loopback-only and the Tailscale route private; never enable Funnel for the supported trusted-tailnet mode.
- Anyone who can reach the route is treated as the authorized single owner; use restrictive tailnet membership and policy.
- Keep `MOBILE_STUDIO_FILE_ROOT` narrow.
- File preview blocks common secret/key/database filenames.
- Mobile-originated chat sends use `deliver:false` so they do not automatically post to external channels.
- Project action buttons and risky slash commands require a deliberate second tap/click.
- Git writes are disabled by default. When explicitly enabled, actions remain guarded and do not force-push, rebase, stash, or resolve conflicts.
- Audit logs are local, append-only JSONL, rotate at 1 MB, store metadata only, and use server-selected send event types.

## License

MIT
