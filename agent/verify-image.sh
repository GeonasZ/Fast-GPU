#!/usr/bin/env bash
set -Eeuo pipefail

required=(node npm fio rclone nvbandwidth nvcc python)
for tool in "${required[@]}"; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done

node --check /opt/fast-gpu/agent.js
fio --version
rclone version | head -1
nvcc --version | tail -1
if [[ "${FLEET_VERIFY_GPU:-0}" == "1" ]]; then
  command -v nvidia-smi >/dev/null || { echo "missing required GPU tool: nvidia-smi" >&2; exit 1; }
  nvidia-smi >/dev/null
fi
printf 'base runtime image verification passed; developer CLIs install during instance bootstrap\n'
