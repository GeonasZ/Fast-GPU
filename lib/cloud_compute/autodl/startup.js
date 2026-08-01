const { minimalSshCommand } = require('../common/minimal-ssh');

function autodlStartupCommand(_env, { sshPublicKey }) {
  return minimalSshCommand({ port: 22, publicKey: sshPublicKey });
}

module.exports = { autodlStartupCommand };
