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

The app image runs the bundled agent `.runtime/agent/main.js`. It also contains the authored
`agent/` tree: the agent reads `agent/instructions.md` from it, and the operator's manual `tsx`
commands after a release run from it. The server receives no checkout: the source is confined to the
immutable app image selected by digest.

GitHub Actions uses only the repository `GITHUB_TOKEN`. The workflow grants package, release,
OIDC, and attestation writes only to the release job. This follows GitHub's current guidance for
[automatic token permissions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication),
[publishing to GHCR](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry),
and [container attestations](https://docs.github.com/en/actions/how-tos/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds).

The standalone CLI, installation bundle, `install.sh`, and CLI checksum sidecar are each attested
with `subject-path`. Verify downloaded bootstrap assets before use:

```bash
gh attestation verify install.sh -R nyxandro/osinara
gh attestation verify osinara-linux-x64.sha256 -R nyxandro/osinara
sha256sum --check osinara-linux-x64.sha256
```

The server does not clone the repository and never builds an image. The root-owned systemd timer
runs `/opt/osinara/bin/production-deploy.sh` once per minute. The script takes an exclusive lock,
claims one approved PostgreSQL proposal after rechecking the current owner, and verifies the public
release. Before applying any release rule it makes sure it is the controller that release carries
(see "Self-updating controller"). It then checks the Compose hash, fixed service/image/mount policy,
and digest names, pulls before stopping, backs up existing durable state, starts the released
Compose graph without build, and checks `http://127.0.0.1:8082/v1/health`.

If GitHub loses the canonical `main` push event during an Actions outage, an operator may dispatch
the same `CI and release` workflow manually with `gh workflow run "CI and release" --ref main`.
The manual path still runs the production-equivalent test job first and publishes only from the
current canonical `main` ref; it does not permit a branch build or bypass release validation.

Each non-initial deployment retains the previous restore point until the new PostgreSQL dumps
and durable-volume archives are complete and checksum-verified. Only then does it remove older
rolling copies and the historical initial migration backup, keeping the three most recent verified
release backups. One copy alone is no restore point for damage noticed a day or two late: by then
the only copy holds it too. Three sets cost about 11 GB on the current host. Checksum paths are relative and remain valid after the atomic directory rename. Capacity
preflight must fit both the existing and new copies; insufficient space never triggers early deletion.
After a successful health
check and terminal success record it removes local first-party Osinara image references older than
the current and previous release; this never prunes non-Osinara projects on the same server.

`compose.production.yaml` uses the stable project name `osinara-production`, explicit volume and
network names, a one-shot migration gate, and a loopback-only edge port. Only sandbox-runner owns
the Docker socket. The agent has no Docker socket and reaches the runner only over the internal
control network. Every service uses bounded Docker `json-file` logging (`20m` by `5` files), and
the deployment validator rejects releases that remove this bound.

Fresh installation additionally creates `osinara-production-edge-frontend`. Only the application
`edge` service and the TLS proxy join this frontend network. The proxy never joins
`osinara-production-app-network`, so TLS termination cannot directly address PostgreSQL, the agent,
embedding, workers, or sandbox egress services.

## TLS proxy

Since v0.24.0 the only TLS proxy shipped by Osinara is Traefik, defined once in `infra/traefik/`
(`compose.yaml` and `dynamic/osinara.yaml`). The installer asks how HTTPS is published and records the
answer in `/opt/osinara/tls/.env` as `OSINARA_TLS_MODE`; `osinara status`, `doctor`, `logs`, and
`restart` read that line and refuse a file without it.

| Mode | What the installer does | Preflight |
| --- | --- | --- |
| `managed` | Writes `/opt/osinara/tls/compose.yaml` (Traefik 3, project `osinara-tls`) and starts it after the application. | Ports `80`, `443` and `8082` must be free. |
| `external` | Writes no Compose file and starts no proxy. The operator's existing proxy must publish `https://HOSTNAME` itself. | Port `8082` must be free. The installer briefly answers `127.0.0.1:8082/v1/health` with a random token and requests `https://HOSTNAME/v1/health`: the token proves a host-level proxy forwards end to end; `502`/`503`/`504` is accepted from a containerized proxy whose upstream `edge` does not exist yet; any other answer (`OSINARA_INSTALL_EXTERNAL_PROXY_MISROUTED`) or no answer (`OSINARA_INSTALL_EXTERNAL_PROXY_UNREACHABLE`) fails the install before migration. |

Files under `/opt/osinara/tls/` (all `root:root`):

| Path | Mode | Purpose |
| --- | --- | --- |
| `.env` | `0600` | `OSINARA_HOSTNAME=…` and `OSINARA_TLS_MODE=managed` or `OSINARA_TLS_MODE=external`. |
| `compose.yaml` | `0644` | Traefik project; present only in `managed` mode. |
| `dynamic/` | `0750` | Traefik file-provider directory, watched for changes. |
| `dynamic/osinara.yaml` | `0644` | Osinara router: `Host(HOSTNAME)` → `http://edge:80` with a `/v1/health` health check. The installer substitutes the real hostname, so the file needs no environment. Written in both modes; in `external` mode it is a reference for the operator's own proxy configuration. |

**Sharing the managed Traefik with other projects on the same host.** Add one file per project to
`/opt/osinara/tls/dynamic/` (for example `yana.yaml`) with its own routers, services, and middlewares.
Traefik picks the file up without a restart. Never edit `osinara.yaml`: a future reinstall rewrites it.
Certificates for every hostname are issued by the same `letsencrypt` resolver.

**Publishing Osinara through an external proxy.** Configure the proxy before running the installer.
A proxy running on the host itself (or a container with `network_mode: host`) forwards
`https://HOSTNAME` to `http://127.0.0.1:8082`, the loopback-only edge port. A containerized proxy
instead joins `osinara-production-edge-frontend` after the installation has created it
(`docker network connect osinara-production-edge-frontend PROXY`) and forwards to `http://edge:80`;
the installer waits up to fifteen minutes for public HTTPS in external mode to leave time for that
step. `dynamic/osinara.yaml` is only a reference for that configuration, not a drop-in file: it uses
the entrypoint name `websecure`, the certificate resolver name `letsencrypt`, and the Docker DNS name
`edge`, and `/opt/osinara/tls` is readable by root only. (The repository copy in `infra/traefik/dynamic/`
keeps the `{{ env "OSINARA_HOSTNAME" }}` template for hosts that run Traefik with that variable.) Never bind-mount `/opt/osinara/tls/dynamic` into a foreign proxy before installation: Docker
would create `/opt/osinara` and the installer would refuse with `OSINARA_INSTALL_EXISTING_STATE`.
If the installation ends with `OSINARA_INSTALL_STATE_AMBIGUOUS` because public HTTPS never became
healthy, fix the proxy, confirm `https://HOSTNAME/v1/health`, and finish the Telegram webhook
registration manually with `setWebhook` using the secret token from `/opt/osinara/.env`; the
installer never reruns after its migration marker.

**Hosts installed before v0.24.0 (optional).** Such hosts run Traefik from a single
`/opt/osinara/tls/traefik-dynamic.yaml` and their `tls/.env` lacks `OSINARA_TLS_MODE`. Nothing in the
release touches that proxy: the deploy controller manages only `osinara-production`, and hosts set up
by the root-owned deploy controller alone have no `osinara` CLI. Switching to the directory layout is worthwhile only
when another project is added to the same Traefik or to keep the host aligned with this document.
As root, one time:

```bash
# the server has no repository checkout: take the files from the release asset osinara-installation.tar.gz
tar -xzf osinara-installation.tar.gz -C /tmp installation/traefik-compose.yaml installation/traefik-osinara.yaml
install -d -m 0750 -o root -g root /opt/osinara/tls/dynamic
install -m 0644 -o root -g root /tmp/installation/traefik-osinara.yaml /opt/osinara/tls/dynamic/osinara.yaml
# move every other project's routers/services/middlewares from traefik-dynamic.yaml into dynamic/<project>.yaml
install -m 0644 -o root -g root /tmp/installation/traefik-compose.yaml /opt/osinara/tls/compose.yaml
sed -i -e '$a\' /opt/osinara/tls/.env                       # guarantee a trailing newline first
grep -q '^OSINARA_TLS_MODE=' /opt/osinara/tls/.env || printf 'OSINARA_TLS_MODE=managed\n' >> /opt/osinara/tls/.env
chmod 0600 /opt/osinara/tls/.env
docker compose --env-file /opt/osinara/tls/.env --file /opt/osinara/tls/compose.yaml up -d --wait
curl --fail https://HOSTNAME/v1/health && rm /opt/osinara/tls/traefik-dynamic.yaml*
```

The `osinara-tls-traefik-data` volume (ACME storage) is preserved by that restart; certificates are
not reissued.

## External monitoring

Since v0.25.0 the application publishes two signals for an external observer, and neither is part
of the deployment contract.

`AGENT_SCHEDULE_TICK` is written to the log after every completed cycle of the four periodic
dispatchers. A stopped scheduler raises no error of its own, so the absence of this line is the
only evidence that reminders, scheduled scenarios, memory review or update checks stopped running.

Migration `103_monitoring_views.sql` creates the aggregate-only `monitoring_*` views and the
`osinara_metrics` role, granted SELECT on each of them explicitly and on nothing else. A blanket
grant on the schema was avoided because it would also cover every table added later. The views execute with the
owner's privileges, so the role sees counts and ages while every base table stays closed to it;
`agent/lib/monitoring-views-migration.integration.test.ts` verifies both directions. The role is
created `NOLOGIN`: after the release the operator grants it a password once, as described in
`infra/monitoring/README.md`.

Roles live in the cluster, not in the database, so `pg_dump` does not carry `osinara_metrics` with
it. Restoring the application database into a fresh cluster therefore leaves every
`GRANT … TO osinara_metrics` in the dump failing, and the migration is already recorded in
`schema_migrations`, so the runner will never recreate the role. Create it before the restore:

```bash
psql -c "CREATE ROLE osinara_metrics NOLOGIN"
```

Monitoring is the only thing affected, and its absence is visible as a silent exporter rather than
an error, which is why the step belongs in the restore procedure rather than in the migration.

The collector that reads these signals runs in its own `monitoring-agent` compose project on the
server. It is not a release artifact: `production-deploy.sh` neither knows about it nor restarts
it, the production Compose graph does not reference it, and removing it changes nothing in the
application. `infra/monitoring/` holds only the three files that describe what Osinara exposes.

## Server files

Both kinds of host share one layout and one deployment controller. They differ only in the graph
they run, which `OSINARA_DEPLOYMENT_PROFILE` in `/opt/osinara/.env` names explicitly:

- **`installation`** — hosts set up by `osinara install`. The checksum-bound standalone installer
  runs on clean GNU/Linux x86_64 hosts with glibc and systemd (`osinara-linux-x64` is a glibc
  Node.js SEA executable, so musl-based distributions such as Alpine Linux are not supported). The
  graph is the released production graph without CLIProxy: the controller derives
  `compose.installation.json` from the verified `compose.production.yaml` with
  `scripts/production-deploy/installation-compose.jq`, the same filter CI uses for the installer's
  first copy. The installer writes the files below, places the controller and its units from the
  release app image, starts the stack, and enables the timer. The host is maintained with
  `osinara status`, `doctor`, `logs`, `restart` and `config`; `restart` and `config` take the
  controller's lock and refuse to run while a release is being deployed.
- **`production`** — the host with the CLIProxy subscription gateway. Its first release is
  started by hand (see "First release"); from then on it updates exactly like an installation host.

| Path                                         | Mode   | Purpose                                                          |
| -------------------------------------------- | ------ | ---------------------------------------------------------------- |
| `/opt/osinara/.env`                          | `0600` | Secrets, environment-specific URLs, and `OSINARA_DEPLOYMENT_PROFILE`. |
| `/opt/osinara/agent-model-providers.json`    | `0644` | Active reviewed provider config mounted into the agent.           |
| `/opt/osinara/releases/vX.Y.Z/`              |        | One release: its Compose graph, manifest, and `release.env`.     |
| `/opt/osinara/current`                       | link   | The running release; the controller switches it after health.   |
| `/opt/osinara/release.env`                   | `0600` | Copy of the current release's image references.                  |
| `/opt/osinara/bin/production-deploy.sh`      | `0750` | Launcher: the fixed systemd entrypoint.                          |
| `/opt/osinara/bin/controller/vX.Y.Z/`        | `0750` | One controller version: `main.sh`, modules, the jq filter (`0640`). |
| `/opt/osinara/bin/controller/current`        | link   | The controller version the launcher runs.                        |
| `/etc/systemd/system/osinara-deploy.service` | `0644` | One-shot root service with the EnvironmentFile.                  |
| `/etc/systemd/system/osinara-deploy.timer`   | `0644` | Persistent minute poll.                                          |

`/opt/osinara`, `/opt/osinara/bin`, the controller root, and every controller version directory must
be `root:root 0750`. The launcher accepts only a `current` link that names a version directory and
rejects symlinks or different metadata before it starts `main.sh`; `main.sh` checks its own modules
the same way before sourcing them. The controller creates `/opt/osinara/releases`,
`/opt/osinara/backups`, and the atomic `/opt/osinara/release.env`.

### Self-updating controller

The controller, its launcher, and the systemd units are part of every release: the app image
carries them in `/app/deploy/controller` and `/app/deploy/systemd`. The app image digest is bound by
the approved manifest, so the controller bytes are bound to the release the owner approved.

After claiming a proposal and validating the public release against the approved manifest, the
running controller pulls the release app image, extracts its controller into a staging directory,
and checks that it is a flat set of modules that parse as shell and include `launcher.sh` and
`main.sh`. Then:

- **Identical to the running controller and launcher** — the deployment continues in the same
  process. Most releases take this path.
- **Different** — the new controller is placed as `bin/controller/vX.Y.Z` (the version of the
  release that brought it) and written to disk. Before anything points at it, it runs as
  `main.sh --preflight` and checks this host with its own rules (root, paths, required commands,
  profile, current release); a refusal removes it and fails the proposal with
  `DEPLOY_CONTROLLER_PREFLIGHT_FAILED`. Otherwise `controller/current` and then the launcher are
  switched by rename, and the process is replaced by the launcher with `--resume PROPOSAL LEASE`.
  The new controller keeps the inherited lock, re-reads the claim by its lease token, downloads and
  validates the release again under its own rules, and deploys it. A resumed controller that still
  differs from the release's copy fails with `DEPLOY_CONTROLLER_UPDATE_LOOP` instead of updating
  again.

`main.sh --preflight` and `launcher --resume PROPOSAL LEASE` are how an older controller starts a
newer one, so every controller version keeps accepting both forms
(`production-release-contract.test.ts` pins them).

Nothing has been stopped at that point: a broken or refusing release controller ends the proposal as
`failed` with the current release still running. The one window left is a resumed controller that
cannot even start or take over the inherited lock; its claim is not recorded, and the next tick
marks it `ambiguous` (`DEPLOY_STALE_LEASE_AMBIGUOUS`) once the 60-minute lease expires. A newer
controller stays installed after a failed release; it has to manage the release it upgrades from,
which is the same requirement the controller always had. After a successful release the controller
keeps the selected version and the newest previous one and removes older ones.

Because the release brings its own controller, a release that changes the exact service, image,
mount, port, logging, dependency, or host-capability allowlist needs no manual step on the host.
The systemd units are installed once and are not replaced by releases; a change to them is an
operator step described in that release's notes.

### Moving a host to the self-updating controller (once)

A host whose controller predates self-update (`/opt/osinara/bin/production-deploy/` with modules
next to the entrypoint) cannot install its successor itself. Before approving the first release
that carries the self-updating controller, as root:

```bash
systemctl stop osinara-deploy.timer
# A running deployment is not stopped by stopping the timer; wait until this prints "inactive".
systemctl is-active osinara-deploy.service
# Take the controller from the release app image the approved manifest names.
APP_IMAGE=ghcr.io/nyxandro/osinara-app@sha256:...   # images.app from osinara-deployment.json
VERSION=X.Y.Z                                      # that release
CONTROLLER="/opt/osinara/bin/controller/v${VERSION}"
docker pull "$APP_IMAGE"
install -d -o root -g root -m 0750 /opt/osinara/bin/controller "$CONTROLLER"
docker run --rm --network none --entrypoint /bin/tar "$APP_IMAGE" -c -C /app/deploy/controller . |
  tar -x --no-same-owner -C "$CONTROLLER"
# tar restores the image's directory mode; the launcher accepts exactly 0750 and 0640.
chmod 0750 "$CONTROLLER"
chmod 0640 "$CONTROLLER"/*
ln -s "v${VERSION}" /opt/osinara/bin/controller/current
install -o root -g root -m 0750 "$CONTROLLER/launcher.sh" /opt/osinara/bin/production-deploy.sh
# Append on a line of its own even if the file does not end with a newline.
grep -q '^OSINARA_DEPLOYMENT_PROFILE=' /opt/osinara/.env ||
  printf '\nOSINARA_DEPLOYMENT_PROFILE=production\n' >> /opt/osinara/.env
mv /opt/osinara/bin/production-deploy /opt/osinara/backups/deploy-scripts-before-self-update
stat -c '%U:%G %a %n' /opt/osinara/bin /opt/osinara/bin/controller "$CONTROLLER" "$CONTROLLER"/* \
  /opt/osinara/bin/production-deploy.sh
systemctl start osinara-deploy.timer
```

`stat` must show `root:root` with `750` for the directories and the launcher and `640` for every
file in the version directory. The next minute poll must log `DEPLOY_NO_APPROVED_PROPOSAL`.

The installed tree has to be byte-identical to the controller of the release about to be approved:
the release then deploys without a self-update step. A tree taken from anywhere else would make the
controller try to place its own `v${VERSION}` beside the existing one and fail with
`DEPLOY_CONTROLLER_DIR_EXISTS`, and a version once proposed cannot be proposed again. After this
step every later release updates the controller by itself.

### Memory protection on a shared host

The production host also runs development: the IDE, agent sessions and test runs all live in
`orca-remote-server.service`. At their peaks the kernel reclaimed the bot as readily as the tests,
connections to PostgreSQL missed their five-second window, and three times the database restarted
itself (#253). Two host settings keep the bot's working set in memory. Both are applied with
`systemctl set-property`, which writes a drop-in under `/etc/systemd/system.control/`, takes effect
at once without a restart, and survives a reboot. No release changes them.

```bash
# Development yields first: a soft ceiling (throttles and reclaims, never kills) and a quarter of
# the CPU share of each bot container when both want the processor.
sudo systemctl set-property orca-remote-server.service MemoryHigh=4G CPUWeight=25
# Parent protection for the mem_reservation values in compose.production.yaml (300 + 800 + 900 MB).
sudo systemctl set-property osinara.slice MemoryLow=2000M
```

Every production service runs with `cgroup_parent: osinara.slice`. Docker creates that top-level
slice with the first container; the setting above may be applied before it exists. The slice is
there because cgroup v2 counts a container's `memory.low` only up to what its parent protects, and
with `memory_recursiveprot` a parent's unclaimed protection is shared among its children by usage.
Left in `system.slice`, the bot would need protection on that slice, and whatever the three
services did not use at the moment would go to development beside them. Inside `osinara.slice` the
surplus stays with the bot's other containers.

Sandbox containers that `sandbox-runner` creates through the Docker API stay in `system.slice` on
purpose. They run untrusted commands under their own hard limit (2 GiB each); inside
`osinara.slice` they would draw its surplus protection away from PostgreSQL, the agent and the
embedding service, the more so the heavier an arbitrary command is.

Keep the slice equal to the sum of the reservations: less cuts every reservation proportionally,
and `compose-runtime.test.ts` fails when the sum and this command disagree. `memory.low` shows only
the configured value; protection actually used shows up as the `low` counter in each container's
`memory.events`, which grows when the kernel had to reclaim protected memory after all.

The ceiling covers only what runs inside `orca-remote-server.service`. Test stacks such as
`compose.test.yaml` and `docker build` run under Docker's own units in `system.slice`, outside it:
bring test stacks up only for a run and take them down afterwards. The disk scheduler here is
`mq-deadline`, which ignores I/O weights, so there is no I/O counterpart.

`/opt/osinara/.env` must be exactly `root:root 0600`. It contains `OSINARA_DEPLOYMENT_PROFILE`
(`production` or `installation`, read only by the controller), `MODEL_API_KEY`,
`POSTGRES_PASSWORD`, the required internal application `DATABASE_URL`, `CLI_PROXY_API_KEY`,
`GROQ_API_KEY`, the optional `ELEVENLABS_API_KEY`,
Telegram secrets, and environment-specific integration
settings. It must never contain or export any of the six `OSINARA_*_IMAGE` variables or
`SANDBOX_RUNTIME_IMAGE`; those values exist only in a validated per-release `release.env`.

Active model selection uses schema v4 at `/opt/osinara/agent-model-providers.json`: it selects a
protocol-native transport, explicit output and context limits, and a discriminated image-input
capability. A supported vision route requires its own model ID and output limit; an unsupported route
cannot construct a fake vision model.

The v0.16.0 production route uses `gpt-5.6-luna` through CLIProxyAPI `v7.2.137` and OpenAI Chat
Completions; its reviewed model config is `config/codex-subscription-model-providers.json`.
The agent sends `reasoning_effort=medium` to the internal
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

Interactive root turns may call the application-owned `send_voice_message` boundary when the current
message explicitly asks for a voice reply. It synthesizes one ElevenLabs `eleven_v4` Ogg Opus note
with the pinned voice, reserves the call in `voice_message_operations` before the billable request,
never retries an ambiguous result, stores the audio in the authorized workspace, and sends it through
the exact-once workspace file delivery as a Telegram voice note. The optional `ELEVENLABS_API_KEY`
only authenticates the calls: without it the tool stays visible and every call fails with
`AGENT_VOICE_MESSAGE_CONFIG_MISSING`, after which the agent answers in text. The pinned voice is an
ElevenLabs library voice, which the API serves only on a paid ElevenLabs plan. External groups
receive the capability only through an owner grant; scheduled turns and subagents never receive it.

The standalone fresh installer removes CLIProxy from its generated Compose and stays on the
selected direct provider.

Long-term memory has no separate model route. The root agent decides whether to call `remember`;
PostgreSQL validates the current Telegram source and atomically writes optional thread state. Thread
activation and context use local E5 embeddings plus deterministic source projections. Semantic
extraction, relation/thread classifiers, and LLM-generated briefs are not part of the runtime.

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

A proposal the controller rejected remains terminal. Do not reset, clone, or reapprove it: publish
a strictly newer patch release and require a new owner approval. This preserves the audit trail and
the no-ambiguous-retry contract.

The server host requires Docker Engine with Compose v2, systemd, `curl`, `jq`, `flock`, `stat`,
`sha256sum`, `tar`, and standard GNU file utilities. Missing tools are deployment errors; the
script does not download utilities or substitute alternate commands at runtime. `osinara install`
checks the same list before it changes anything.

All six GHCR packages must be publicly pullable, or Docker on the server must already be logged in
with read-only package access. The release workflow itself never receives a custom registry secret.

## First release

Installation hosts never use this mode: `osinara install` performs their first release. A
`production` host is set up by hand. Place the controller from the release app image as in "Moving a
host to the self-updating controller" (without moving an old module directory), install the two
units from `/app/deploy/systemd` into `/etc/systemd/system`, and create `/opt/osinara/.env` with
`OSINARA_DEPLOYMENT_PROFILE=production`.

The first release cannot be selected from PostgreSQL because `software_update_proposals` does not
exist before migrations. Run the server script once as root with `--initial VERSION`. The argument accepts only stable `X.Y.Z`.
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

## Memory reindex after an embedding change

Migrations never recompute embeddings, and a record keeps the vector it was indexed with. When a
release changes what goes into a vector — the text of a chunk, its size, or the header in front of
it — the stored vectors describe the previous rules, and until they are recomputed the semantic
branch finds those records by the old text. Nothing fails and nothing is logged; searches quietly
return less.

Releases carrying such a change say so in `docs/releases/vVERSION.md`. After the deployment reports
healthy, run once inside the running agent container:

```bash
docker exec osinara-production-agent-1 node /app/.runtime/scripts/reindex-memory.js
```

It re-queues every active record for the indexing worker; on the current corpus this takes about
half an hour, and `osinara_memory_index_state` returns to `indexed` for all of them when it is done.

The command runs the compiled operator script, the same way `memory-review-admin.js` is run. It is
**not** `npm run memory:reindex`: the image contains `agent/`, `config/` and `migrations/`, but no
`scripts/` directory, so the npm script resolves to a file that is not there. Earlier releases
documented the npm form and it never worked; the compiled script ships from v0.27.1 onward, and the
reindex for v0.27.0 itself was performed by running the same logic through `tsx` against
`/app/agent/lib`.

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
verifies those durable volumes and free space, and writes and validates a logical dump of the
application database. It then stops application writers, archives `cli-proxy-auth`,
`google-workspace-credentials`, `tool-environments` and `workspace-data`, and validates every
artifact. A current-owned durable volume missing from the candidate is forbidden. A missing
current-owned volume or a pre-existing candidate-only volume fails closed, so deploy never creates
an empty replacement for active data or silently reuses bytes of unknown provenance. The
reconstructible embedding model volume is omitted.
Candidate release files remain in a unique temporary directory and become `releases/vVERSION` only
after health succeeds.

One agent process works on the application database at a time: it holds a PostgreSQL advisory lock
on a connection of its own for as long as it runs. A second agent started against the same database
exits at once with `AGENT_RUNTIME_ALREADY_RUNNING`. PostgreSQL frees the lock when the holder's
connection ends, so a killed or stopped agent never blocks the next one. An agent whose lock
connection was cut takes the lock again at once; if another agent took it meanwhile, it exits with
code 1 (`AGENT_RUNTIME_SECOND_PROCESS`) and leaves the turns to that agent.



При создании релизов всегда пиши подробный чейнжлог, что и как изменилось или обновилось в версии.

И версионирование учитывай, у нас оно в формате vX.Y.Z где X - крупные продуктовые изменения, Y - средние изменения в рамках имеющегося функционала или небольшие новые функции, Z - мелкие правки, фиксы, не сильно меняющие поведение работы приложения.
