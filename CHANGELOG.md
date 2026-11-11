# Changelog

All notable changes to OpenClaw Mobile Studio are documented here.

## [0.2.0-rc.1] - Unreleased

This candidate is prepared on `product/v0.2` but must not be tagged until two independent installation trials pass.

### Added

- Non-interactive, secret-safe `doctor` checks for configuration, compatibility, Gateway methods, Tailscale, and user systemd.
- Generic environment and user-systemd packaging templates.
- Operations guidance for installation, private Tailscale exposure, backup, upgrade, rollback, and uninstall.
- Production-only installation smoke and portable Chromium CI coverage.
- Sanitized protocol for independent installation trials.

### Changed

- Git access now defaults to server-enforced read-only mode; guarded writes require explicit `MOBILE_STUDIO_GIT_MODE=write` and a restart.
- Runtime paths, file root, OpenClaw binary, agent, project roots, workspace path, and base path are configurable rather than tied to the maintainer host.
- Trusted-tailnet deployments reject non-loopback backend binds.
- Runtime version reporting now uses package metadata as its single source.

### Security

- The supported deployment is single-user and tailnet-only, with no Funnel or public exposure.
- `MOBILE_STUDIO_TOKEN` must remain empty for the standard PWA; doctor rejects a configured token because the browser client does not submit bearer credentials.
- Git write routes are blocked server-side before request parsing or side effects when read-only mode is active.

### Compatibility

- Linux with a user systemd manager.
- Node.js `>=22.19 <25`.
- OpenClaw `>=2026.9.4 <2026.10.0`.
- Git 2.39 or newer.
- Tailscale 1.70 or newer.

### Release gate

- Two passing trials on independently provisioned compatible Linux OS instances.
- No application source edits during installation.
- Approximately 30 minutes per installation without maintainer intervention.
- Complete CI and fixture gates green on the exact candidate commit.
