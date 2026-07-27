function minimalSshCommand({port,publicKey,user='root',keepAlive=false}) {
  const home=user==='root'?'/root':`/home/${user}`;
  const commands=[
    `command -v sshd >/dev/null 2>&1||{ apt-get update&&apt-get install -y --no-install-recommends openssh-server; }`,
    `mkdir -p /run/sshd ${home}/.ssh /etc/ssh/sshd_config.d`,
    `chmod 700 ${home}/.ssh`,
    `printf '%s\\n' '${String(publicKey||'').replaceAll("'","'\"'\"'")}' >${home}/.ssh/authorized_keys`,
    `chmod 600 ${home}/.ssh/authorized_keys`,
    `printf 'Port %s\\nPasswordAuthentication no\\nPubkeyAuthentication yes\\nPermitRootLogin prohibit-password\\n' '${Number(port)}' >/etc/ssh/sshd_config.d/60-fast-gpu.conf`,
    `ssh-keygen -A`,
    `sshd -t`,
    `pgrep -x sshd >/dev/null 2>&1||/usr/sbin/sshd`
  ];
  if(keepAlive)commands.push(`exec sleep infinity`);
  return commands.join(';');
}

module.exports={minimalSshCommand};
