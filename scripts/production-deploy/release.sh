#!/bin/bash
# Canonical GitHub release, manifest, and resolved Compose validation.
# Binds exact Compose bytes and image digests before any released configuration reaches Docker.

readonly GITHUB_REPOSITORY="nyxandro/osinara"
readonly GITHUB_API="https://api.github.com/repos/${GITHUB_REPOSITORY}"
readonly GITHUB_RELEASES="https://github.com/${GITHUB_REPOSITORY}/releases/download"
readonly APP_IMAGE_PREFIX="ghcr.io/nyxandro/osinara-app@sha256:"
readonly EDGE_IMAGE_PREFIX="ghcr.io/nyxandro/osinara-edge@sha256:"
readonly EGRESS_IMAGE_PREFIX="ghcr.io/nyxandro/osinara-sandbox-egress-proxy@sha256:"
readonly RUNNER_IMAGE_PREFIX="ghcr.io/nyxandro/osinara-sandbox-runner@sha256:"
readonly RUNTIME_IMAGE_PREFIX="ghcr.io/nyxandro/osinara-sandbox-runtime@sha256:"
readonly POSTGRES_IMAGE="pgvector/pgvector:pg17@sha256:d2ef61f42ef767baa5a1475393303cc235bcd92febd9d7014eddb48b41f3bad0"
readonly TEI_IMAGE="ghcr.io/huggingface/text-embeddings-inference:cpu-1.9@sha256:ad950d30878eceb72aaf32024d26fa2b1d04a75304fa0b4776b49aa1941fea07"

curl_github() {
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --connect-timeout 10 --max-time 60 \
    --header 'Accept: application/vnd.github+json' \
    --header 'X-GitHub-Api-Version: 2022-11-28' \
    --header 'User-Agent: osinara-production-deploy/1' "$@"
}

require_image_ref() {
  local value="$1"
  local prefix="$2"
  local digest="${value#"$prefix"}"
  [[ "$value" == "$prefix"* && "$digest" =~ ^[0-9a-f]{64}$ ]] ||
    fail "DEPLOY_IMAGE_REFERENCE_INVALID" "Manifest contains an unexpected image reference"
}

validate_manifest() {
  local manifest="$1"
  local version="$2"
  jq -e --arg version "$version" '
    type == "object" and
    keys == ["commitSha", "composeSha256", "images", "schemaVersion", "version"] and
    .schemaVersion == 1 and .version == $version and
    (.commitSha | test("^[0-9a-f]{40}$")) and
    (.composeSha256 | test("^[0-9a-f]{64}$")) and
    (.images | type == "object" and
      keys == ["app", "edge", "sandboxEgressProxy", "sandboxRunner", "sandboxRuntime"])
  ' "$manifest" >/dev/null || fail "DEPLOY_MANIFEST_INVALID" "Deployment manifest schema is invalid"

  MANIFEST_COMMIT="$(jq -er '.commitSha' "$manifest")"
  MANIFEST_COMPOSE_SHA="$(jq -er '.composeSha256' "$manifest")"
  APP_IMAGE="$(jq -er '.images.app' "$manifest")"
  EDGE_IMAGE="$(jq -er '.images.edge' "$manifest")"
  EGRESS_IMAGE="$(jq -er '.images.sandboxEgressProxy' "$manifest")"
  RUNNER_IMAGE="$(jq -er '.images.sandboxRunner' "$manifest")"
  RUNTIME_IMAGE="$(jq -er '.images.sandboxRuntime' "$manifest")"
  require_image_ref "$APP_IMAGE" "$APP_IMAGE_PREFIX"
  require_image_ref "$EDGE_IMAGE" "$EDGE_IMAGE_PREFIX"
  require_image_ref "$EGRESS_IMAGE" "$EGRESS_IMAGE_PREFIX"
  require_image_ref "$RUNNER_IMAGE" "$RUNNER_IMAGE_PREFIX"
  require_image_ref "$RUNTIME_IMAGE" "$RUNTIME_IMAGE_PREFIX"

  if [[ "$INITIAL_MODE" -eq 0 ]] && {
    [[ "$STORED_VERSION" != "$version" || "$STORED_COMMIT" != "$MANIFEST_COMMIT" ||
       "$STORED_COMPOSE_SHA" != "$MANIFEST_COMPOSE_SHA" || "$STORED_APP" != "$APP_IMAGE" ||
       "$STORED_EDGE" != "$EDGE_IMAGE" || "$STORED_EGRESS" != "$EGRESS_IMAGE" ||
       "$STORED_RUNNER" != "$RUNNER_IMAGE" || "$STORED_RUNTIME" != "$RUNTIME_IMAGE" ]];
  }; then
    fail "DEPLOY_APPROVED_MANIFEST_MISMATCH" "Public manifest differs from approved bytes"
  fi
}

verify_compose_hash() {
  local compose="$1"
  printf '%s  %s\n' "$MANIFEST_COMPOSE_SHA" "$compose" |
    sha256sum --check --status - ||
    fail "DEPLOY_COMPOSE_HASH_MISMATCH" "compose.production.yaml does not match composeSha256"
}

download_and_validate_release() {
  local version="$1"
  local tag="v${version}"
  local release_json="${WORK_DIR}/release.json"
  local ref_json="${WORK_DIR}/tag-ref.json"
  local tag_json="${WORK_DIR}/tag.json"
  local manifest="${WORK_DIR}/osinara-deployment.json"
  local compose="${WORK_DIR}/compose.production.yaml"

  curl_github --output "$release_json" "${GITHUB_API}/releases/tags/${tag}"
  jq -e --arg tag "$tag" --arg base "${GITHUB_RELEASES}/${tag}" '
    .tag_name == $tag and .immutable == true and .draft == false and .prerelease == false and
    ([.assets[] | select(.name == "osinara-deployment.json" and
      .browser_download_url == ($base + "/osinara-deployment.json"))] | length == 1) and
    ([.assets[] | select(.name == "compose.production.yaml" and
      .browser_download_url == ($base + "/compose.production.yaml"))] | length == 1)
  ' "$release_json" >/dev/null ||
    fail "DEPLOY_RELEASE_METADATA_INVALID" "Public release metadata is invalid"
  curl_github --output "$manifest" "${GITHUB_RELEASES}/${tag}/osinara-deployment.json"
  curl_github --output "$compose" "${GITHUB_RELEASES}/${tag}/compose.production.yaml"
  validate_manifest "$manifest" "$version"
  verify_compose_hash "$compose"

  curl_github --output "$ref_json" "${GITHUB_API}/git/ref/tags/${tag}"
  local object_type object_sha
  object_type="$(jq -er '.object.type' "$ref_json")"
  object_sha="$(jq -er '.object.sha' "$ref_json")"
  if [[ "$object_type" == "tag" ]]; then
    curl_github --output "$tag_json" "${GITHUB_API}/git/tags/${object_sha}"
    object_type="$(jq -er '.object.type' "$tag_json")"
    object_sha="$(jq -er '.object.sha' "$tag_json")"
  fi
  [[ "$object_type" == "commit" && "$object_sha" == "$MANIFEST_COMMIT" ]] ||
    fail "DEPLOY_RELEASE_COMMIT_MISMATCH" "Release tag does not match manifest.commitSha"
}

require_upgrade_from_current() {
  local current_version
  current_version="$(jq -er '.version' "${CURRENT_LINK}/osinara-deployment.json")"
  require_semver "$current_version"
  version_is_greater "$REQUESTED_VERSION" "$current_version" ||
    fail "DEPLOY_DOWNGRADE_FORBIDDEN" \
      "Requested version ${REQUESTED_VERSION} is not newer than ${current_version}"
}

prepare_candidate_release() {
  [[ ! -e "${RELEASES_DIR}/v${REQUESTED_VERSION}" ]] ||
    fail "DEPLOY_RELEASE_DIR_EXISTS" "Final release directory already exists"
  CANDIDATE_DIR="$(mktemp -d "${WORK_DIR}/candidate.XXXXXX")"
  install -m 0644 "${WORK_DIR}/compose.production.yaml" "${CANDIDATE_DIR}/compose.production.yaml"
  install -m 0644 "${WORK_DIR}/osinara-deployment.json" \
    "${CANDIDATE_DIR}/osinara-deployment.json"
  CANDIDATE_COMPOSE="${CANDIDATE_DIR}/compose.production.yaml"
  CANDIDATE_ENV="${CANDIDATE_DIR}/release.env"
  {
    printf 'OSINARA_APP_IMAGE=%s\n' "$APP_IMAGE"
    printf 'SANDBOX_RUNTIME_IMAGE=%s\n' "$RUNTIME_IMAGE"
    printf 'OSINARA_SANDBOX_RUNNER_IMAGE=%s\n' "$RUNNER_IMAGE"
    printf 'OSINARA_SANDBOX_EGRESS_PROXY_IMAGE=%s\n' "$EGRESS_IMAGE"
    printf 'OSINARA_EDGE_IMAGE=%s\n' "$EDGE_IMAGE"
  } > "$CANDIDATE_ENV"
  chmod 0600 "$CANDIDATE_ENV"
  validate_resolved_compose
}

validate_resolved_compose() {
  local images_file="${WORK_DIR}/resolved-images.txt"
  local expected_images_file="${WORK_DIR}/expected-images.txt"
  local config_json="${WORK_DIR}/resolved-compose.json"
  compose_candidate config --images | LC_ALL=C sort > "$images_file"
  printf '%s\n' "$APP_IMAGE" "$APP_IMAGE" "$APP_IMAGE" "$APP_IMAGE" \
    "$RUNTIME_IMAGE" "$RUNNER_IMAGE" "$EGRESS_IMAGE" "$EDGE_IMAGE" \
    "$POSTGRES_IMAGE" "$TEI_IMAGE" | LC_ALL=C sort > "$expected_images_file"
  cmp --silent "$images_file" "$expected_images_file" ||
    fail "DEPLOY_COMPOSE_IMAGE_SET_INVALID" "Resolved Compose image multiset is not approved"

  compose_candidate config --format json > "$config_json"
  jq -e '
    (.services | keys) == [
      "agent", "edge", "memory-embedding", "memory-embedding-worker", "migrate", "postgres",
      "sandbox-egress-proxy", "sandbox-runner", "sandbox-runtime-image", "telegram-ingress-worker"
    ] and
    .services.agent.depends_on.migrate.condition == "service_completed_successfully"
  ' "$config_json" >/dev/null ||
    fail "DEPLOY_COMPOSE_SERVICE_SET_INVALID" "Resolved Compose service set is not approved"
  jq -e '
    all(.services[]; (.privileged // false) == false) and
    all(.services[]; (.network_mode // "") != "host") and
    all(.services[]; (.pid // "") != "host") and
    all(.services[]; (.ipc // "") != "host") and
    all(.services[]; (has("build") or has("devices") or has("cap_add")) | not) and
    ([.services | to_entries[] as $service |
      ($service.value.volumes // [])[] |
      {service: $service.key, type, source, target}] | sort_by(.service, .target)) == ([
        {service: "agent", type: "volume", source: "sandbox-data", target: "/app/.eve/sandbox-cache"},
        {service: "agent", type: "volume", source: "workflow-data", target: "/app/.workflow-data"},
        {service: "agent", type: "volume", source: "workspace-data", target: "/app/workspaces"},
        {service: "memory-embedding", type: "volume", source: "memory-embedding-model-e5", target: "/data"},
        {service: "postgres", type: "volume", source: "postgres-data", target: "/var/lib/postgresql/data"},
        {service: "sandbox-runner", type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock"},
        {service: "sandbox-runner", type: "volume", source: "tool-environments", target: "/runner/tools"},
        {service: "sandbox-runner", type: "volume", source: "workspace-data", target: "/runner/workspaces"}
      ] | sort_by(.service, .target)) and
    ([.services | to_entries[] as $service | ($service.value.ports // [])[] |
      {service: $service.key, host_ip, published, target}] == [{
        service: "edge", host_ip: "127.0.0.1", published: "8082", target: 80
      }])
  ' "$config_json" >/dev/null ||
    fail "DEPLOY_COMPOSE_SECURITY_INVALID" "Resolved Compose enables an unsafe host capability"
}

pull_release_images() {
  docker pull "$APP_IMAGE"
  docker pull "$RUNTIME_IMAGE"
  docker pull "$RUNNER_IMAGE"
  docker pull "$EGRESS_IMAGE"
  docker pull "$EDGE_IMAGE"
  compose_candidate pull --quiet
}

start_candidate_release() {
  compose_candidate up --detach --remove-orphans --no-build --wait --wait-timeout 600
}

promote_candidate_release() {
  local final_dir="${RELEASES_DIR}/v${REQUESTED_VERSION}"
  local temporary_link="${BASE_DIR}/.current.tmp.$$"
  local temporary_env="${BASE_DIR}/.release.env.tmp.$$"
  [[ ! -e "$final_dir" ]] ||
    fail "DEPLOY_RELEASE_DIR_EXISTS" "Final release directory already exists"
  mv "$CANDIDATE_DIR" "$final_dir"
  CANDIDATE_DIR="$final_dir"
  CANDIDATE_COMPOSE="${final_dir}/compose.production.yaml"
  CANDIDATE_ENV="${final_dir}/release.env"
  ln -s "$final_dir" "$temporary_link"
  mv -Tf "$temporary_link" "$CURRENT_LINK"
  install -m 0600 "$CANDIDATE_ENV" "$temporary_env"
  mv -f "$temporary_env" "$GLOBAL_RELEASE_ENV"
  CURRENT_COMPOSE="$CANDIDATE_COMPOSE"
  CURRENT_ENV="$CANDIDATE_ENV"
}
