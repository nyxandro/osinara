# Production deployment

## Architecture

GitHub-hosted CI runs the complete `compose.test.yaml` suite for pull requests and pushes to
`develop` or `main`. A successful `main` run requires a new stable version in `package.json`,
builds five source-free images, publishes immutable tags to GHCR, records artifact attestations,
and prepares `vVERSION` as a draft. CI uploads and byte-verifies every asset before publishing the
draft as the latest release. A failed rerun may resume only a draft whose tag still resolves to the
same commit; a published release or unrelated tag requires a package version bump.
Repository-level immutable releases are mandatory; both the application checker and server reject
published releases whose API metadata does not report `immutable: true`.

- `osinara-deployment.json` contains schema version 1, commit SHA, release version, the SHA-256 of
  the exact Compose bytes, and five exact `ghcr.io/nyxandro/...@sha256:...` references;
- `compose.production.yaml` contains no build context or source bind mount.

GitHub Actions uses only the repository `GITHUB_TOKEN`. The workflow grants package, release,
OIDC, and attestation writes only to the release job. This follows GitHub's current guidance for
[automatic token permissions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication),
[publishing to GHCR](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry),
and [container attestations](https://docs.github.com/en/actions/how-tos/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds).

The server does not clone the repository and never builds an image. The root-owned systemd timer
runs `/opt/osinara/bin/production-deploy.sh` once per minute. The script takes an exclusive lock,
claims one approved PostgreSQL proposal after rechecking the current owner, verifies the public
release, Compose hash, fixed service/image/mount policy, and digest names. It pulls before stopping,
backs up existing durable state, starts the released Compose graph without build, and checks
`http://127.0.0.1:8082/eve/v1/health`.

`compose.production.yaml` uses the stable project name `osinara-production`, explicit volume and
network names, a one-shot migration gate, and a loopback-only edge port. Only sandbox-runner owns
the Docker socket. The agent has no Docker socket and reaches the runner only over the internal
control network.

## Server files

Initial provisioning remains manual until the first production deployment has been verified; this
document intentionally does not provide a one-command installer. Prepare these root-owned files:

| Path | Mode | Purpose |
| --- | --- | --- |
| `/opt/osinara/.env` | `0600` | Production secrets and environment-specific URLs. |
| `/opt/osinara/bin/production-deploy.sh` | `0750` | Server deployment entrypoint. |
| `/opt/osinara/bin/production-deploy/` | `0750` | Root-owned deployment module directory. |
| `/opt/osinara/bin/production-deploy/*.sh` | `0640` | Fixed source modules checked before execution. |
| `/etc/systemd/system/osinara-deploy.service` | `0644` | One-shot root service with the EnvironmentFile. |
| `/etc/systemd/system/osinara-deploy.timer` | `0644` | Persistent minute poll. |

`/opt/osinara`, `/opt/osinara/bin`, and the module directory must be `root:root 0750`; the
entrypoint must be `root:root 0750`. The script rejects symlinks or different metadata before it
sources a module. It creates `/opt/osinara/releases`, `/opt/osinara/backups`, and the atomic
`/opt/osinara/release.env`.

`/opt/osinara/.env` must be exactly `root:root 0600`. It contains `POSTGRES_PASSWORD`, the required
internal application `DATABASE_URL`, Telegram/model secrets, and environment-specific integration
settings. It must never contain or export any of the five `OSINARA_*_IMAGE` variables or
`SANDBOX_RUNTIME_IMAGE`; those values exist only in a validated per-release `release.env`.

The server host requires Docker Engine with Compose v2, systemd, `curl`, `jq`, `flock`, `stat`,
`sha256sum`, `tar`, and standard GNU file utilities. Missing tools are deployment errors; the
script does not download utilities or substitute alternate commands at runtime.

All five GHCR packages must be publicly pullable, or Docker on the server must already be logged in
with read-only package access. The release workflow itself never receives a custom registry secret.

## First release

The first release cannot be selected from PostgreSQL because `software_update_proposals` does not
exist before migrations. After installing the files and creating `/opt/osinara/.env`, run the
server script once as root with `--initial VERSION`. The argument accepts only stable `X.Y.Z`.
This mode performs the same public manifest validation, digest pulls, migration gate, and health
check, but it does not claim a proposal. It fails if `current`, `release.env`, or any container
labelled with the `osinara-production` Compose project already exists.

Run the initial command through a transient service so it receives the same protected
EnvironmentFile as the timer:

```bash
sudo systemd-run --unit=osinara-initial-deploy --wait --collect \
  --property=EnvironmentFile=/opt/osinara/.env \
  /opt/osinara/bin/production-deploy.sh --initial VERSION
```

Only after that manual deployment succeeds, enable `osinara-deploy.timer`. Future releases are
deployed only from an `approved` proposal that is still bound to the exact private Telegram chat
of the single global owner. The target version must be strictly newer than the version in the
current release manifest.

## Failure semantics

Claiming sets a unique deployment lease whose lifetime exceeds the bounded systemd execution
timeout. Each timer start marks an expired `deploying` lease as `ambiguous` and never retries it.
SIGTERM and SIGINT pass through the same terminal-state logic.

Validation, pull, dump, or snapshot failures before migration are stored as `failed`. If current
services were already stopped, the script first restarts the current release and requires its
health check to pass; failed recovery becomes `ambiguous`. Once candidate migration begins, every
failure is `ambiguous` and no automatic rollback is attempted. Operators inspect the stored stable
result code, logs, and timestamp, then approve a later version explicitly.

Before every non-initial update the script verifies durable volumes and free space, writes and
validates a logical PostgreSQL dump, stops application writers, archives `tool-environments`,
`workflow-data`, and `workspace-data`, then validates each archive. Reconstructible embedding model
and sandbox cache volumes are omitted. Candidate release files remain in a unique temporary
directory and become `releases/vVERSION` only after health succeeds.
