# Production deployment

## Architecture

GitHub-hosted CI runs the complete `compose.test.yaml` suite for pull requests and pushes to
`develop` or `main`. A successful `main` run requires a new stable version in `package.json`,
builds six container-only images, publishes immutable tags to GHCR, records image and file artifact attestations,
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
- `agent-model-providers.json` is the exact reviewed v0.15.2 direct-provider bridge config;
- `codex-subscription-model-providers.json` is the exact reviewed v0.16.0 production cutover config.
  Both release assets are independently attested and checked against pinned SHA-256 values before
  installation by their release-specific bridges.

The app image contains the authored `agent/` tree because Eve `0.32.0` bundles those modules
when `eve start` serves the built `.output`. The server receives no checkout: the source is confined
to the immutable app image selected by digest.

GitHub Actions uses only the repository `GITHUB_TOKEN`. The workflow grants package, release,
OIDC, and attestation writes only to the release job. This follows GitHub's current guidance for
[automatic token permissions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication),
[publishing to GHCR](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry),
and [container attestations](https://docs.github.com/en/actions/how-tos/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds).

The standalone CLI, installation bundle, `install.sh`, CLI checksum sidecar, and bridge model config
are each attested with `subject-path`. Verify downloaded bootstrap assets before use:

```bash
gh attestation verify install.sh -R nyxandro/osinara
gh attestation verify osinara-linux-x64.sha256 -R nyxandro/osinara
sha256sum --check osinara-linux-x64.sha256
```

The server does not clone the repository and never builds an image. The root-owned systemd timer
runs `/opt/osinara/bin/production-deploy.sh` once per minute. The script takes an exclusive lock,
claims one approved PostgreSQL proposal after rechecking the current owner, verifies the public
release, Compose hash, fixed service/image/mount policy, and digest names. It pulls before stopping,
backs up existing durable state, starts the released Compose graph without build, and checks
`http://127.0.0.1:8082/eve/v1/health`.

If GitHub loses the canonical `main` push event during an Actions outage, an operator may dispatch
the same `CI and release` workflow manually with `gh workflow run "CI and release" --ref main`.
The manual path still runs the production-equivalent test job first and publishes only from the
current canonical `main` ref; it does not permit a branch build or bypass release validation.

Before each non-initial deployment it also prunes older Osinara deployment backups. The rolling
snapshot supersedes and removes the historical initial migration backup while clearing the
timestamped slot for the pending snapshot; after successful backup creation exactly one
previous-release backup remains. After a successful health
check and terminal success record it removes local first-party Osinara image references older than
the current and previous release; this never prunes non-Osinara projects on the same server.

`compose.production.yaml` uses the stable project name `osinara-production`, explicit volume and
network names, a one-shot migration gate, and a loopback-only edge port. Only sandbox-runner owns
the Docker socket. The agent has no Docker socket and reaches the runner only over the internal
control network. Every service uses bounded Docker `json-file` logging (`20m` by `5` files), and
the deployment validator rejects releases that remove this bound.

Fresh installation additionally creates `osinara-production-edge-frontend`. Only the application
`edge` service and the separate Caddy project join this frontend network. Caddy never joins
`osinara-production-app-network`, so TLS termination cannot directly address PostgreSQL, the agent,
embedding, workers, or sandbox egress services.

Eve `0.32.0` mounts its local world at `/app/.eve/.workflow-data` from the logical
`eve-workflow-data` volume. Its physical production name is
`osinara-production-eve-workflow-data-v032`; the incompatible legacy
`osinara-production-workflow-data` volume is never mounted by the new release. During the one-time
cutover it is retained through archive validation and candidate health, then removed after promotion.

## Server files

Release `v0.15.2` adds a checksum-bound standalone installer for clean GNU/Linux x86_64 hosts using
glibc. The current `osinara-linux-x64` is a glibc Node.js SEA executable and does not support
musl-based distributions such as Alpine Linux. Existing
production upgrades still use the root-owned bridge controller below. Fresh installations do not
receive the five-image update controller until the planned cutover release; do not copy the legacy
six-image controller into the fresh layout. Existing bridge servers prepare these root-owned files:


| Path                                         | Mode   | Purpose                                                          |
| -------------------------------------------- | ------ | ---------------------------------------------------------------- |
| `/opt/osinara/.env`                          | `0600` | Production secrets and environment-specific URLs.                |
| `/opt/osinara/agent-model-providers.json`    | `0644` | Active reviewed provider config mounted into the agent.           |
| `/opt/osinara/codex-auth.json`               | `0600` | One-time root-owned OpenCode OAuth seed removed after cutover.    |
| `/opt/osinara/bin/production-deploy.sh`      | `0750` | Server deployment entrypoint.                                    |
| `/opt/osinara/bin/production-deploy/`        | `0750` | Root-owned deployment module directory.                          |
| `/opt/osinara/bin/production-deploy/*.sh`    | `0640` | Fixed source modules checked before execution.                   |
| `/etc/systemd/system/osinara-deploy.service` | `0644` | One-shot root service with the EnvironmentFile.                  |
| `/etc/systemd/system/osinara-deploy.timer`   | `0644` | Persistent minute poll.                                          |


`/opt/osinara`, `/opt/osinara/bin`, and the module directory must be `root:root 0750`; the
entrypoint must be `root:root 0750`. The script rejects symlinks or different metadata before it
sources a module. It creates `/opt/osinara/releases`, `/opt/osinara/backups`, and the atomic
`/opt/osinara/release.env`.

`/opt/osinara/.env` must be exactly `root:root 0600`. Before v0.15.2 it contains the required
`DEEPSEEK_API_KEY`; during the v0.15.2 bridge it gains `MODEL_API_KEY` with the exact same credential
token while retaining `DEEPSEEK_API_KEY` for the rollback window. It also contains
`POSTGRES_PASSWORD`, the required internal application `DATABASE_URL`, `CLI_PROXY_API_KEY`,
`GROQ_API_KEY`,
Telegram secrets, and environment-specific integration
settings. It must never contain or export any of the six `OSINARA_*_IMAGE` variables or
`SANDBOX_RUNTIME_IMAGE`; those values exist only in a validated per-release `release.env`.

The one-time bridge runs only for an owner-approved transition from exact v0.15.1 to v0.15.2. The
root controller first claims the approved proposal, verifies immutable GitHub release metadata,
manifest, tag commit and Compose hash, then repeats the current-owner check. Before the first
candidate `docker compose config`, it downloads `agent-model-providers.json`, verifies its pinned
SHA-256, installs it atomically as `root:root 0644`, and atomically appends `MODEL_API_KEY` derived
from the single validated `DEEPSEEK_API_KEY` assignment. It never removes or rewrites the legacy
assignment. Existing `MODEL_API_KEY` or config bytes are accepted only when they match exactly;
duplicates, unsupported dotenv syntax, another source version, or conflicting bytes fail closed.
This makes a pre-migration retry idempotent without inventing a model, endpoint, or credential.

Active model selection uses schema v4 at `/opt/osinara/agent-model-providers.json`: it selects a
protocol-native transport, explicit output and context limits, and a discriminated image-input
capability. A supported vision route requires its own model ID and output limit; an unsupported route
cannot construct a fake vision model.

The v0.16.0 production route uses `gpt-5.6-luna` through CLIProxyAPI `v7.2.137` and OpenAI Chat
Completions. The agent sends `reasoning_effort=medium` to the internal
`http://cli-proxy-api:8317/v1` boundary, caps one response at 128,000 tokens, and declares the
provider catalog's 372,000-token context. Text, image input, and tool calls use the same selected
model. `MODEL_API_KEY` is only the internal bearer and exactly matches `CLI_PROXY_API_KEY`; OpenCode
OAuth remains inside `osinara-production-cli-proxy-auth` and is writable only by CLIProxy uid 10001
so refreshed access and refresh tokens survive container replacement.

With this provider active, interactive root turns may call the application-owned `generate_image`
boundary for exactly one `gpt-image-2` WebP. The agent reserves the call in PostgreSQL before the
billable request, never retries an ambiguous transport or provider result, stores confirmed bytes in
the authorized workspace, and uses the existing exact-once Telegram file delivery. External groups
receive the capability only after the owner changes the complete group policy from the private chat;
scheduled turns and subagents never receive it. Under any other model provider the tool, its
`imagegen` skill, and its owner grant all disappear: `manage_telegram_group` rejects the capability
instead of persisting an inert grant, and a grant made while Codex was active is reported as
`unavailableConfiguredTools` until the provider is restored. CLIProxy is configured with
`disable-image-generation: chat`: `/v1/images/*` remains available to the controlled application
client, while CLIProxy cannot inject its own hidden image tool into ordinary model calls.

The one-time v0.16.0 bridge accepts only exact v0.15.14 source state. Before migration it validates
the root-owned OAuth seed, the exact production NeuralDeep `qwen3.8-27b` config hash, the required
model/proxy assignments and retained DeepSeek rollback credential, and
the attested Codex config. Backup preflight creates the candidate-only auth volume; after writers are
stopped and durable state is archived, the controller crosses `MIGRATION_STARTED`, seeds the empty
volume, atomically installs the new model config, and replaces only `MODEL_API_KEY` with the existing
internal proxy key. Candidate health requires both CLIProxy `/v1/models` and the agent. After
promotion the root seed is removed; later releases archive the auth volume with other durable state.
An explicit root-controller `--initial 0.16.0` deployment requires the same staged seed. It validates
the initial direct-provider config and model/proxy assignments, creates an absent candidate volume,
sets its root to `10001:10001 0700`, then follows the same irreversible provision and smoke boundary.
The standalone fresh installer still removes CLIProxy from its generated Compose and stays on the
selected direct provider, so it does not require this production-only OAuth seed.

Long-term memory has no separate model route. The root Eve agent decides whether to call `remember`;
PostgreSQL validates the current Telegram source and atomically writes optional thread state. Thread
activation and context use local E5 embeddings plus deterministic source projections. Semantic
extraction, relation/thread classifiers, and LLM-generated briefs are not part of the runtime.

`memory-extraction-worker` remains in the production Compose graph only because the installed schema-v1
controller requires that service, image slot, migration dependency, and health command. Its current
entrypoint is an idle no-op with `network_mode: none`, no environment, and no mounts; it publishes
readiness without database, embedding, or model calls. Removing the service requires a separate
two-phase controller migration; do not combine it with an ordinary application release.

The retained MiniMax alternative transport explicitly enables a narrow web-search adapter because
MiniMax returns
`content` where the Anthropic SDK requires `encrypted_content`, but rejects its own native
`server_tool_use` / `web_search_tool_result` blocks when they are replayed. Responses retain the
exact result value for SDK parsing; history converts each matched provider pair into an ordinary
`tool_use` / `tool_result` exchange so later model steps remain valid. Remove this adapter only when
MiniMax emits the Anthropic field and accepts native provider-tool history, or when the AI SDK
supports the complete MiniMax dialect natively.

The `cli-proxy-api` service is an active internal subscription gateway. Management routes, plugins,
request retries, cooldown scheduling, and file logging are disabled; the service is reachable only on
the application network and requires the internal bearer. Its startup fails closed when the persistent
volume contains no complete `0600` Codex OAuth credential. The agent starts only after gateway health.

Any release that changes the exact production service, image, mount, port, logging, dependency, or
host-capability allowlist is also a two-phase controller migration. After canonical merge and before
owner approval, stop only `osinara-deploy.timer`, compare the installed root-owned controller modules,
including release-specific bridges,
with the exact canonical release commit, and atomically install only the changed modules. Verify the
source checksum, shell syntax, `root:root` ownership, required `0750`/`0640` modes, then restart the
timer. The running application and database remain untouched during this controller phase. Only
afterward may the owner approve the application release in the bound private Telegram chat.

If the old controller has already rejected an immutable release, its proposal remains terminal. Do
not reset, clone, or reapprove it: publish a strictly newer patch release and require a new owner
approval. This preserves the audit trail and the no-ambiguous-retry contract.

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

An absent candidate-only durable volume is recorded when this deployment attempt creates it. On a
pre-migration failure the controller first restores and validates the current release, then removes
only those exact recorded volumes; a failed removal makes the result `ambiguous`. No candidate volume
is removed after migration starts, and pre-existing candidate-only bytes remain a fail-closed error.

Before every non-initial update the script derives the backup set from the current immutable Compose,
verifies those durable volumes and free space, writes and
validates a logical PostgreSQL dump, stops application writers, archives
`google-workspace-credentials`, `tool-environments`, the current Eve workflow store, and
`workspace-data`, then validates each archive. On the one-time Eve `0.32.0` cutover this archives
`osinara-production-workflow-data` before candidate writers start and creates the absent versioned
Eve `0.32` volume. After the candidate is healthy and promoted, the controller removes that exact
archived legacy volume; failure is terminally ambiguous. The single rolling pre-migration archive
remains available under the normal backup policy. Later backups select the new active volume instead.
Any other current-owned durable volume missing from the candidate is forbidden. A missing
current-owned volume or a pre-existing candidate-only volume fails closed, so deploy never creates
an empty replacement for active data or silently reuses bytes of unknown provenance. Reconstructible
embedding model and sandbox cache volumes are omitted.
Candidate release files remain in a unique temporary directory and become `releases/vVERSION` only
after health succeeds.



При создании релизов всегда пиши подробный чейнжлог, что и как изменилось или обновилось в версии.

И версионирование учитывай, у нас оно в формате vX.Y.Z где X - крупные продуктовые изменения, Y - средние изменения в рамках имеющегося функционала или небольшие новые функции, Z - мелкие правки, фиксы, не сильно меняющие поведение работы приложения.
