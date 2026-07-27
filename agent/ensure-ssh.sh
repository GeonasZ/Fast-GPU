#!/usr/bin/env bash
set -Eeuo pipefail

export DEBIAN_FRONTEND=noninteractive
ssh_port="${FLEET_SSH_PORT:-22}"

if ! command -v sshd >/dev/null 2>&1; then
  apt-get update
  apt-get install -y --no-install-recommends openssh-server
fi

install -d -m 0755 /run/sshd /etc/ssh/sshd_config.d /var/lib/fast-gpu
cat > /etc/ssh/sshd_config.d/60-fast-gpu.conf <<EOF
Port ${ssh_port}
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitEmptyPasswords no
PermitRootLogin prohibit-password
EOF

if [[ -n "${FLEET_SSH_PUBLIC_KEY:-}" ]]; then
  ssh_user="${FLEET_SSH_USER:-root}"
  home_dir="$(getent passwd "$ssh_user" | cut -d: -f6)"
  [[ -n "$home_dir" ]] || { echo "SSH user does not exist: $ssh_user" >&2; exit 30; }
  ssh_group="$(id -gn "$ssh_user")"
  install -d -m 0700 -o "$ssh_user" -g "$ssh_group" "$home_dir/.ssh"
  printf '%s\n' "$FLEET_SSH_PUBLIC_KEY" > "$home_dir/.ssh/authorized_keys"
  chown "$ssh_user:$ssh_group" "$home_dir/.ssh/authorized_keys"
  chmod 0600 "$home_dir/.ssh/authorized_keys"
fi

ssh-keygen -A
sshd -t

autostart_mode=direct
if command -v systemctl >/dev/null 2>&1 && [[ "$(ps -p 1 -o comm= 2>/dev/null || true)" == "systemd" ]]; then
  unit=ssh
  systemctl list-unit-files ssh.service >/dev/null 2>&1 || unit=sshd
  systemctl enable --now "$unit"
  systemctl is-enabled --quiet "$unit"
  systemctl is-active --quiet "$unit"
  autostart_mode=systemd
elif command -v service >/dev/null 2>&1; then
  command -v update-rc.d >/dev/null 2>&1 && update-rc.d ssh defaults >/dev/null
  service ssh restart
  autostart_mode=sysv
else
  pkill -x sshd >/dev/null 2>&1 || true
  /usr/sbin/sshd
fi

# Container providers rerun bootstrap.sh on each container start, which is the
# persistence mechanism when there is no init system inside the image.
[[ "$autostart_mode" == direct ]] && autostart_mode=bootstrap
printf '%s\n' "$autostart_mode" > /var/lib/fast-gpu/ssh-autostart-mode

pgrep -x sshd >/dev/null
if command -v ss >/dev/null 2>&1; then
  ss -ltn | awk -v port=":${ssh_port}" '$4 ~ port "$" { found=1 } END { exit !found }'
else
  timeout 2 bash -c "</dev/tcp/127.0.0.1/${ssh_port}"
fi
timeout 5 ssh-keyscan -p "$ssh_port" 127.0.0.1 >/dev/null 2>&1

printf 'SSH is running on port %s; autostart=%s\n' "$ssh_port" "$autostart_mode"
