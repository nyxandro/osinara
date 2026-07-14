#!/bin/sh
set -eu

# Fail before migrations or network listeners when required runtime configuration is absent.
for name in CLI_PROXY_API_KEY CLI_PROXY_BASE_URL DATABASE_URL GROQ_API_KEY INVITATION_SIGNING_SECRET TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET_TOKEN TELEGRAM_BOT_USERNAME; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    printf '%s\n' "AGENT_REQUIRED_CONFIG_MISSING: Не задана обязательная настройка $name" >&2
    exit 1
  fi
done

# Invitation codes require a dedicated high-entropy signing secret for replay-safe derivation.
INVITATION_SIGNING_SECRET_MIN_LENGTH=32
if [ "${#INVITATION_SIGNING_SECRET}" -lt "$INVITATION_SIGNING_SECRET_MIN_LENGTH" ]; then
  printf '%s\n' "AGENT_INVITATION_CONFIG_MISSING: INVITATION_SIGNING_SECRET должен содержать минимум 32 символа" >&2
  exit 1
fi

# Validate model IDs and context metadata before Eve opens a listener or accepts durable work.
node .runtime/scripts/validate-model-provider-config.js

# A compose run command is an explicit operator action and must terminate normally.
if [ "$#" -eq 1 ] && [ "$1" = "start-after-migration" ]; then
  exec npm run start -- --host 0.0.0.0 --port 3000
fi
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

# Production images contain the emitted migration runner, not TypeScript source files.
node .runtime/scripts/migrate.js
exec npm run start -- --host 0.0.0.0 --port 3000
