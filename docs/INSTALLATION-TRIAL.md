# Independent installation trial

Use this protocol for each Phase 4 installation. A trial counts only when it runs on a distinct compatible Linux host with its own OpenClaw Gateway and Tailscale node. Two directories, users, containers, or virtual machines backed by the same physical server do not satisfy the two-host release gate.

The operator must follow `docs/OPERATIONS.md` without editing application source. Start a timer before cloning and stop it after the final doctor, local health probe, and private browser check pass. The target is approximately 30 minutes without maintainer intervention.

## Trial procedure

1. Record a pseudonymous host label, operator label, start time, Linux distribution, and fresh or existing OpenClaw status. Do not record hostnames, tailnet names, IP addresses, tokens, environment-file contents, repository names, or private paths.
2. Follow the install and Tailscale Serve sections of `docs/OPERATIONS.md` exactly.
3. Keep `MOBILE_STUDIO_GIT_MODE=read` for the trial.
4. Save the token-safe doctor result:

   ```bash
   install -d -m 700 release-artifacts
   npm run --silent doctor -- \
     --env-file "$HOME/.config/openclaw-mobile-studio/env" \
     --json > release-artifacts/doctor.json
   ```

5. Verify the service and loopback endpoint, then open the tailnet-only URL from an authorized second device:

   ```bash
   systemctl --user is-active openclaw-mobile-studio.service
   curl --fail --silent http://127.0.0.1:8787/api/health >/dev/null
   tailscale serve status
   ```

6. Run the production smoke from the installed checkout:

   ```bash
   npm run smoke:production
   ```

7. Confirm the checkout is unmodified with `git status --short`. Record the final commit with `git rev-parse HEAD`, but do not attach raw logs or configuration files.

## Evidence record

Create one sanitized record per host outside the repository. Use this structure:

```yaml
trial_id: host-a
operator: external-operator-a
started_at: 2026-01-01T10:00:00Z
elapsed_minutes: 0
distribution: example-linux-version
node_version: 0.0.0
openclaw_version: 0.0.0
git_version: 0.0.0
tailscale_version: 0.0.0
mobile_studio_commit: full-commit-id
source_edits: false
git_mode: read
doctor:
  checks: 0
  failures: 0
  warnings: 0
service_active: false
loopback_health: false
tailnet_browser_check: false
production_smoke: false
failures: []
operator_interventions: []
result: pass-or-fail
```

Warnings, failures, and interventions must be described without secrets or identifying infrastructure. A passing trial requires zero doctor failures, an active service, successful loopback and tailnet browser checks, a passing production smoke, no source edits, and a clean checkout.

## Release gate

The release candidate may be tagged only after two passing records from independent hosts have been reviewed and all release-blocking fixes have passed the complete CI and fixture gates. The maintainer host may be one diagnostic baseline, but it does not replace two independent installation trials.
