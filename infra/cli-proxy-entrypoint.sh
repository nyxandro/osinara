#!/bin/sh
# Renders CLIProxyAPI's secret-bearing config into tmpfs, then starts the pinned upstream binary.
set -eu

if [ "$#" -lt 3 ]; then
  printf '%s\n' "CLI_PROXY_ARGUMENT_INVALID: Ожидались source, target и команда запуска" >&2
  exit 1
fi

source_config="$1"
target_config="$2"
shift 2

# Both secrets are mandatory and must remain single-line visible values safe for HTTP headers.
for name in CLI_PROXY_API_KEY MODEL_UPSTREAM_API_KEY; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    printf '%s\n' "CLI_PROXY_REQUIRED_CONFIG_MISSING: Не задана обязательная настройка $name" >&2
    exit 1
  fi
  case "$value" in
    *[![:graph:]]*)
      printf '%s\n' "CLI_PROXY_REQUIRED_CONFIG_INVALID: Настройка $name содержит недопустимые символы" >&2
      exit 1
      ;;
  esac
done

if [ ! -r "$source_config" ]; then
  printf '%s\n' "CLI_PROXY_MODEL_CONFIG_MISSING: Конфигурация моделей недоступна" >&2
  exit 1
fi

# Validate the non-secret boundary independently from the TypeScript agent process.
jq -e '
  .schemaVersion == 1 and
  (.agent.upstream.name | test("^[a-z0-9][a-z0-9-]{0,63}$")) and
  (.agent.upstream.baseUrl | test("^https://")) and
  (.agent.upstream.models | type == "array" and length > 0) and
  all(.agent.upstream.models[];
    (.name | type == "string" and length > 0) and
    (.alias | type == "string" and length > 0) and
    (.inputModalities | type == "array" and length > 0) and
    (.outputModalities | type == "array" and length > 0))
' "$source_config" >/dev/null || {
  printf '%s\n' "CLI_PROXY_MODEL_CONFIG_INVALID: Некорректная конфигурация upstream-моделей" >&2
  exit 1
}

# Generate the only secret-bearing file atomically with no retries or management surface enabled.
target_directory="$(dirname "$target_config")"
mkdir -p "$target_directory"
temporary_config="${target_config}.tmp.$$"
trap 'rm -f "$temporary_config"' EXIT INT TERM
umask 077
jq -n \
  --arg client_key "$CLI_PROXY_API_KEY" \
  --arg upstream_key "$MODEL_UPSTREAM_API_KEY" \
  --slurpfile source "$source_config" '
  ($source[0].agent.upstream) as $upstream |
  {
    host: "0.0.0.0",
    port: 8317,
    tls: {enable: false, cert: "", key: ""},
    "remote-management": {
      "allow-remote": false,
      "secret-key": "",
      "disable-control-panel": true
    },
    "auth-dir": "/run/cli-proxy-api/auth",
    "api-keys": [$client_key],
    debug: false,
    pprof: {enable: false, addr: "127.0.0.1:8316"},
    plugins: {enabled: false, dir: "/run/cli-proxy-api/plugins", configs: {}},
    "logging-to-file": false,
    "usage-statistics-enabled": false,
    "request-retry": 0,
    "max-retry-credentials": 1,
    "disable-cooling": true,
    "ws-auth": true,
    routing: {strategy: "round-robin", "session-affinity": false},
    "openai-compatibility": [{
      name: $upstream.name,
      "base-url": $upstream.baseUrl,
      "disable-cooling": true,
      "api-key-entries": [{"api-key": $upstream_key}],
      models: ($upstream.models | map({
        name,
        alias,
        "input-modalities": .inputModalities,
        "output-modalities": .outputModalities
      }))
    }]
  }
' > "$temporary_config"
chmod 0600 "$temporary_config"
mv "$temporary_config" "$target_config"
trap - EXIT INT TERM

exec "$@"
