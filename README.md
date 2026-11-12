# OpenClaw Mobile Studio

[![Quality checks](https://github.com/nicorota200/openclaw-mobile-studio/actions/workflows/ci.yml/badge.svg?branch=product%2Fv0.2)](https://github.com/nicorota200/openclaw-mobile-studio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A mobile-first, self-hosted control surface for OpenClaw.**

OpenClaw Mobile Studio lets a technical operator supervise OpenClaw from a phone: chat through a controlled session pool, inspect projects and Git state, browse an allowed filesystem area, review active work, and optionally perform guarded Git writes.

It runs as a small Node.js service beside an existing OpenClaw Gateway. The backend listens only on loopback and the PWA is exposed privately through Tailscale Serve.

> **Release status:** `v0.2.0-rc.1` is prepared on `product/v0.2` but is not tagged yet. The application candidate passed the complete automated gate and two independent clean-VM installation trials without source changes.

## Product contract

The first standalone release intentionally supports a narrow deployment model:

- one technical operator;
- one Linux host with OpenClaw and its Gateway already configured;
- one Mobile Studio process on the same host;
- a private, owner-controlled Tailscale tailnet;
- loopback-only backend access;
- Git inspection enabled by default, with Git writes as an explicit server-side opt-in.

Public exposure, Tailscale Funnel, shared-tailnet access, multi-user authorization, and arbitrary browser terminals are outside this release contract.

## Capabilities

- **Mobile chat:** use a fixed, app-owned pool of OpenClaw sessions.
- **Project-aware sessions:** attach projects to available chat slots without modifying OpenClaw's session store.
- **Run supervision:** see active work and stop active runs.
- **Project overview:** inspect changed repositories, recent activity, and audit events.
- **Read-only files:** browse and preview files inside an explicit filesystem boundary.
- **Git inspection:** view status, branches, history, commits, changed files, and diffs.
- **Optional Git writes:** switch branch, fast-forward pull, stage, unstage, commit, and push when write mode is enabled.
- **Project actions:** launch deliberate, project-aware prompts such as review, explain diff, check, commit plan, and continue.
- **Attachments:** upload files into session-specific queues with bounded size, concurrency, and retention.
- **Local audit trail:** retain bounded metadata for Mobile Studio actions without storing raw prompt content.

## Architecture

```text
Phone / desktop browser
        |
        | private tailnet HTTPS
        v
Tailscale Serve
        |
        | loopback only
        v
OpenClaw Mobile Studio (Node.js + PWA)
        |
        +-- OpenClaw CLI and local Gateway
        +-- configured project repositories
        +-- configured filesystem boundary
```

Mobile Studio does not replace OpenClaw and does not expose the Gateway directly. It is an operator interface over a deliberately restricted set of local integrations.

## Requirements

- Linux with a working user systemd manager.
- Node.js `>=22.19.0 <25.0.0`.
- OpenClaw `>=2026.9.4 <2026.10.0`, with CLI and Gateway on the same host.
- Git 2.39 or newer.
- Tailscale 1.70 or newer, connected to a private tailnet.

These ranges are intentionally conservative and reflect tested combinations. `npm run doctor` rejects incompatible versions rather than assuming a newer Gateway schema is safe.

## Quick start

The supported installation uses a per-user checkout and systemd service. OpenClaw and Tailscale must already be working on the host.

### 1. Clone the product branch

```bash
install -d "$HOME/.local/share/openclaw-mobile-studio"
git clone --branch product/v0.2 --single-branch \
  https://github.com/nicorota200/openclaw-mobile-studio.git \
  "$HOME/.local/share/openclaw-mobile-studio/app"
cd "$HOME/.local/share/openclaw-mobile-studio/app"
npm ci --omit=dev
```

Once a release tag exists, production installations should pin that tag instead of following the branch.

### 2. Create the private configuration

```bash
install -d -m 700 "$HOME/.config/openclaw-mobile-studio"
install -m 600 packaging/mobile-studio.env.example \
  "$HOME/.config/openclaw-mobile-studio/env"
command -v openclaw
```

Edit `~/.config/openclaw-mobile-studio/env` and, at minimum:

- replace every `/home/your-user` placeholder;
- set `MOBILE_STUDIO_FILE_ROOT` to the narrowest useful readable directory;
- set `OPENCLAW_BIN` to the absolute result of `command -v openclaw`;
- keep `HOST=127.0.0.1`;
- keep `MOBILE_STUDIO_TOKEN` empty;
- begin with `MOBILE_STUDIO_GIT_MODE=read`.

Never commit this file or include it in issue reports.

### 3. Run the preflight

```bash
npm run doctor -- --env-file "$HOME/.config/openclaw-mobile-studio/env"
```

Before Tailscale Serve is configured, `tailscale-serve` may be the only warning. Stop and fix every `FAIL` before continuing.

### 4. Install the user service

```bash
install -d "$HOME/.config/systemd/user"
install -m 644 packaging/openclaw-mobile-studio.service \
  "$HOME/.config/systemd/user/openclaw-mobile-studio.service"
systemctl --user daemon-reload
systemctl --user enable --now openclaw-mobile-studio.service
systemctl --user status openclaw-mobile-studio.service --no-pager
curl --fail --silent http://127.0.0.1:8787/api/health
```

If user services must survive logout, configure user lingering according to the Linux distribution's policy.

### 5. Expose it privately with Tailscale Serve

```bash
tailscale serve --bg --yes --set-path /mobile-studio \
  http://127.0.0.1:8787
tailscale serve status
```

The route must be reported as **tailnet only**. Then rerun doctor:

```bash
cd "$HOME/.local/share/openclaw-mobile-studio/app"
npm run doctor -- --env-file "$HOME/.config/openclaw-mobile-studio/env"
```

Open the PWA at:

```text
https://your-node.your-tailnet.ts.net/mobile-studio/
```

For backup, upgrade, rollback, logs, and recoverable uninstall procedures, use the [operations guide](docs/OPERATIONS.md).

## Configuration

The complete template is [`packaging/mobile-studio.env.example`](packaging/mobile-studio.env.example). The principal settings are:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Backend bind address. Only loopback values are accepted. |
| `PORT` | `8787` | Local HTTP port. |
| `MOBILE_STUDIO_FILE_ROOT` | required | Filesystem boundary for browsing, project discovery, and Git operations. |
| `MOBILE_STUDIO_AGENT_ID` | `main` | OpenClaw agent namespace used by the session pool. |
| `MOBILE_STUDIO_PROJECT_ROOTS` | `projects,.openclaw/workspace/projects` | Comma-separated project directories relative to the file root. |
| `MOBILE_STUDIO_WORKSPACE_PATH` | `.openclaw/workspace` | Optional Workspace shortcut relative to the file root. Empty hides it. |
| `MOBILE_STUDIO_BASE_PATH` | `/mobile-studio` | Private proxy route and PWA scope. |
| `OPENCLAW_BIN` | discovered from `PATH` | OpenClaw executable; use an absolute path under systemd. |
| `MOBILE_STUDIO_SESSION_POOL_SIZE` | `5` | Fixed session pool size, from 1 through 20. |
| `MOBILE_STUDIO_GIT_MODE` | `read` | Server-authoritative Git capability: `read` or `write`. |
| `MOBILE_STUDIO_TOKEN` | empty | Must remain empty for the supported PWA deployment. |

Upload directory, size, aggregate-capacity, concurrency, attachment-count, and TTL limits are also configurable in the template.

All configured project and workspace paths must resolve inside `MOBILE_STUDIO_FILE_ROOT`. Startup fails with an actionable error for an invalid root, executable, agent identifier, base path, bind address, or Git mode.

## Security model

Tailscale is the authentication and network boundary for this release.

- Keep the backend on loopback; wildcard and public binds fail startup.
- Use Tailscale Serve, never Funnel.
- Restrict tailnet membership and policy to the owner devices that may control OpenClaw.
- Treat every principal able to reach the route as fully authorized for all enabled Mobile Studio capabilities.
- Keep `MOBILE_STUDIO_FILE_ROOT` narrow and exclude unrelated private material.
- Keep `MOBILE_STUDIO_TOKEN` empty: the server retains bearer-token compatibility, but the standard PWA does not collect or send bearer credentials.

There is no application-level login or per-user authorization in `v0.2.0-rc.1`. Do not deploy this release on a shared tailnet or expose it to the public internet.

## Git modes

`MOBILE_STUDIO_GIT_MODE=read` is the default and recommended starting point. Status, history, branches, changes, and diffs remain available, while every mutation endpoint is rejected server-side with `403 GIT_WRITES_DISABLED`.

To enable guarded writes:

1. Set `MOBILE_STUDIO_GIT_MODE=write` in the private environment file.
2. Restart the service.
3. Confirm the mode in the UI and `/api/health`.

```bash
systemctl --user restart openclaw-mobile-studio.service
curl --fail --silent http://127.0.0.1:8787/api/health
```

Write mode is not an in-app toggle. Existing safeguards remain active: no force-push, no rebase, no automatic stash, no conflict resolution, fast-forward-only pull, upstream checks, dirty-worktree checks where required, and local action auditing.

## Data and recovery

Application-owned runtime data lives under `data/` in the checkout:

- `data/session-state.json` — fixed pool registry and project bindings;
- `data/audit-log.jsonl` — bounded advisory audit metadata;
- `data/chat-uploads/` — temporary attachment payloads and manifests.

Mobile Studio never edits or replaces OpenClaw's Gateway-owned session index or transcripts. Back up the app-owned state with the service stopped before upgrades or manual maintenance. See [Backup and rollback](docs/OPERATIONS.md#backup) for the supported procedure.

## Verification and development

Portable checks do not require the maintainer's filesystem, repositories, Gateway state, or running service:

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run smoke:production
npm run browser:fixture
npm audit --audit-level=high
```

CI runs syntax and automated tests on Node 22.19 and Node 24, production-only installation smoke on both Node lines, and the Chromium fixture. The release-candidate application also passed two independent clean-VM installation trials using the published [trial protocol](docs/INSTALLATION-TRIAL.md).

`npm run browser:host-smoke` is an optional trusted-host compatibility check. It reads live local data and may create screenshots containing private repository information; do not use or publish its artifacts outside a trusted environment.

## Current limitations

- Single operator and single process only.
- No application login or multi-user identity.
- No public internet or Funnel deployment.
- No arbitrary shell or administrative terminal.
- No browser-managed bearer-token authentication.
- No automatic Git conflict resolution, rebase, stash, or force-push.
- OpenClaw compatibility is intentionally limited to the tested 2026.9.x range.

These are explicit product boundaries, not hidden installation assumptions.

## Documentation

- [Operations: install, Serve, backup, upgrade, rollback, uninstall](docs/OPERATIONS.md)
- [Release notes for v0.2.0-rc.1](docs/RELEASE-NOTES-v0.2.0-rc.1.md)
- [Changelog](CHANGELOG.md)
- [Independent installation trial protocol](docs/INSTALLATION-TRIAL.md)
- [Productization plan and security decisions](docs/PRODUCTIZATION-PLAN.md)
- [v0.1 stabilization notes](docs/STABILIZATION-v0.1.md)

## License

[MIT](LICENSE)
