#!/bin/bash
# Builds one deterministic archive containing the root-owned initial deployment controller assets.
# Arguments: output archive, deployment manifest, and generated installation Compose paths.

set -euo pipefail

readonly PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly OUTPUT_PATH="${1:-}"
readonly DEPLOYMENT_MANIFEST="${2:-}"
readonly INSTALLATION_COMPOSE="${3:-}"
if [[ -z "$OUTPUT_PATH" || "$OUTPUT_PATH" != /* ]]; then
  printf '%s\n' \
    "OSINARA_INSTALL_BUNDLE_OUTPUT_INVALID: Укажите абсолютный путь выходного архива" >&2
  exit 64
fi
if [[ -z "$DEPLOYMENT_MANIFEST" || "$DEPLOYMENT_MANIFEST" != /* ]]; then
  printf '%s\n' \
    "OSINARA_INSTALL_BUNDLE_MANIFEST_INVALID: Укажите абсолютный путь deployment manifest" >&2
  exit 64
fi
if [[ -z "$INSTALLATION_COMPOSE" || "$INSTALLATION_COMPOSE" != /* ]]; then
  printf '%s\n' \
    "OSINARA_INSTALL_BUNDLE_COMPOSE_INVALID: Укажите абсолютный путь installation Compose" >&2
  exit 64
fi

for command in install mktemp rm tar; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf '%s\n' "OSINARA_INSTALL_BUNDLE_COMMAND_MISSING: Недоступна команда $command" >&2
    exit 69
  fi
done

if [[ ! -s "$DEPLOYMENT_MANIFEST" || ! -s "$INSTALLATION_COMPOSE" ]]; then
  printf '%s\n' \
    "OSINARA_INSTALL_BUNDLE_INPUT_MISSING: Отсутствует deployment manifest или production Compose" >&2
  exit 66
fi

readonly WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/osinara-install-bundle.XXXXXX")"
cleanup() {
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT HUP INT TERM

# Fixed paths and modes make extraction validation explicit and archive bytes reproducible.
install -d -m 0755 \
  "${WORK_DIR}/installation"
install -m 0644 "$INSTALLATION_COMPOSE" \
  "${WORK_DIR}/installation/compose.installation.json"
install -m 0644 "$DEPLOYMENT_MANIFEST" \
  "${WORK_DIR}/installation/osinara-deployment.json"
install -m 0644 "${PROJECT_ROOT}/infra/traefik/compose.yaml" \
  "${WORK_DIR}/installation/traefik-compose.yaml"
install -m 0644 "${PROJECT_ROOT}/infra/traefik/dynamic/osinara.yaml" \
  "${WORK_DIR}/installation/traefik-osinara.yaml"
tar --create --gzip \
  --directory "$WORK_DIR" \
  --format=gnu \
  --group=0 \
  --mtime='UTC 1970-01-01' \
  --numeric-owner \
  --owner=0 \
  --sort=name \
  --file "$OUTPUT_PATH" \
  installation
