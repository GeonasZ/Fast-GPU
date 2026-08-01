function hyperstackStartup(env, options) {
  const user = String(env.HYPERSTACK_IMAGE_USER || 'ubuntu').trim();
  const publicKey = String(options.sshPublicKey || '').trim();
  const sshPort = Number(options.sshPort || 22022);
  if (!publicKey) throw new Error('Hyperstack cloud-init requires the managed SSH public key');
  if (!Number.isInteger(sshPort) || sshPort < 1024 || sshPort > 65535) {
    throw new Error('Hyperstack cloud-init requires a valid SSH port');
  }
  const lines = [
    '#cloud-config',
    'package_update: true',
    'packages:',
    '  - openssh-server',
    'write_files:',
    '  - path: /etc/ssh/sshd_config.d/60-fast-gpu.conf',
    "    permissions: '0644'",
    '    content: |',
    `      Port ${sshPort}`,
    '      PasswordAuthentication no',
    '      KbdInteractiveAuthentication no',
    '      PubkeyAuthentication yes',
    '      PermitRootLogin prohibit-password',
    'runcmd:',
    '  - mkdir -p /run/sshd',
    '  - ssh-keygen -A',
    '  - systemctl enable --now ssh',
    '  - systemctl restart ssh',
    'users:',
    `  - name: ${user}`,
    '    shell: /bin/bash',
    '    sudo: ALL=(ALL) NOPASSWD:ALL',
    '    ssh_authorized_keys:',
    `      - ${publicKey}`,
  ];
  return { sshPort, userData: `${lines.join('\n')}\n` };
}

module.exports = { hyperstackStartup };
