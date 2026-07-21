#!/usr/bin/env bash
set -Eeuo pipefail

required=(node codex claude fio rclone nvbandwidth nvcc python)
for tool in "${required[@]}"; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done

actual_codex="$(codex --version)"
[[ "$actual_codex" == *"${CODEX_VERSION:?CODEX_VERSION is not embedded in the image}"* ]] || {
  echo "expected Codex ${CODEX_VERSION}, got: ${actual_codex}" >&2
  exit 1
}

actual_claude="$(claude --version)"
[[ "$actual_claude" == *"${CLAUDE_CODE_VERSION:?CLAUDE_CODE_VERSION is not embedded in the image}"* ]] || {
  echo "expected Claude Code ${CLAUDE_CODE_VERSION}, got: ${actual_claude}" >&2
  exit 1
}

node --check /opt/gpu-fleet/agent.js
fio --version
rclone version | head -1
nvcc --version | tail -1
if [[ "${FLEET_VERIFY_GPU:-0}" == "1" ]]; then
  command -v nvidia-smi >/dev/null || { echo "missing required GPU tool: nvidia-smi" >&2; exit 1; }
  nvidia-smi >/dev/null
fi
printf 'image verification passed; %s; Claude Code %s\n' "$actual_codex" "$actual_claude"
