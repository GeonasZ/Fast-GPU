'use strict';

function delegate(operation) {
  return async function run(request, context) {
    if (typeof context?.[operation] !== 'function') {
      throw Object.assign(new Error(`Instance operation is unavailable: ${operation}`), {
        status: 501,
        code: 'instance_operation_unavailable',
      });
    }
    return context[operation](request);
  };
}

function createInstanceCapabilities(sshPolicy = {}) {
  const policy = Object.freeze({
    allowDefaultPort: false,
    useInternalPort: false,
    defaultAdoptionUser: 'root',
    passwordFallback: 'never',
    ...sshPolicy,
  });

  return Object.freeze({
    policy,
    initialize: delegate('initialize'),
    installPackages: delegate('installPackages'),
    upload: delegate('upload'),
    download: delegate('download'),
    outboundProbe: delegate('outboundProbe'),
    gpuBenchmark: delegate('gpuBenchmark'),

    async resolveSsh(instance, context) {
      const { adapter, saved, store } = context;
      if (!saved) return null;
      let host = saved.host;
      let port = Number(saved.externalPort || (policy.useInternalPort ? saved.internalPort : 0));
      if ((!host || !port) && typeof adapter.resolveSshEndpoint === 'function') {
        ({ host, port } = await adapter.resolveSshEndpoint(instance.id, saved.internalPort));
      } else if (!host || !port) {
        const listed = await adapter.listInstances();
        const current = listed.find(item => String(item.id) === String(instance.id));
        if (!current) {
          throw Object.assign(new Error('实例不存在或厂商 API 暂未返回实例'), {
            status: 404,
            code: 'ssh_provider_error',
          });
        }
        host = current.sshHost || current.ip;
        port = port || Number(current.sshPort);
      }
      if (!host || !port) {
        throw Object.assign(new Error('厂商尚未分配 SSH 公网地址或映射端口'), {
          status: 409,
          code: 'ssh_pending',
        });
      }
      if (port === 22 && !policy.allowDefaultPort) {
        throw Object.assign(new Error('拒绝使用默认 SSH 端口'), {
          status: 409,
          code: 'ssh_provider_error',
        });
      }
      return store.update(instance.providerId, instance.id, { host, externalPort: port });
    },

    async shouldUsePasswordTerminal({ saved, verifyManagedKey }) {
      if (policy.passwordFallback === 'when-unsaved') return !saved;
      if (policy.passwordFallback !== 'when-key-rejected' || !saved) return false;
      try {
        await verifyManagedKey();
        return false;
      } catch (error) {
        if (/permission denied \(publickey\)/i.test(error.message)) return true;
        throw error;
      }
    },
  });
}

module.exports = { createInstanceCapabilities };
