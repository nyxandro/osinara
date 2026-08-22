#!/bin/sh
# Validates persistent Codex OAuth state and renders the secret-bearing CLIProxy runtime config.
set -eu

readonly CLI_PROXY_PORT=8317
readonly CLI_PROXY_PPROF_PORT=8316

if [ "$#" -lt 3 ]; then
  printf '%s\n' "CLI_PROXY_ARGUMENT_INVALID: Ожидались каталог OAuth, target и команда запуска" >&2
  exit 1
fi

auth_directory="$1"
target_config="$2"
shift 2

# The downstream bearer key is mandatory and must remain a single printable token.
if [ -z "${CLI_PROXY_API_KEY:-}" ]; then
  printf '%s\n' "CLI_PROXY_REQUIRED_CONFIG_MISSING: Не задана обязательная настройка CLI_PROXY_API_KEY" >&2
  exit 1
fi
case "$CLI_PROXY_API_KEY" in
  *[![:graph:]]*)
    printf '%s\n' "CLI_PROXY_REQUIRED_CONFIG_INVALID: CLI_PROXY_API_KEY содержит недопустимые символы" >&2
    exit 1
    ;;
esac

if [ ! -d "$auth_directory" ] || [ ! -r "$auth_directory" ] || [ ! -w "$auth_directory" ]; then
  printf '%s\n' "CLI_PROXY_CODEX_AUTH_DIRECTORY_INVALID: Каталог Codex OAuth недоступен для чтения и обновления" >&2
  exit 1
fi

# Every discovered JSON credential must be a writable 0600 Codex OAuth record; mixed providers fail closed.
auth_count=0
for auth_file in "$auth_directory"/*.json; do
  [ -e "$auth_file" ] || continue
  if [ -L "$auth_file" ] || [ ! -f "$auth_file" ] || [ ! -r "$auth_file" ] || [ ! -w "$auth_file" ]; then
    printf '%s\n' "CLI_PROXY_CODEX_AUTH_INVALID: OAuth credential имеет небезопасный тип или права" >&2
    exit 1
  fi
  if [ "$(stat -c '%a' "$auth_file")" != "600" ]; then
    printf '%s\n' "CLI_PROXY_CODEX_AUTH_INVALID: OAuth credential должен иметь права 0600" >&2
    exit 1
  fi
  jq -e '
    type == "object" and
    .type == "codex" and
    (.access_token | type == "string" and test("^[^[:space:]]+$")) and
    (.refresh_token | type == "string" and test("^[^[:space:]]+$")) and
    (.account_id | type == "string" and
      test("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")) and
    (.expired | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
  ' "$auth_file" >/dev/null || {
    printf '%s\n' "CLI_PROXY_CODEX_AUTH_INVALID: OAuth credential не содержит полный Codex token set" >&2
    exit 1
  }
  auth_count=$((auth_count + 1))
done
if [ "$auth_count" -eq 0 ]; then
  printf '%s\n' "CLI_PROXY_CODEX_AUTH_MISSING: Не найден Codex OAuth credential; загрузите авторизацию OpenCode" >&2
  exit 1
fi

# Runtime config lives in tmpfs; management, request retries, cooldowns, and plugins stay disabled.
target_directory="$(dirname "$target_config")"
mkdir -p "$target_directory"
temporary_config="${target_config}.tmp.$$"
trap 'rm -f "$temporary_config"' EXIT INT TERM
umask 077
jq -n \
  --arg auth_directory "$auth_directory" \
  --arg client_key "$CLI_PROXY_API_KEY" \
  --argjson port "$CLI_PROXY_PORT" \
  --arg pprof_address "127.0.0.1:${CLI_PROXY_PPROF_PORT}" '
  {
    host: "0.0.0.0",
    port: $port,
    tls: {enable: false, cert: "", key: ""},
    "remote-management": {
      "allow-remote": false,
      "secret-key": "",
      "disable-control-panel": true
    },
    "auth-dir": $auth_directory,
    "api-keys": [$client_key],
    debug: false,
    pprof: {enable: false, addr: $pprof_address},
    plugins: {enabled: false, dir: "/run/cli-proxy-api/plugins", configs: {}},
    "disable-image-generation": "chat",
    "logging-to-file": false,
    "usage-statistics-enabled": false,
    "request-retry": 0,
    "max-retry-credentials": 1,
    "disable-cooling": true,
    "ws-auth": true,
    routing: {strategy: "round-robin", "session-affinity": false}
  }
' > "$temporary_config"
chmod 0600 "$temporary_config"
mv "$temporary_config" "$target_config"
trap - EXIT INT TERM

exec "$@"
