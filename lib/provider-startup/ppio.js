const {shellQuote}=require('../provisioning');
const {minimalSshCommand}=require('./minimal-ssh');

function ppioStartupCommand(env,{sshPublicKey}={}) {
  const startup=minimalSshCommand({
    port:Number(env.FLEET_SSH_PORT||22022),
    publicKey:sshPublicKey,
    keepAlive:true
  });
  return `bash -lc ${shellQuote(startup)}`;
}

module.exports={ppioStartupCommand};
