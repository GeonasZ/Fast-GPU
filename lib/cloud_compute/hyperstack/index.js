const { HyperstackAdapter } = require('./adapter');
const { hyperstackStartup } = require('./startup');
const { createRuntime } = require('./runtime');
const instance = require('./instance');
function createAdapter(env) { return new HyperstackAdapter(env); }
async function validateCredential(adapter) { await adapter.configurationResources(); }
function status(env) {
  return {
    hyperstackConfig: {
      environment: env.HYPERSTACK_ENVIRONMENT || '',
      region: env.HYPERSTACK_REGION || '',
      keyName: env.HYPERSTACK_KEY_NAME || '',
      keypairId: env.HYPERSTACK_KEYPAIR_ID || '',
      keypairEnvironment: env.HYPERSTACK_KEYPAIR_ENVIRONMENT || '',
      imageName: env.HYPERSTACK_IMAGE_NAME || '',
      agentCidr: env.HYPERSTACK_AGENT_CIDR || '0.0.0.0/0',
      imageUser: env.HYPERSTACK_IMAGE_USER || '',
    },
  };
}
const launch = {
  profileType: 'vm',
  managedSsh: false,
  deferredAgentCredential: true,
  async prepare(options, context) { return context.prepare(options); },
  async afterCreate(item, options, context) { return context.provision(item, options); },
};
module.exports = {
  createAdapter,
  validateCredential,
  status,
  hyperstackStartup,
  createRuntime,
  instance,
  launch,
  ssh: instance.policy,
  telemetry: { reinjectWhenDisconnected: false },
  capabilities: ['initialize','ssh','installPackages','upload','download','outboundProbe','gpuBenchmark'],
};
