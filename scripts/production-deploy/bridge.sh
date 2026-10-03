#!/bin/bash
# One-time owner-approved production contract bridges.
# Keeps release-specific credential and config migrations explicit, exact, and non-retryable.

readonly V0152_BRIDGE_SOURCE_VERSION="0.15.1"
readonly V0152_BRIDGE_TARGET_VERSION="0.15.2"
readonly V0152_MODEL_CONFIG_SHA256="4125a909ad3a2cfab08df5158538d210e2bcb753b3faa3a79f7be8a81bcf55c8"
readonly V0160_BRIDGE_SOURCE_VERSION="0.15.14"
readonly V0160_BRIDGE_TARGET_VERSION="0.16.0"
readonly V0160_UPDATE_SOURCE_MODEL_CONFIG_SHA256="3ebc69be3aec08cae7a08ce4024b6b8d8a00a797819a787aed391b8ee30937dd"
readonly V0160_INITIAL_SOURCE_MODEL_CONFIG_SHA256="4125a909ad3a2cfab08df5158538d210e2bcb753b3faa3a79f7be8a81bcf55c8"
readonly V0160_CODEX_MODEL_CONFIG_SHA256="68b349485a474c4426adb7f98b541d812fb6edaa7617010a0e8e942d94fa16b7"
readonly V0160_BRIDGE_CODEX_MODEL_CONFIG_ASSET="codex-subscription-model-providers.json"
readonly CODEX_AUTH_SEED="${BASE_DIR}/codex-auth.json"
readonly CODEX_AUTH_VOLUME="osinara-production-cli-proxy-auth"

validate_bridge_credential_assignment() {
  local value="$1"
  if [[ "$value" =~ ^\'[^\'[:space:]]+\'$ || "$value" =~ ^[^\'\"#[:space:]]+$ ]]; then
    return 0
  fi
  fail "DEPLOY_V0152_MODEL_KEY_INVALID" \
    "Legacy DeepSeek credential is empty or uses unsupported dotenv syntax"
}

read_bridge_credentials() {
  local line name value
  local legacy_count=0
  local model_count=0
  BRIDGE_LEGACY_VALUE=""
  BRIDGE_MODEL_VALUE=""

  # Parse only exact credential assignments; never source or evaluate secret-bearing dotenv bytes.
  while IFS= read -r line || [[ -n "$line" ]]; do
    name="${line%%=*}"
    value="${line#*=}"
    case "$name" in
      DEEPSEEK_API_KEY)
        legacy_count=$((legacy_count + 1))
        BRIDGE_LEGACY_VALUE="$value"
        ;;
      MODEL_API_KEY)
        model_count=$((model_count + 1))
        BRIDGE_MODEL_VALUE="$value"
        ;;
    esac
  done < "$SERVER_ENV"

  [[ "$legacy_count" -eq 1 ]] ||
    fail "DEPLOY_V0152_LEGACY_KEY_INVALID" \
      "v0.15.1 environment must contain exactly one DEEPSEEK_API_KEY assignment"
  [[ "$model_count" -le 1 ]] ||
    fail "DEPLOY_V0152_MODEL_KEY_INVALID" \
      "Environment must contain at most one MODEL_API_KEY assignment"
  validate_bridge_credential_assignment "$BRIDGE_LEGACY_VALUE"
  if [[ "$model_count" -eq 1 && "$BRIDGE_MODEL_VALUE" != "$BRIDGE_LEGACY_VALUE" ]]; then
    fail "DEPLOY_V0152_MODEL_KEY_CONFLICT" \
      "Existing MODEL_API_KEY does not exactly match the approved legacy DeepSeek credential"
  fi
  BRIDGE_MODEL_PRESENT="$model_count"
}

require_v0152_release_config() {
  local released_config="${WORK_DIR}/agent-model-providers.json"
  [[ -f "$released_config" && ! -L "$released_config" ]] ||
    fail "DEPLOY_V0152_MODEL_CONFIG_MISSING" \
      "Canonical v0.15.2 agent model config asset is absent"
  printf '%s  %s\n' "$V0152_MODEL_CONFIG_SHA256" "$released_config" |
    sha256sum --check --status - ||
    fail "DEPLOY_V0152_MODEL_CONFIG_HASH_MISMATCH" \
      "Canonical v0.15.2 agent model config does not match the reviewed bytes"
}

provision_v0152_model_bridge() {
  if [[ "$REQUESTED_VERSION" != "$V0152_BRIDGE_TARGET_VERSION" ]]; then
    require_metadata "$AGENT_MODEL_PROVIDER_CONFIG" "0:0:644"
    return 0
  fi
  require_v0152_release_config

  # Initial installs must arrive with the new contract; only a claimed update may derive legacy state.
  if [[ "$INITIAL_MODE" -eq 1 ]]; then
    require_metadata "$AGENT_MODEL_PROVIDER_CONFIG" "0:0:644"
    cmp --silent "${WORK_DIR}/agent-model-providers.json" "$AGENT_MODEL_PROVIDER_CONFIG" ||
      fail "DEPLOY_V0152_MODEL_CONFIG_CONFLICT" \
        "Initial v0.15.2 model config differs from the canonical release asset"
    return 0
  fi

  local source_version
  source_version="$(jq -er '.version' "${CURRENT_LINK}/osinara-deployment.json")"
  if [[ "$source_version" != "$V0152_BRIDGE_SOURCE_VERSION" ]]; then
    fail "DEPLOY_V0152_BRIDGE_SOURCE_INVALID" \
      "Missing v0.15.2 model contract can be provisioned only from v0.15.1"
  fi
  read_bridge_credentials

  # Existing config is accepted only when it is byte-identical to the reviewed release artifact.
  if [[ -e "$AGENT_MODEL_PROVIDER_CONFIG" ]]; then
    require_metadata "$AGENT_MODEL_PROVIDER_CONFIG" "0:0:644"
    cmp --silent "${WORK_DIR}/agent-model-providers.json" "$AGENT_MODEL_PROVIDER_CONFIG" ||
      fail "DEPLOY_V0152_MODEL_CONFIG_CONFLICT" \
        "Existing agent model config differs from the canonical v0.15.2 release asset"
  else
    local config_temp
    config_temp="$(mktemp "${WORK_DIR}/agent-model-providers.XXXXXX")"
    install -o root -g root -m 0644 "${WORK_DIR}/agent-model-providers.json" "$config_temp"
    mv -f "$config_temp" "$AGENT_MODEL_PROVIDER_CONFIG"
  fi

  # Preserve DEEPSEEK_API_KEY for v0.15.1 rollback and append the exact same dotenv token atomically.
  if [[ "$BRIDGE_MODEL_PRESENT" -eq 0 ]]; then
    local environment_temp
    environment_temp="$(mktemp "${WORK_DIR}/server-env.XXXXXX")"
    install -o root -g root -m 0600 "$SERVER_ENV" "$environment_temp"
    if [[ -n "$(tail -c 1 "$environment_temp")" ]]; then
      printf '\n' >> "$environment_temp"
    fi
    printf 'MODEL_API_KEY=%s\n' "$BRIDGE_LEGACY_VALUE" >> "$environment_temp"
    mv -f "$environment_temp" "$SERVER_ENV"
  fi
  require_metadata "$SERVER_ENV" "0:0:600"
  require_metadata "$AGENT_MODEL_PROVIDER_CONFIG" "0:0:644"
}

validate_v0160_environment() {
  local line name value
  local legacy_count=0 model_count=0 proxy_count=0
  V0160_LEGACY_VALUE=""
  V0160_MODEL_VALUE=""
  V0160_PROXY_VALUE=""

  # Read only the three exact assignments needed for the one-time credential transition.
  while IFS= read -r line || [[ -n "$line" ]]; do
    name="${line%%=*}"
    value="${line#*=}"
    case "$name" in
      DEEPSEEK_API_KEY)
        legacy_count=$((legacy_count + 1))
        V0160_LEGACY_VALUE="$value"
        ;;
      MODEL_API_KEY)
        model_count=$((model_count + 1))
        V0160_MODEL_VALUE="$value"
        ;;
      CLI_PROXY_API_KEY)
        proxy_count=$((proxy_count + 1))
        V0160_PROXY_VALUE="$value"
        ;;
    esac
  done < "$SERVER_ENV"

  [[ "$model_count" -eq 1 && "$proxy_count" -eq 1 ]] ||
    fail "DEPLOY_V0160_MODEL_KEY_INVALID" \
      "Environment must contain one model and one CLIProxy credential"
  validate_bridge_credential_assignment "$V0160_MODEL_VALUE"
  validate_bridge_credential_assignment "$V0160_PROXY_VALUE"
  if [[ "$INITIAL_MODE" -eq 0 ]]; then
    [[ "$legacy_count" -eq 1 ]] ||
      fail "DEPLOY_V0160_MODEL_KEY_INVALID" \
        "Production update must contain one DeepSeek rollback credential"
    validate_bridge_credential_assignment "$V0160_LEGACY_VALUE"
  fi
}

validate_v0160_codex_inputs() {
  local released_config="${WORK_DIR}/${V0160_BRIDGE_CODEX_MODEL_CONFIG_ASSET}"
  require_metadata "$CODEX_AUTH_SEED" "0:0:600"
  require_metadata "$AGENT_MODEL_PROVIDER_CONFIG" "0:0:644"
  [[ -f "$released_config" && ! -L "$released_config" ]] ||
    fail "DEPLOY_V0160_MODEL_CONFIG_MISSING" "Canonical Codex model config asset is absent"
  printf '%s  %s\n' "$V0160_CODEX_MODEL_CONFIG_SHA256" "$released_config" |
    sha256sum --check --status - ||
    fail "DEPLOY_V0160_MODEL_CONFIG_HASH_MISMATCH" \
      "Canonical Codex model config does not match the reviewed bytes"

  local source_config_sha256="$V0160_UPDATE_SOURCE_MODEL_CONFIG_SHA256"
  [[ "$INITIAL_MODE" -eq 0 ]] || source_config_sha256="$V0160_INITIAL_SOURCE_MODEL_CONFIG_SHA256"
  # Existing production uses reviewed NeuralDeep bytes; explicit initial mode starts from the release default.
  printf '%s  %s\n' "$source_config_sha256" "$AGENT_MODEL_PROVIDER_CONFIG" |
    sha256sum --check --status - ||
    fail "DEPLOY_V0160_SOURCE_CONFIG_INVALID" \
      "Current model config does not match the expected v0.16.0 bridge source"
  jq -e '
    type == "object" and
    keys == ["access_token", "account_id", "expired", "refresh_token", "type"] and
    .type == "codex" and
    (.access_token | type == "string" and test("^[^[:space:]]+$")) and
    (.refresh_token | type == "string" and test("^[^[:space:]]+$")) and
    (.account_id | type == "string" and
      test("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")) and
    (.expired | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
  ' "$CODEX_AUTH_SEED" >/dev/null ||
    fail "DEPLOY_V0160_CODEX_AUTH_INVALID" \
      "Staged Codex OAuth credential is malformed; stage a fresh OpenCode token set"
}

dotenv_credential_runtime_value() {
  local value="$1"
  if [[ "$value" == \'*\' ]]; then
    value="${value#\'}"
    value="${value%\'}"
  fi
  printf '%s' "$value"
}

install_v0160_environment_and_config() {
  local released_config="${WORK_DIR}/${V0160_BRIDGE_CODEX_MODEL_CONFIG_ASSET}"
  local environment_temp config_temp line
  environment_temp="$(mktemp "${WORK_DIR}/server-env.XXXXXX")"
  config_temp="$(mktemp "${WORK_DIR}/agent-model-providers.XXXXXX")"
  install -o root -g root -m 0600 /dev/null "$environment_temp"

  # Replace only MODEL_API_KEY and preserve every unrelated environment byte and rollback credential.
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "${line%%=*}" == "MODEL_API_KEY" ]]; then
      printf 'MODEL_API_KEY=%s\n' "$V0160_PROXY_VALUE" >> "$environment_temp"
    else
      printf '%s\n' "$line" >> "$environment_temp"
    fi
  done < "$SERVER_ENV"
  install -o root -g root -m 0644 "$released_config" "$config_temp"
  mv -f "$environment_temp" "$SERVER_ENV"
  mv -f "$config_temp" "$AGENT_MODEL_PROVIDER_CONFIG"
  # Shell environment outranks `--env-file`; update it before candidate Compose interpolation.
  MODEL_API_KEY="$(dotenv_credential_runtime_value "$V0160_PROXY_VALUE")"
  export MODEL_API_KEY
  require_metadata "$SERVER_ENV" "0:0:600"
  require_metadata "$AGENT_MODEL_PROVIDER_CONFIG" "0:0:644"
}

provision_v0160_codex_bridge() {
  [[ "$REQUESTED_VERSION" == "$V0160_BRIDGE_TARGET_VERSION" ]] || return 0
  validate_v0160_codex_bridge
  docker volume inspect "$CODEX_AUTH_VOLUME" >/dev/null ||
    fail "DEPLOY_V0160_CODEX_VOLUME_MISSING" \
      "Candidate Codex OAuth volume was not created during backup preflight"

  # Seed the empty attempt-owned volume as root, then leave all refresh writes to uid 10001.
  docker run --rm --network none --user 0:0 --entrypoint /bin/sh \
    --volume "${CODEX_AUTH_SEED}:/seed/opencode-codex.json:ro" \
    --volume "${CODEX_AUTH_VOLUME}:/auth" "$APP_IMAGE" -c '
      set -eu
      chown 10001:10001 /auth
      chmod 0700 /auth
      set -- /auth/*
      [ "$1" = "/auth/*" ] || exit 41
      install -o 10001 -g 10001 -m 0600 /seed/opencode-codex.json /auth/opencode-codex.json
    ' || fail "DEPLOY_V0160_CODEX_AUTH_SEED_FAILED" \
      "Could not seed the persistent Codex OAuth volume"
  install_v0160_environment_and_config
}

validate_v0160_codex_bridge() {
  [[ "$REQUESTED_VERSION" == "$V0160_BRIDGE_TARGET_VERSION" ]] || return 0
  if [[ "$INITIAL_MODE" -eq 0 ]]; then
    local source_version
    source_version="$(jq -er '.version' "${CURRENT_LINK}/osinara-deployment.json")"
    [[ "$source_version" == "$V0160_BRIDGE_SOURCE_VERSION" ]] ||
      fail "DEPLOY_V0160_BRIDGE_SOURCE_INVALID" \
        "Codex subscription bridge can run only from exact v0.15.14 production state"
  fi

  validate_v0160_environment
  validate_v0160_codex_inputs
}

prepare_v0160_codex_volume() {
  [[ "$REQUESTED_VERSION" == "$V0160_BRIDGE_TARGET_VERSION" && "$INITIAL_MODE" -eq 1 ]] || return 0
  if docker volume inspect "$CODEX_AUTH_VOLUME" >/dev/null 2>&1; then
    fail "DEPLOY_CANDIDATE_VOLUME_OWNERSHIP_AMBIGUOUS" \
      "Initial Codex OAuth volume already exists without release ownership"
    return 1
  fi
  docker volume create "$CODEX_AUTH_VOLUME" >/dev/null ||
    fail "DEPLOY_CANDIDATE_VOLUME_CREATE_FAILED" \
      "Could not create the initial Codex OAuth volume"
  CREATED_CANDIDATE_VOLUMES+=("$CODEX_AUTH_VOLUME")
}

complete_v0160_codex_bridge() {
  [[ "$REQUESTED_VERSION" == "$V0160_BRIDGE_TARGET_VERSION" ]] || return 0
  rm -f -- "$CODEX_AUTH_SEED" ||
    fail "DEPLOY_V0160_CODEX_SEED_CLEANUP_FAILED" \
      "Healthy Codex release was promoted but the staged OAuth seed could not be removed"
}

validate_v0160_codex_model() {
  [[ "$REQUESTED_VERSION" == "$V0160_BRIDGE_TARGET_VERSION" ]] || return 0

  # `/v1/models` is local metadata; one bounded completion proves OAuth and the selected model upstream.
  compose_candidate exec -T cli-proxy-api /bin/sh -c '
    set -eu
    response=/run/cli-proxy-api/model-smoke.json
    trap '\''rm -f "$response"'\'' EXIT INT TERM
    curl --fail --silent --show-error --max-time 120 \
      --header "Authorization: Bearer ${CLI_PROXY_API_KEY}" \
      --header "Content-Type: application/json" \
      --data '\''{"model":"gpt-5.6-luna","messages":[{"role":"user","content":"Ответь одним словом: работает"}],"reasoning_effort":"medium","max_tokens":32}'\'' \
      --output "$response" http://127.0.0.1:8317/v1/chat/completions
    jq -e '\''
      .model == "gpt-5.6-luna" and
      .choices[0].finish_reason == "stop" and
      (.choices[0].message.content | type == "string" and length > 0)
    '\'' "$response" >/dev/null
  ' || fail "DEPLOY_V0160_CODEX_MODEL_SMOKE_FAILED" \
    "Candidate CLIProxy could not complete one gpt-5.6-luna request"
}
