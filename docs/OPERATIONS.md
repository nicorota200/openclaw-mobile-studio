# OpenClaw Mobile Studio operations guide

This guide covers the first supported product target: one technical operator, one Linux host, a local OpenClaw Gateway, a private Tailscale tailnet, and a loopback-only Mobile Studio backend. Public exposure, Tailscale Funnel, shared access, and multi-user authorization are unsupported.

## Supported versions

The initial range is intentionally narrow and reflects versions exercised by automated tests or the maintainer host:

- Linux with a working user systemd manager.
- Node.js `>=22.19.0 <25.0.0` (22.19 and 24.x).
- OpenClaw `>=2026.9.4 <2026.10.0` (2026.9.4 through 2026.9.x).
- Git 2.39 or newer.
- Tailscale 1.70 or newer.

`npm run doctor` fails outside these ranges. Phase 4 installation trials may justify widening them; do not silently assume later OpenClaw Gateway schemas are compatible.

## Standard user installation layout

```text
~/.local/share/openclaw-mobile-studio/app   application checkout and data/
~/.config/openclaw-mobile-studio/env        service configuration (mode 0600)
~/.config/systemd/user/openclaw-mobile-studio.service
~/.local/state/openclaw-mobile-studio/       operator backup/rollback metadata
```

The service account must be able to read the configured file root and execute OpenClaw and Git. It must also be able to write the application `data/` directory. Git write mode additionally requires normal write permission on configured repositories.

## Install

1. Confirm the host already has a configured local OpenClaw Gateway and is connected to the intended private tailnet.

2. Clone the product branch and install production dependencies:

```bash
install -d "$HOME/.local/share/openclaw-mobile-studio"
git clone --branch product/v0.2 --single-branch \
  https://github.com/nicorota200/openclaw-mobile-studio.git \
  "$HOME/.local/share/openclaw-mobile-studio/app"
cd "$HOME/.local/share/openclaw-mobile-studio/app"
npm ci --omit=dev
```

3. Create the private environment file:

```bash
install -d -m 700 "$HOME/.config/openclaw-mobile-studio"
install -m 600 packaging/mobile-studio.env.example \
  "$HOME/.config/openclaw-mobile-studio/env"
command -v openclaw
command -v npm
```

Edit the environment file. Replace every `/home/your-user` placeholder, set `OPENCLAW_BIN` to the absolute result of `command -v openclaw`, and set `PATH` if `npm`, Git, OpenClaw, or SSH are outside the systemd user manager's default path. Keep `HOST=127.0.0.1` and begin with `MOBILE_STUDIO_GIT_MODE=read`.

The environment file is compatible with systemd and Node's `--env-file` parser. Do not commit it or copy its contents into issue reports.

4. Run the non-interactive preflight:

```bash
npm run doctor -- --env-file "$HOME/.config/openclaw-mobile-studio/env"
```

Before Tailscale Serve is configured, `tailscale-serve` may be the only warning. Any `FAIL` must be fixed before installation continues. For JSON without npm's command banner, use `npm run --silent doctor -- --env-file "$HOME/.config/openclaw-mobile-studio/env" --json`.

5. Install and start the user service:

```bash
install -d "$HOME/.config/systemd/user"
install -m 644 packaging/openclaw-mobile-studio.service \
  "$HOME/.config/systemd/user/openclaw-mobile-studio.service"
systemctl --user daemon-reload
systemctl --user enable --now openclaw-mobile-studio.service
systemctl --user status openclaw-mobile-studio.service --no-pager
curl --fail --silent http://127.0.0.1:8787/api/health >/dev/null
```

The service template expects the standard installation layout above. On hosts where user services must survive logout, review and enable user lingering according to the distribution's policy.

## Private Tailscale exposure

Keep tailnet membership restricted to authorized owner devices and apply tailnet policy that limits access to the server. Do not enable Funnel.

For the default route and port:

```bash
tailscale serve --bg --yes --set-path /mobile-studio http://127.0.0.1:8787
tailscale serve status
```

The status must say `tailnet only` and include `/mobile-studio`. Then rerun doctor:

```bash
cd "$HOME/.local/share/openclaw-mobile-studio/app"
npm run doctor -- --env-file "$HOME/.config/openclaw-mobile-studio/env"
```

Anyone who can reach this route is treated as the authorized owner of every enabled Mobile Studio capability. If the tailnet is shared or the route must be public, stop: that deployment needs an application authentication design outside this release contract.

## Health and logs

```bash
systemctl --user is-active openclaw-mobile-studio.service
journalctl --user -u openclaw-mobile-studio.service -n 100 --no-pager
curl --fail --silent http://127.0.0.1:8787/api/health
tailscale serve status
```

Do not publish raw environment files, journal lines containing private paths, Gateway payloads, or screenshots containing repository data.

## Backup

Back up before upgrades and before manual state maintenance. `data/session-state.json` contains the app-owned pool registry and project bindings. The audit log is advisory. Upload payloads are temporary and should normally be excluded.

For a coherent stopped-service backup:

```bash
install -d -m 700 "$HOME/.local/state/openclaw-mobile-studio/backups"
systemctl --user stop openclaw-mobile-studio.service
tar --exclude='data/chat-uploads' \
  -czf "$HOME/.local/state/openclaw-mobile-studio/backups/mobile-studio-$(date +%Y%m%d-%H%M%S).tar.gz" \
  -C "$HOME" \
  .config/openclaw-mobile-studio \
  .local/share/openclaw-mobile-studio/app/data
systemctl --user start openclaw-mobile-studio.service
```

Backups include the private environment file and must remain mode-restricted and outside searchable archives. OpenClaw Gateway transcripts are not owned by Mobile Studio and require the OpenClaw backup procedure.

## Upgrade

1. Make the backup above.
2. Require a clean application checkout.
3. Record the previous commit, fast-forward the product branch, reinstall exact dependencies, and run doctor before restart:

```bash
cd "$HOME/.local/share/openclaw-mobile-studio/app"
test -z "$(git status --porcelain)"
install -d -m 700 "$HOME/.local/state/openclaw-mobile-studio"
git rev-parse HEAD > "$HOME/.local/state/openclaw-mobile-studio/previous-commit"
git fetch origin
git switch product/v0.2
git pull --ff-only origin product/v0.2
npm ci --omit=dev
npm run doctor -- --env-file "$HOME/.config/openclaw-mobile-studio/env"
systemctl --user restart openclaw-mobile-studio.service
curl --fail --silent http://127.0.0.1:8787/api/health >/dev/null
```

Do not restart when doctor fails. Review release notes for new required variables or state migrations before upgrading.

## Rollback

Use the saved pre-upgrade commit and restore a backup if the release changed app-owned state incompatibly:

```bash
cd "$HOME/.local/share/openclaw-mobile-studio/app"
systemctl --user stop openclaw-mobile-studio.service
git switch --detach "$(cat "$HOME/.local/state/openclaw-mobile-studio/previous-commit")"
npm ci --omit=dev
npm run doctor -- --env-file "$HOME/.config/openclaw-mobile-studio/env"
systemctl --user start openclaw-mobile-studio.service
curl --fail --silent http://127.0.0.1:8787/api/health >/dev/null
```

If needed, restore `data/` from the matching stopped-service backup before starting. A detached checkout is acceptable during recovery; return to `product/v0.2` only after the faulty release is resolved.

## Uninstall

1. Inspect `tailscale serve status`. Remove only the Mobile Studio route using the command appropriate to the installed Tailscale version. Do **not** run `tailscale serve reset` on a node that serves other applications; it removes the whole node Serve configuration.
2. Stop and disable the unit:

```bash
install -d -m 700 "$HOME/.local/state/openclaw-mobile-studio"
systemctl --user disable --now openclaw-mobile-studio.service
mv "$HOME/.config/systemd/user/openclaw-mobile-studio.service" \
  "$HOME/.local/state/openclaw-mobile-studio/openclaw-mobile-studio.service.removed"
systemctl --user daemon-reload
```

3. Preserve the application and private configuration recoverably until deletion is explicitly intended:

```bash
mv "$HOME/.local/share/openclaw-mobile-studio" \
  "$HOME/.local/state/openclaw-mobile-studio/app.removed"
mv "$HOME/.config/openclaw-mobile-studio" \
  "$HOME/.local/state/openclaw-mobile-studio/config.removed"
```

Mobile Studio does not own OpenClaw, Tailscale, Git, project repositories, or Gateway transcripts; uninstalling it must not remove them.

## Doctor result policy

- `PASS`: supported prerequisite or live integration probe succeeded.
- `WARN`: operation can continue only when the warning is expected, such as Serve not yet configured before first start.
- `FAIL`: installation or upgrade must stop.

Doctor uses read-only Gateway calls (`health`, `status`, and `sessions.list`), does not send chat messages, does not mutate repositories, and never prints `MOBILE_STUDIO_TOKEN`.
