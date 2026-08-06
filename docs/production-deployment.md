# Production deployment

## Architecture

GitHub-hosted CI runs the complete `compose.test.yaml` suite for pull requests and pushes to
`develop` or `main`. A successful `main` run requires a new stable version in `package.json`,
builds six container-only images, publishes immutable tags to GHCR, records artifact attestations,
and prepares `vVERSION` as a draft. CI uploads and byte-verifies every asset before publishing the
draft as the latest release. A failed rerun may resume only a draft whose tag still resolves to the
same commit; a published release or unrelated tag requires a package version bump.
Every version must also provide a detailed user-facing changelog at `docs/releases/vVERSION.md`;
the release job fails before image publication when that file is absent or empty and uses it as the
exact GitHub Release description instead of an opaque generated commit list.
Repository-level immutable releases are mandatory; both the application checker and server reject
published releases whose API metadata does not report `immutable: true`.

- `osinara-deployment.json` contains schema version 1, commit SHA, release version, the SHA-256 of
the exact Compose bytes, and six exact `ghcr.io/nyxandro/...@sha256:...` references;
- `compose.production.yaml` contains no build context or application source bind mount.

The app image contains the authored `agent/` tree because Eve `0.22.5` still bundles those modules
when `eve start` serves the built `.output`. The server receives no checkout: the source is confined
to the immutable app image selected by digest.

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
Before each non-initial deployment it also prunes older Osinara deployment backups, retaining the
initial migration backup while clearing the timestamped slot for the pending snapshot; after
successful backup creation exactly one previous-release backup remains. After a successful health
check and terminal success record it removes local first-party Osinara image references older than
the current and previous release; this never prunes non-Osinara projects on the same server.

`compose.production.yaml` uses the stable project name `osinara-production`, explicit volume and
network names, a one-shot migration gate, and a loopback-only edge port. Only sandbox-runner owns
the Docker socket. The agent has no Docker socket and reaches the runner only over the internal
control network. Every service uses bounded Docker `json-file` logging (`20m` by `5` files), and
the deployment validator rejects releases that remove this bound.

## Server files

Initial provisioning remains manual until the first production deployment has been verified; this
document intentionally does not provide a one-command installer. Prepare these root-owned files:


| Path                                         | Mode   | Purpose                                                          |
| -------------------------------------------- | ------ | ---------------------------------------------------------------- |
| `/opt/osinara/.env`                          | `0600` | Production secrets and environment-specific URLs.                |
| `/opt/osinara/model-providers.json`          | `0644` | Schema-v1 deployment compatibility config retained for rollback. |
| `/opt/osinara/bin/production-deploy.sh`      | `0750` | Server deployment entrypoint.                                    |
| `/opt/osinara/bin/production-deploy/`        | `0750` | Root-owned deployment module directory.                          |
| `/opt/osinara/bin/production-deploy/*.sh`    | `0640` | Fixed source modules checked before execution.                   |
| `/etc/systemd/system/osinara-deploy.service` | `0644` | One-shot root service with the EnvironmentFile.                  |
| `/etc/systemd/system/osinara-deploy.timer`   | `0644` | Persistent minute poll.                                          |


`/opt/osinara`, `/opt/osinara/bin`, and the module directory must be `root:root 0750`; the
entrypoint must be `root:root 0750`. The script rejects symlinks or different metadata before it
sources a module. It creates `/opt/osinara/releases`, `/opt/osinara/backups`, and the atomic
`/opt/osinara/release.env`.

`/opt/osinara/.env` must be exactly `root:root 0600`. It contains `POSTGRES_PASSWORD`, the required
internal application `DATABASE_URL`, `CLI_PROXY_API_KEY`, `DEEPSEEK_API_KEY`,
`MODEL_UPSTREAM_API_KEY`, `GROQ_API_KEY`,
Telegram secrets, and environment-specific integration
settings. It must never contain or export any of the six `OSINARA_*_IMAGE` variables or
`SANDBOX_RUNTIME_IMAGE`; those values exist only in a validated per-release `release.env`.

`/opt/osinara/model-providers.json` remains a schema-v1 deployment compatibility file so an older
release can restart during recovery. Active model selection is immutable in each app image at
`config/agent-model-providers.json`: schema v3 selects a protocol-native transport, explicit output
and context limits, and a discriminated image-input capability. A supported vision route requires
its own model ID and output limit; an unsupported route cannot construct a fake vision model.
Changing active model selection therefore requires a reviewed release and rolls back atomically
with that image.

The active `opencode-go-deepseek-v4-flash` route uses the existing tailnet-only CPA over HTTPS
with thinking explicitly enabled at `high` effort. CPA retains the OpenCode Go credential pool,
rotation, and retry policy; the Osinara host receives only a dedicated downstream bearer key.
The transport keeps `reasoning_content` separate from user-visible text and replays it after tool
calls, as required by DeepSeek multi-round semantics. The application caps one response at 128,000
tokens. DeepSeek does not accept image input, so `inspect_workspace_image` returns a stable
unsupported-capability result before reading bytes or starting a paid model call.

The retained MiniMax alternative transport explicitly enables a narrow web-search adapter because
MiniMax returns
`content` where the Anthropic SDK requires `encrypted_content`, but rejects its own native
`server_tool_use` / `web_search_tool_result` blocks when they are replayed. Responses retain the
exact result value for SDK parsing; history converts each matched provider pair into an ordinary
`tool_use` / `tool_result` exchange so later model steps remain valid. Remove this adapter only when
MiniMax emits the Anthropic field and accepts native provider-tool history, or when the AI SDK
supports the complete MiniMax dialect natively.

The `cli-proxy-api` service and sixth release image remain only because the installed production
deployment controller validates manifest schema version 1 and its fixed six-image service graph.
The agent does not call this service. Its isolated baked compatibility config is not part of active
model selection. Removing that deployment slot requires a separately approved two-phase controller
migration; it must not be coupled to a model-provider switch.

The server host requires Docker Engine with Compose v2, systemd, `curl`, `jq`, `flock`, `stat`,
`sha256sum`, `tar`, and standard GNU file utilities. Missing tools are deployment errors; the
script does not download utilities or substitute alternate commands at runtime.

All six GHCR packages must be publicly pullable, or Docker on the server must already be logged in
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
validates a logical PostgreSQL dump, stops application writers, archives
`google-workspace-credentials`, `tool-environments`, `workflow-data`, and `workspace-data`, then
validates each archive. Reconstructible embedding model and sandbox cache volumes are omitted.
Candidate release files remain in a unique temporary directory and become `releases/vVERSION` only
after health succeeds.



При создании релизов всегда пиши подробный чейнжлог, что и как изменилось или обновилось в версии.

И версионирование учитывай, у нас оно в формате vX.Y.Z где X - крупные продуктовые изменения, Y - средние изменения в рамках имеющегося функционала или небольшие новые функции, Z - мелкие правки, фиксы, не сильно меняющие поведение работы приложения.
