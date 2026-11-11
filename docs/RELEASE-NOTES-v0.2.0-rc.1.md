# OpenClaw Mobile Studio v0.2.0-rc.1

Status: prepared, not tagged or released.

This is the first distributable candidate for technical single-user operators running OpenClaw on a Linux server behind a private Tailscale tailnet. It is not intended for public exposure, shared access, or multi-user authorization.

## Highlights

- Server-enforced Git read-only default with explicit guarded write opt-in.
- Portable runtime configuration with no maintainer-specific source paths.
- Loopback-only trusted-tailnet deployment contract.
- Secret-safe preflight doctor and generic user-systemd packaging.
- Documented installation, backup, upgrade, rollback, and uninstall lifecycle.
- Portable Node 22/24, production-install, API, and Chromium verification.

## Required configuration changes from v0.1

- Set `MOBILE_STUDIO_FILE_ROOT` to an existing readable directory.
- Keep `HOST` on loopback.
- Leave `MOBILE_STUDIO_TOKEN` empty for the standard PWA.
- Set `OPENCLAW_BIN` or provide `openclaw` through the service `PATH`.
- Review agent, project-root, workspace, and base-path settings.
- Git writes are off unless `MOBILE_STUDIO_GIT_MODE=write` is explicitly configured.

Run `npm run doctor -- --env-file PATH` before starting or restarting the service.

## Supported versions

- Linux with a user systemd manager.
- Node.js 22.19 through 24.x.
- OpenClaw 2026.9.4 through 2026.9.x.
- Git 2.39 or newer.
- Tailscale 1.70 or newer.

## Known boundaries

- Tailscale is the access boundary; there is no application login or multi-user identity.
- The standard PWA does not support bearer-token entry or storage.
- Public internet exposure and Tailscale Funnel are unsupported.
- The service supports one Mobile Studio process and one technical operator.
- Trusted-host visual smoke tests remain maintainer-environment specific; portable fixtures run in CI.

## Verification before publication

- Local syntax, unit/integration, production smoke, Chromium fixture, diff, and dependency gates.
- GitHub Actions on Node 22.19 and 24 plus Chromium.
- Two independent installation records following `docs/INSTALLATION-TRIAL.md`.

The tag and GitHub Release must be created only after the two installation records pass on the exact candidate commit. Product publication does not deploy or alter the separate personal live checkout.
