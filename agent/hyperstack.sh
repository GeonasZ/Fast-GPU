#!/usr/bin/env bash
set -euo pipefail
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/cloud_compute/hyperstack/agent/hyperstack.sh" "$@"
