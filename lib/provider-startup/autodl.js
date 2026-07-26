const {minimalSshCommand}=require('./minimal-ssh');

function autodlStartupCommand(env,{sshPublicKey}) {
  return minimalSshCommand({port:22,publicKey:sshPublicKey});
}

module.exports={autodlStartupCommand};
