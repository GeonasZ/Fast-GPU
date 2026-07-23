#!/usr/bin/env bash
set -Eeuo pipefail

state_dir=/var/lib/gpu-fleet
install -d -m 0755 "$state_dir" /data/datasets/fineweb

report() {
  [[ -n "${FLEET_PROVISION_STATUS_URL:-}" && -n "${FLEET_PROVISION_TOKEN:-}" ]] || return 0
  curl -fsS --retry 3 -X POST -H 'content-type: application/json' \
    --data "{\"token\":\"$FLEET_PROVISION_TOKEN\",\"status\":\"$1\",\"message\":\"${2:-}\",\"cudaLabel\":\"${cuda_label:-}\",\"driver\":\"${driver:-}\",\"containerImage\":\"${image:-}\"}" \
    "$FLEET_PROVISION_STATUS_URL" || true
}

fail() {
  printf '{"status":"failed"}\n' > "$state_dir/profile.json"
  report failed "$1"
  echo "$1" >&2
  exit 1
}
on_error() { trap - ERR; fail "Provisioning command failed at line $1"; }
trap 'on_error $LINENO' ERR

source /etc/os-release
[[ "${VERSION_ID:-}" == "24.04" ]] || fail "Hyperstack image must use Ubuntu 24.04"
command -v nvidia-smi >/dev/null 2>&1 || fail "NVIDIA driver is missing"

driver="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1)"
driver_major="${driver%%.*}"
command -v docker >/dev/null 2>&1 || fail "Docker is missing; select a Hyperstack image ending in 'with Docker'"
docker info >/dev/null 2>&1 || fail "Docker daemon is unavailable"

if ! command -v sshd >/dev/null 2>&1; then
  apt-get update
  apt-get install -y --no-install-recommends openssh-server
fi
ssh_port="${FLEET_SSH_PORT:-22022}"
ssh_user="${FLEET_SSH_USER:-ubuntu}"
install -d -m 0755 /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/60-gpu-fleet.conf <<EOF
Port ${ssh_port}
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitRootLogin prohibit-password
EOF
if [[ -n "${FLEET_SSH_PUBLIC_KEY:-}" ]]; then
  ssh_home="$(getent passwd "$ssh_user" | cut -d: -f6)"
  ssh_group="$(id -gn "$ssh_user")"
  install -d -m 0700 -o "$ssh_user" -g "$ssh_group" "$ssh_home/.ssh"
  printf '%s\n' "$FLEET_SSH_PUBLIC_KEY" >> "$ssh_home/.ssh/authorized_keys"
  sort -u -o "$ssh_home/.ssh/authorized_keys" "$ssh_home/.ssh/authorized_keys"
  chown "$ssh_user:$ssh_group" "$ssh_home/.ssh/authorized_keys"
  chmod 0600 "$ssh_home/.ssh/authorized_keys"
fi
ssh-keygen -A
sshd -t
if command -v systemctl >/dev/null 2>&1 && [[ "$(ps -p 1 -o comm= 2>/dev/null || true)" == "systemd" ]]; then
  systemctl enable --now ssh
  systemctl is-enabled --quiet ssh
  systemctl is-active --quiet ssh
else
  command -v update-rc.d >/dev/null 2>&1 && update-rc.d ssh defaults >/dev/null
  service ssh restart
fi
pgrep -x sshd >/dev/null || fail "SSH startup verification failed"
timeout 5 ssh-keyscan -p "$ssh_port" 127.0.0.1 >/dev/null 2>&1 || fail "SSH handshake verification failed"

validate_image() {
  local candidate="$1"
  local expected_major="$2"
  image="$candidate"
  report checking_registry
  timeout 60 docker manifest inspect "$candidate" >/dev/null || return 1
  report pulling_image
  timeout 20m docker pull "$candidate" || return 1
  report image_pulled
  report validating_cuda
  docker run --rm --gpus all "$candidate" bash -lc "
set -Eeuo pipefail
nvidia-smi
nvcc --version
python - <<'PY'
import torch
assert torch.cuda.is_available(), 'CUDA is unavailable in PyTorch'
assert torch.version.cuda.startswith('${expected_major}.'), f'Expected CUDA ${expected_major}.x, got {torch.version.cuda}'
a=torch.randn(1024,1024,device='cuda')
b=torch.randn(1024,1024,device='cuda')
_ = a @ b
torch.cuda.synchronize()
print('torch',torch.__version__,'cuda',torch.version.cuda,'gpu',torch.cuda.get_device_name(0))
PY
"
}

if (( driver_major >= 580 )); then
  image="${FLEET_CONTAINER_IMAGE_CUDA13:-nvcr.io/nvidia/pytorch:26.03-py3}"
  cuda_label="CUDA 13.2"
  cuda_major=13
  requirement_met=true
  if ! validate_image "$image" 13; then
    [[ "${FLEET_ALLOW_CUDA128_FALLBACK:-0}" == "1" ]] || fail "CUDA 13.2 validation failed and fallback is disabled"
    image="${FLEET_CONTAINER_IMAGE_CUDA128:-nvcr.io/nvidia/pytorch:25.03-py3}"
    cuda_label="CUDA 12.8（降级）"
    cuda_major=12
    requirement_met=false
    validate_image "$image" 12 || fail "CUDA 13.2 and CUDA 12.8 validation both failed"
  fi
elif (( driver_major >= 570 )) && [[ "${FLEET_ALLOW_CUDA128_FALLBACK:-0}" == "1" ]]; then
  image="${FLEET_CONTAINER_IMAGE_CUDA128:-nvcr.io/nvidia/pytorch:25.03-py3}"
  cuda_label="CUDA 12.8（降级）"
  cuda_major=12
  requirement_met=false
  validate_image "$image" 12 || fail "CUDA 12.8 fallback validation failed"
else
  fail "Driver ${driver} cannot run CUDA 13 and CUDA 12.8 fallback is disabled or unsupported"
fi

docker rm -f gpu-fleet-runtime >/dev/null 2>&1 || true
report starting_runtime
env_args=(-e "FLEET_EXPECTED_CUDA_MAJOR=$cuda_major")
for key in FLEET_AGENT_ID FLEET_AGENT_SECRET BASE_URL FLEET_AGENT_BUNDLE_URL FLEET_PROVIDER FLEET_INSTANCE_NAME FLEET_TELEMETRY_PUSH_URL S3_ENDPOINT S3_BUCKET S3_PREFIX S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY; do
  [[ -n "${!key:-}" ]] && env_args+=(-e "$key=${!key}")
done
docker run -d --name gpu-fleet-runtime --restart unless-stopped --gpus all --network host \
  -v /data:/data -v "$state_dir:/var/lib/gpu-fleet" "${env_args[@]}" \
  "$image" bash -lc 'curl -fsSL --retry 5 "${BASE_URL%/}/provision/bootstrap.sh" -o /tmp/bootstrap.sh; bash /tmp/bootstrap.sh; exec sleep infinity'
report installing_dependencies

health_args=()
[[ -n "${FLEET_AGENT_SECRET:-}" ]] && health_args=(-H "authorization: Bearer $FLEET_AGENT_SECRET")
for _ in $(seq 1 180); do
  if curl -fsS "${health_args[@]}" http://127.0.0.1:3000/health >/dev/null; then
    python3 - "$driver" "$cuda_label" "$image" "$requirement_met" "$state_dir/profile.json" <<'PY'
import json, sys

driver, cuda_label, image, requirement_met, path = sys.argv[1:]
try:
    with open(path, encoding='utf-8') as file:
        profile = json.load(file)
except (OSError, ValueError):
    profile = {}
profile.update({
    'status': 'ready',
    'driver': driver,
    'cudaLabel': cuda_label,
    'containerImage': image,
    'requirementMet': requirement_met == 'true',
})
with open(path, 'w', encoding='utf-8') as file:
    json.dump(profile, file, ensure_ascii=False)
PY
    report ready
    exit 0
  fi
  [[ "$(docker inspect -f '{{.State.Running}}' gpu-fleet-runtime 2>/dev/null || true)" == "true" ]] || fail "Runtime container exited during bootstrap"
  sleep 5
done
fail "Runtime Agent did not become healthy within 15 minutes"
