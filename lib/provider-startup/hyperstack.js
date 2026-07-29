// Hyperstack creates a VM, so SSH must be bootstrapped before the platform can
// upload the full provisioning bundle over SSH.
function hyperstackStartup(env, options) {
  const user=String(env.HYPERSTACK_IMAGE_USER||'ubuntu').trim();
  const publicKey=String(options.sshPublicKey||'').trim();
  if(!publicKey) throw new Error('Hyperstack cloud-init requires the managed SSH public key');
  const lines=[
    '#cloud-config',
    'package_update: true',
    'packages:',
    '  - openssh-server',
    'runcmd:',
    '  - mkdir -p /run/sshd',
    '  - ssh-keygen -A',
    '  - systemctl enable --now ssh',
  ];
  lines.push('users:',`  - name: ${user}`,'    shell: /bin/bash','    sudo: ALL=(ALL) NOPASSWD:ALL','    ssh_authorized_keys:',`      - ${publicKey}`);
  return {sshPort:22,userData:`${lines.join('\n')}\n`};
}

module.exports={hyperstackStartup};
