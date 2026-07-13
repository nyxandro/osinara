#!/bin/sh
set -eu

# Fail before migrations or network listeners when required runtime configuration is absent.
for name in DATABASE_URL GROQ_API_KEY INVITATION_SIGNING_SECRET TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET_TOKEN TELEGRAM_BOT_USERNAME; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    printf '%s\n' "AGENT_REQUIRED_CONFIG_MISSING: Не задана обязательная настройка $name" >&2
    exit 1
  fi
done

# Retained CLIProxy credentials are optional while Groq is primary, but partial setup is invalid.
if { [ -n "${CLI_PROXY_API_KEY:-}" ] && [ -z "${CLI_PROXY_BASE_URL:-}" ]; } || \
   { [ -z "${CLI_PROXY_API_KEY:-}" ] && [ -n "${CLI_PROXY_BASE_URL:-}" ]; }; then
  printf '%s\n' "AGENT_REQUIRED_CONFIG_MISSING: CLI_PROXY_API_KEY и CLI_PROXY_BASE_URL должны быть заданы вместе" >&2
  exit 1
fi

# Invitation codes require a dedicated high-entropy signing secret for replay-safe derivation.
INVITATION_SIGNING_SECRET_MIN_LENGTH=32
if [ "${#INVITATION_SIGNING_SECRET}" -lt "$INVITATION_SIGNING_SECRET_MIN_LENGTH" ]; then
  printf '%s\n' "AGENT_INVITATION_CONFIG_MISSING: INVITATION_SIGNING_SECRET должен содержать минимум 32 символа" >&2
  exit 1
fi

# A compose run command is an explicit operator action and must terminate normally.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

npm run migrate
exec npm run start -- --host 0.0.0.0 --port 3000
