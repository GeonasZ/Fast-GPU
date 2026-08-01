const { AutoDLAdapter, AUTODL_PUBLIC_IMAGES } = require('./adapter');
const { autodlStartupCommand } = require('./startup');
const { createRuntime } = require('./runtime');
const instance = require('./instance');
function createAdapter(env) { return new AutoDLAdapter(env); }
async function validateCredential(adapter) { await adapter.listPrivateImages(); }
function staleInventoryError(options) {
  return Object.assign(
    Error('AutoDL 当前没有满足所选 GPU 规格与镜像条件的宿主机，未创建实例，也不会产生实例卡片'),
    { status: 409, code: 'autodl_no_compatible_host', provider: options.provider, productId: options.productId },
  );
}
module.exports = {
  createAdapter,
  validateCredential,
  autodlStartupCommand,
  AUTODL_PUBLIC_IMAGES,
  legacyExports: { AUTODL_PUBLIC_IMAGES },
  createRuntime,
  instance,
  launch: { profileType: 'docker', managedSsh: true, providerImage: true, staleInventoryError },
  ssh: instance.policy,
  capabilities: ['initialize','ssh','installPackages','upload','download','outboundProbe','gpuBenchmark'],
};
