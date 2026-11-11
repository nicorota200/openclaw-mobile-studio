# OpenClaw Mobile Studio productization plan

Status: approved direction, implementation starting from the live v0.1 baseline.

Phase 1 implementation note: `MOBILE_STUDIO_GIT_MODE` is server-authoritative, defaults to `read`, and requires a restart to change. The frontend reads the active non-secret mode from `/api/config`; `/api/health` reports the same value. Direct Git mutation routes remain unavailable unless the server starts in `write` mode.

Phase 2 implementation note: runtime configuration no longer contains maintainer home paths. `MOBILE_STUDIO_FILE_ROOT` is explicit and required; the OpenClaw CLI is discovered through `PATH` or `OPENCLAW_BIN`; agent ID, project roots, workspace shortcut, and route base are configurable. Trusted-tailnet mode rejects non-loopback binds at startup. Portable API/unit and Chromium fixtures are separate from the explicitly named trusted-host smoke command.

Phase 3 implementation note: `npm run doctor` provides non-interactive human and JSON preflight output, shares runtime configuration validation, checks the deliberately narrow dependency ranges and read-only Gateway compatibility probes, and does not expose token values. `packaging/` contains the standard user-systemd unit and environment template. `docs/OPERATIONS.md` defines install, private Tailscale exposure, backup, upgrade, rollback, and recoverable uninstall procedures.

Phase 4 preparation note: CI now includes a clean production-only installation smoke on every supported Node line and the isolated Chromium fixture. `docs/INSTALLATION-TRIAL.md` defines the sanitized evidence record and strictly preserves the two-independent-host gate. A release candidate remains blocked until two real compatible hosts pass without source changes.

## Release and branch policy

- `main` is the stable personal/live baseline.
- Publish the currently deployed and verified commit `d7d77a1` to remote `main` without changing its runtime behavior.
- Keep the live checkout on `main`; product development must not be deployed there implicitly.
- Create `product/v0.2` from the published baseline.
- Product work is merged to `main` only after explicit review, migration notes, green verification, and deployment approval.

## Product contract

The first distributable target is deliberately narrow:

- single-user;
- self-hosted Linux server;
- OpenClaw CLI and Gateway on the same machine;
- browser access through a private Tailscale tailnet;
- no Tailscale Funnel or public internet exposure;
- backend bound to loopback;
- one Mobile Studio server process;
- technical operator responsible for the server and tailnet.

Multi-user access, public exposure, enterprise RBAC, and a standalone password system are not part of this productization phase.

## Security boundary

Tailscale is the initial authentication and network-access boundary. This is the supported **trusted-tailnet mode**.

The documentation and setup checks must state and verify these assumptions where practical:

- only authorized devices and users can join the tailnet;
- tailnet policy limits access to the server and Mobile Studio route;
- the backend listens only on loopback;
- the route is served privately and is not exposed through Funnel;
- anyone who can reach the route must be treated as an authorized owner of the configured Mobile Studio capabilities.

Application-level login and per-user identity are deferred until the product needs shared tailnets, multiple users, or non-tailnet exposure.

## Git capability modes

Git access has two server-controlled modes:

- `read` — default. Status, history, branches, changes, and diffs are available. Every write endpoint is rejected server-side.
- `write` — opt-in. Existing guarded branch switching, pull, stage, unstage, commit, and push operations are available.

Initial configuration contract:

```text
MOBILE_STUDIO_GIT_MODE=read|write
```

Requirements:

- default to `read` when unset;
- reject invalid values at startup;
- expose the active non-secret mode through the health/config response;
- enforce the mode in the backend before any Git write command;
- return a stable `403 GIT_WRITES_DISABLED` response in read mode;
- render the active mode clearly in the UI;
- hide or disable write controls in read mode without treating the UI as the security boundary;
- preserve existing write guardrails and audit events in write mode;
- changing mode initially requires server configuration and restart, not an in-app toggle.

## Implementation phases

### Phase 0 — Freeze and publish the personal baseline

1. Reconfirm development and live checkouts are clean and at `d7d77a1`.
2. Reconfirm the service is healthy and the local quality baseline passes.
3. Fast-forward remote `main` to `d7d77a1` without force.
4. Verify remote `main`, development `main`, live `main`, and the running service agree.

Acceptance: ordinary clones receive the exact current live baseline, and the live service remains unchanged and healthy.

### Phase 1 — Establish the product branch and capability contract

1. Create `product/v0.2` from published `main`.
2. Commit this plan on that branch.
3. Add `MOBILE_STUDIO_GIT_MODE` to configuration and documentation.
4. Enforce read/write mode server-side and reflect it in the UI.
5. Add isolated API and browser tests for both modes.

Acceptance: a default installation cannot execute Git writes; enabling `write` restores the currently supported guarded operations.

### Phase 2 — Remove host-specific assumptions

1. Remove personal filesystem and executable defaults from runtime and frontend state.
2. Discover or explicitly configure the OpenClaw binary.
3. Make the OpenClaw agent identifier and project roots configurable where required.
4. Add startup validation with actionable errors.
5. Separate generic browser fixtures from trusted-host smoke checks.

Acceptance: a clean checkout on another compatible server needs configuration, not source edits.

### Phase 3 — Installation and operations

1. Add a non-interactive `doctor` command.
2. Provide a generic user-systemd service template and environment-file example.
3. Document Tailscale Serve setup, policy assumptions, backup, upgrade, rollback, and uninstall.
4. Define the supported OpenClaw version range and compatibility checks.

Acceptance: a technical user can install and validate the application from documentation without knowledge of the original server.

### Phase 4 — Reproducible release proof

1. Run fixture-based CI and isolated integration tests.
2. Install on at least two independent OpenClaw servers without code changes.
3. Record setup time, failures, required configuration, and compatibility results.
4. Fix release blockers and publish a versioned candidate.

Acceptance: an external operator can install the product in approximately 30 minutes without maintainer intervention.

## Verification gates for every phase

- `npm run check`
- `npm test`
- relevant fixture-based browser checks
- `git diff --check`
- no secrets or runtime data committed
- live checkout and service verified unchanged unless deployment was explicitly approved

## Execution constraint

Implementation work for this productization effort uses `gpt-5.6-sol` with reasoning effort `high`, never a higher effort, to control credit usage.
