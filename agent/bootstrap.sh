#!/usr/bin/env bash
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive
install -d -m 0755 /opt/gpu-fleet /var/lib/gpu-fleet /data/datasets/fineweb
start_existing_agent() {
  [[ -f /opt/gpu-fleet/agent.js ]] || return 0
  command -v node >/dev/null 2>&1 || return 0
  pgrep -f '[n]ode /opt/gpu-fleet/agent.js' >/dev/null 2>&1 && return 0
  nohup node /opt/gpu-fleet/agent.js >>/var/log/gpu-fleet-agent.log 2>&1 &
}
start_existing_agent
profile() {
  # SSH must be recoverable even from a minimal provider image. Telemetry is
  # best-effort until Python is available; it must never prevent sshd startup.
  command -v python3 >/dev/null 2>&1 || return 0
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
fail() {
  local code="$1" message="$2"
  trap - ERR
  profile failed failed "$message"
  echo "$message" >&2
  exit "$code"
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
start_ssh_early() {
  profile provisioning starting_ssh '正在启动 SSH 连接服务'
  if [[ -x /opt/gpu-fleet/ensure-ssh.sh ]]; then
    /opt/gpu-fleet/ensure-ssh.sh
    return
  fi
  if [[ ! -x /usr/sbin/sshd ]]; then
    apt-get update
    apt-get install -y --no-install-recommends openssh-server iproute2
  fi
  local ssh_user="${FLEET_SSH_USER:-root}" home_dir ssh_group
  id "$ssh_user" >/dev/null 2>&1 || useradd -m -s /bin/bash "$ssh_user"
  home_dir="$(getent passwd "$ssh_user" | cut -d: -f6)"
  ssh_group="$(id -gn "$ssh_user")"
  install -d -m 0700 -o "$ssh_user" -g "$ssh_group" "$home_dir/.ssh"
  if [[ -n "${FLEET_SSH_PUBLIC_KEY:-}" ]]; then
    printf '%s\n' "$FLEET_SSH_PUBLIC_KEY" > "$home_dir/.ssh/authorized_keys"
    chown "$ssh_user:$ssh_group" "$home_dir/.ssh/authorized_keys"
    chmod 0600 "$home_dir/.ssh/authorized_keys"
  fi
  install -d -m 0755 /run/sshd /etc/ssh/sshd_config.d
  cat > /etc/ssh/sshd_config.d/60-gpu-fleet.conf <<EOF
Port ${FLEET_SSH_PORT:-22}
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitEmptyPasswords no
PermitRootLogin prohibit-password
EOF
  ssh-keygen -A
  sshd -t
  pgrep -x sshd >/dev/null || /usr/sbin/sshd
  pgrep -x sshd >/dev/null
  timeout 5 ssh-keyscan -p "${FLEET_SSH_PORT:-22}" 127.0.0.1 >/dev/null 2>&1
  printf '%s\n' bootstrap > /var/lib/gpu-fleet/ssh-autostart-mode
}
install_runtime_dependencies() {
  profile provisioning installing_runtime_dependencies '正在构建运行环境并安装平台依赖'
  apt-get update
  apt-get install -y --no-install-recommends \
    ca-certificates curl jq pciutils git python3 python3-pip openssh-server iproute2 tini \
    fio iperf3 nvme-cli cmake build-essential rclone rsync libboost-program-options-dev
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y --no-install-recommends nodejs
  fi
  if ! command -v nvbandwidth >/dev/null 2>&1; then
    rm -rf /tmp/nvbandwidth
    git clone --depth 1 https://github.com/NVIDIA/nvbandwidth.git /tmp/nvbandwidth
    cmake -S /tmp/nvbandwidth -B /tmp/nvbandwidth/build \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_CUDA_ARCHITECTURES="75;80;86;89;90;100"
    cmake --build /tmp/nvbandwidth/build -j"$(nproc)"
    install /tmp/nvbandwidth/build/nvbandwidth /usr/local/bin/nvbandwidth
    rm -rf /tmp/nvbandwidth
  fi
  rm -rf /var/lib/apt/lists/*
}
trap 'code=$?; profile failed failed "初始化失败（退出码 $code）"; exit $code' ERR
start_ssh_early
if [[ "${FLEET_RECOVERY_ONLY:-0}" == "1" ]]; then
  profile ready recovered '远端 SSH 与遥测连接已恢复'
  start_existing_agent
  exit 0
fi
profile provisioning checking_runtime '正在检查容器与 CUDA 环境'
source /etc/os-release
if [[ "${VERSION_ID:-}" != "24.04" ]]; then fail 20 "Fast GPU requires Ubuntu 24.04; got ${PRETTY_NAME:-unknown}"; fi
expected_cuda_major="${FLEET_EXPECTED_CUDA_MAJOR:-13}"
if ! command -v nvcc >/dev/null 2>&1 || [[ "$(nvcc --version | sed -n 's/.*release \([0-9]*\).*/\1/p' | tail -1)" != "$expected_cuda_major" ]]; then
  fail 21 "Fast GPU expected CUDA ${expected_cuda_major}.x but the selected container does not provide it."
fi
if [[ "${FLEET_PREBUILT_IMAGE:-0}" != "1" ]]; then install_runtime_dependencies; fi
profile provisioning installing_developer_tools '正在安装开发工具（Codex 与 Claude Code）'
npm install -g --bin-links=true @openai/codex@latest @anthropic-ai/claude-code@latest
command -v codex >/dev/null 2>&1 || repair_npm_command '@openai/codex' codex || fail 24 "Codex CLI 安装完成但命令不可用"
command -v claude >/dev/null 2>&1 || repair_npm_command '@anthropic-ai/claude-code' claude || fail 25 "Claude Code 安装完成但命令不可用"
codex --version
claude --version
profile provisioning verifying_gpu '正在验证云实例 GPU'
command -v nvidia-smi >/dev/null 2>&1 || fail 22 "NVIDIA runtime is unavailable in the cloud instance"
nvidia-smi >/dev/null
python3 - <<'PY'
import torch
assert torch.cuda.is_available(), 'PyTorch cannot access the cloud GPU'
x = torch.ones(256, device='cuda')
assert float((x * 2).sum()) == 512.0, 'PyTorch GPU calculation failed'
print('torch', torch.__version__, 'cuda', torch.version.cuda, 'gpu', torch.cuda.get_device_name(0))
PY
profile provisioning starting_agent '正在启动监控 Agent'
if [[ -n "${FLEET_AGENT_BUNDLE_URL:-}" ]]; then
  curl -fsSL "$FLEET_AGENT_BUNDLE_URL" | tar -xz -C /opt/gpu-fleet
elif [[ -n "${BASE_URL:-}" ]]; then
  curl -fsSL "${BASE_URL%/}/provision/agent.js" -o /opt/gpu-fleet/agent.js
fi
configure_storage_remote() {
  local name="$1" endpoint="$2" access_key="$3" secret_key="$4" region="${5:-}"
  local args=(config create "$name" s3 provider Other endpoint "$endpoint" access_key_id "$access_key" secret_access_key "$secret_key" env_auth false)
  [[ -n "$region" ]] && args+=(region "$region")
  rclone "${args[@]}"
}
if [[ "${R2_S3_ENABLED:-}" == 1 ]]; then
  configure_storage_remote r2 "$R2_S3_ENDPOINT" "$R2_S3_ACCESS_KEY_ID" "$R2_S3_SECRET_ACCESS_KEY" "${R2_S3_REGION:-auto}"
fi
if [[ "${OSS_S3_ENABLED:-}" == 1 ]]; then
  configure_storage_remote oss "$OSS_S3_ENDPOINT" "$OSS_S3_ACCESS_KEY_ID" "$OSS_S3_SECRET_ACCESS_KEY" "${OSS_S3_REGION:-}"
fi
primary_storage="${STORAGE_PRIMARY_PROVIDER:-r2}"
if [[ "$primary_storage" == r2 && "${R2_S3_ENABLED:-}" == 1 ]]; then
  profile provisioning syncing_data '正在从 Cloudflare R2 同步数据'
  rclone sync --checksum --transfers 16 "r2:${R2_S3_BUCKET}/${R2_S3_PREFIX:-fineweb-edu/CC-MAIN-2013-20}" /data/datasets/fineweb
elif [[ "$primary_storage" == oss && "${OSS_S3_ENABLED:-}" == 1 ]]; then
  profile provisioning syncing_data '正在从阿里云 OSS 同步数据'
  rclone sync --checksum --transfers 16 "oss:${OSS_S3_BUCKET}/${OSS_S3_PREFIX:-fineweb-edu/CC-MAIN-2013-20}" /data/datasets/fineweb
fi
start_existing_agent
trap - ERR
if python3 -c "import json; raise SystemExit(not json.load(open('/var/lib/gpu-fleet/profile.json')).get('warnings'))"; then
  profile ready ready '初始化完成（有警告）'
else
  profile ready ready '初始化完成'
fi
