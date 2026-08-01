const { PpioAdapter } = require('./adapter');
const { ppioStartupCommand } = require('./startup');
const { createRuntime } = require('./runtime');
const instance = require('./instance');
function createAdapter(env) { return new PpioAdapter(env); }
async function validateCredential(adapter) { await adapter.listClusters(); }
module.exports = {
  createAdapter,
  validateCredential,
  ppioStartupCommand,
  createRuntime,
  instance,
  launch: { profileType: 'docker', managedSsh: true },
  ssh: instance.policy,
  capabilities: ['initialize','ssh','installPackages','upload','download','outboundProbe','gpuBenchmark'],
};
