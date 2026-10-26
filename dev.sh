#!/usr/bin/env bash
set -euo pipefail

SUITE_ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "${SUITE_ROOT}/scripts/dev.mjs" "$@"
