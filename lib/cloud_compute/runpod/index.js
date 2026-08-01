const { RunPodAdapter } = require('./adapter');
const { runpodStartupCommand } = require('./startup');
const instance = require('./instance');
function createAdapter(env) { return new RunPodAdapter(env); }
async function validateCredential(adapter) { await adapter.accountBalance(); }
module.exports = {
  createAdapter,
  validateCredential,
  runpodStartupCommand,
  instance,
  launch: { profileType: 'docker', managedSsh: true },
  ssh: instance.policy,
  capabilities: ['initialize','ssh','installPackages','upload','download','outboundProbe','gpuBenchmark'],
};
