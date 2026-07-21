#!/usr/bin/env bash
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive
install -d -m 0755 /opt/gpu-fleet /var/lib/gpu-fleet /data/datasets/fineweb
profile() {
  python3 - "$1" "$2" "$3" <<'PY'
import json, os, sys, time
status, phase, label = sys.argv[1:]
current = {}
try:
    with open('/var/lib/gpu-fleet/profile.json', encoding='utf-8') as file:
        current = json.load(file)
except (OSError, ValueError):
    pass
with open('/var/lib/gpu-fleet/profile.json', 'w', encoding='utf-8') as file:
    json.dump({'status': status, 'phase': phase, 'phaseLabel': label, 'warnings': current.get('warnings', []), 'updatedAt': int(time.time() * 1000)}, file)
PY
}
warning() {
  python3 - "$1" "$2" <<'PY'
import json, sys, time
component, reason = sys.argv[1:]
path = '/var/lib/gpu-fleet/profile.json'
try:
    with open(path, encoding='utf-8') as file:
        profile = json.load(file)
except (OSError, ValueError):
    profile = {'status': 'provisioning', 'phase': 'installing_optional', 'phaseLabel': '正在安装可选工具'}
warnings = profile.setdefault('warnings', [])
warnings.append({'component': component, 'reason': reason.strip()[-500:] or '命令执行失败但没有输出', 'at': int(time.time() * 1000)})
with open(path, 'w', encoding='utf-8') as file:
    json.dump(profile, file)
PY
}
repair_npm_command() {
  local package_name="$1" command_name="$2" package_dir bin_relative prefix
  package_dir="$(npm root -g)/$package_name"
  [[ -f "$package_dir/package.json" ]] || return 1
  bin_relative="$(node - "$package_dir/package.json" "$command_name" <<'NODE'
const fs = require('fs');
const [manifest, command] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(manifest, 'utf8')).bin;
const target = typeof value === 'string' ? value : value?.[command] || Object.values(value || {})[0];
if (!target) process.exit(1);
process.stdout.write(target);
NODE
)" || return 1
  [[ -f "$package_dir/$bin_relative" ]] || return 1
  prefix="$(npm config get prefix)"
  install -d -m 0755 "$prefix/bin"
  chmod a+x "$package_dir/$bin_relative"
  ln -sfn "$package_dir/$bin_relative" "$prefix/bin/$command_name"
  hash -r
  command -v "$command_name" >/dev/null 2>&1
}
profile provisioning checking_runtime '正在检查容器与 CUDA 环境'
trap 'code=$?; profile failed failed "初始化失败（退出码 $code）"; exit $code' ERR
source /etc/os-release
if [[ "${VERSION_ID:-}" != "24.04" ]]; then echo "GPU Fleet requires Ubuntu 24.04; got ${PRETTY_NAME:-unknown}" >&2; exit 20; fi
expected_cuda_major="${FLEET_EXPECTED_CUDA_MAJOR:-13}"
if ! command -v nvcc >/dev/null 2>&1 || [[ "$(nvcc --version | sed -n 's/.*release \([0-9]*\).*/\1/p' | tail -1)" != "$expected_cuda_major" ]]; then
  echo "GPU Fleet expected CUDA ${expected_cuda_major}.x but the selected container does not provide it." >&2; exit 21
fi
if [[ "${FLEET_PREBUILT_IMAGE:-0}" != "1" ]]; then
profile provisioning installing_core '正在安装基础系统工具'
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl jq pciutils git python3 python3-pip
profile provisioning installing_optional '正在安装性能测试与数据工具'
if ! apt-get install -y --no-install-recommends fio iperf3 nvme-cli cmake build-essential rclone libboost-program-options-dev >/tmp/gpu-fleet-optional-apt.log 2>&1; then
  warning 'fio/性能与数据工具' "$(tail -n 8 /tmp/gpu-fleet-optional-apt.log)"
fi
profile provisioning installing_ai_tools '正在安装 Node、Codex 与 Claude 工具'
if (curl -fsSL https://deb.nodesource.com/setup_22.x | bash -) >/tmp/gpu-fleet-node.log 2>&1 && apt-get install -y --no-install-recommends nodejs >>/tmp/gpu-fleet-node.log 2>&1; then
  if ! npm install -g --bin-links=true @openai/codex@latest >/tmp/gpu-fleet-codex.log 2>&1; then
    warning 'Codex CLI' "$(tail -n 8 /tmp/gpu-fleet-codex.log)"
  elif ! command -v codex >/dev/null 2>&1 && ! repair_npm_command '@openai/codex' codex; then
    warning 'Codex CLI' "npm 安装成功，但 PATH 中找不到 codex 命令（prefix: $(npm config get prefix)）"
  fi
  if ! npm install -g --bin-links=true @anthropic-ai/claude-code@latest >/tmp/gpu-fleet-claude.log 2>&1; then
    warning 'Claude Code' "$(tail -n 8 /tmp/gpu-fleet-claude.log)"
  elif ! command -v claude >/dev/null 2>&1 && ! repair_npm_command '@anthropic-ai/claude-code' claude; then
    warning 'Claude Code' "npm 安装成功，但 PATH 中找不到 claude 命令（prefix: $(npm config get prefix)）"
  fi
  command -v codex >/dev/null && codex --version || true
  command -v claude >/dev/null && claude --version || true
else
  warning 'Node.js' "$(tail -n 8 /tmp/gpu-fleet-node.log)"
fi
profile provisioning building_nvbandwidth '正在构建 nvbandwidth'
if command -v nvcc >/dev/null 2>&1; then
  if ! (git clone --depth 1 https://github.com/NVIDIA/nvbandwidth.git /tmp/nvbandwidth && cmake -S /tmp/nvbandwidth -B /tmp/nvbandwidth/build -DCMAKE_BUILD_TYPE=Release && cmake --build /tmp/nvbandwidth/build -j"$(nproc)" && install /tmp/nvbandwidth/build/nvbandwidth /usr/local/bin/nvbandwidth) >/tmp/gpu-fleet-nvbandwidth.log 2>&1; then
    warning 'nvbandwidth' "$(tail -n 8 /tmp/gpu-fleet-nvbandwidth.log)"
  fi
fi
else
  profile provisioning verifying_gpu '正在验证云实例 GPU'
  command -v nvidia-smi >/dev/null 2>&1 || { echo "NVIDIA runtime is unavailable in the cloud instance" >&2; exit 22; }
  nvidia-smi >/dev/null
fi
profile provisioning starting_agent '正在启动监控 Agent'
if [[ ! -x /opt/gpu-fleet/ensure-ssh.sh ]]; then
  apt-get update
  apt-get install -y --no-install-recommends openssh-server iproute2
  install -d -m 0755 /run/sshd
  ssh-keygen -A
  sshd -t
  /usr/sbin/sshd
  pgrep -x sshd >/dev/null
  timeout 5 ssh-keyscan -p "${FLEET_SSH_PORT:-22}" 127.0.0.1 >/dev/null 2>&1
  printf '%s\n' bootstrap > /var/lib/gpu-fleet/ssh-autostart-mode
else
  /opt/gpu-fleet/ensure-ssh.sh
fi
if [[ -n "${FLEET_AGENT_BUNDLE_URL:-}" ]]; then
  curl -fsSL "$FLEET_AGENT_BUNDLE_URL" | tar -xz -C /opt/gpu-fleet
elif [[ -n "${BASE_URL:-}" ]]; then
  curl -fsSL "${BASE_URL%/}/provision/agent.js" -o /opt/gpu-fleet/agent.js
fi
if [[ -n "${S3_ENDPOINT:-}" && -n "${S3_BUCKET:-}" ]]; then
  profile provisioning syncing_data '正在同步 S3 数据'
  rclone config create fleet s3 provider Other endpoint "$S3_ENDPOINT" access_key_id "$S3_ACCESS_KEY_ID" secret_access_key "$S3_SECRET_ACCESS_KEY" env_auth false
  rclone sync --checksum --transfers 16 "fleet:${S3_BUCKET}/${S3_PREFIX:-fineweb-edu/CC-MAIN-2013-20}" /data/datasets/fineweb
fi
if [[ -f /opt/gpu-fleet/agent.js && -x "$(command -v node || true)" ]]; then nohup node /opt/gpu-fleet/agent.js >>/var/log/gpu-fleet-agent.log 2>&1 & fi
trap - ERR
if python3 -c "import json; raise SystemExit(not json.load(open('/var/lib/gpu-fleet/profile.json')).get('warnings'))"; then
  profile ready ready '初始化完成（有警告）'
else
  profile ready ready '初始化完成'
fi
