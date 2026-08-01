const { minimalSshCommand } = require('../common/minimal-ssh');

function runpodStartupCommand(env, { sshPublicKey } = {}) {
  return minimalSshCommand({
    port: Number(env.FLEET_SSH_PORT || 22022),
    publicKey: sshPublicKey,
    keepAlive: true,
  });
}

module.exports = { runpodStartupCommand };
