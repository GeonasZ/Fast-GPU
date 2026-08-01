#!/usr/bin/env bash
set -Eeuo pipefail

apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl git jq build-essential cmake pkg-config \
  python3 python3-pip python3-venv \
  fio iperf3 nvme-cli rclone rsync tini pciutils iproute2 \
  libboost-program-options-dev
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y --no-install-recommends nodejs
fi
npm install -g --bin-links=true @openai/codex@latest @anthropic-ai/claude-code@latest
python3 -m pip install --break-system-packages --upgrade pip
python3 -m pip install --break-system-packages torch torchvision torchaudio
