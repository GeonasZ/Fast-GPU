const DEFAULT_TIMEOUT = 30000;

class ProviderError extends Error {
  constructor(provider, message, status = 502, details) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
    this.details = details;
  }
}

async function call(provider, base, pathname, { method = 'GET', headers = {}, body, query } = {}) {
  const url = new URL(pathname, base);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  try {
    const response = await fetch(url, {
      method,
      headers: { accept: 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch { data = { raw: text.slice(0, 1000) }; }
    if (!response.ok) {
      const reason = data?.reason || data?.data?.message || data?.data?.reason || data?.error?.message || data?.message || data?.msg || data?.error;
      throw new ProviderError(
        provider,
        `${provider} API ${response.status}${reason ? `: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}` : ''}`,
        response.status,
        data,
      );
    }
    if (data?.code && !['Success', 0, 200].includes(data.code)) {
      throw new ProviderError(provider, data.message || data.msg || `${provider} API error`, 502, data);
    }
    return data;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      provider,
      error.name === 'AbortError' ? `${provider} API timeout` : error.message,
      502,
    );
  } finally {
    clearTimeout(timer);
  }
}

const normalizeStatus = value => ({
  Running: 'running', Stopped: 'stopped', Starting: 'provisioning', Initializing: 'provisioning',
  PullingImage: 'provisioning', Pending: 'provisioning', RUNNING: 'running', ACTIVE: 'running',
  EXITED: 'stopped', SHUTOFF: 'stopped', SHUTDOWN: 'stopped', HIBERNATED: 'stopped',
  CREATING: 'provisioning', BUILD: 'provisioning', PENDING: 'provisioning', TERMINATED: 'terminated',
  running: 'running', exited: 'stopped', stopped: 'stopped', shutdown: 'stopped', pending: 'provisioning',
  toCreate: 'provisioning', creating: 'provisioning', pulling: 'provisioning', toStart: 'provisioning',
  starting: 'provisioning', toRestart: 'provisioning', restarting: 'provisioning', toReset: 'provisioning',
  resetting: 'provisioning', migrating: 'provisioning', toStop: 'stopping', stopping: 'stopping',
  toRemove: 'terminating', removing: 'terminating', removed: 'terminated',
}[value] || String(value || 'unknown').toLowerCase());

function providerProvisionProgress(instance) {
  const source = instance.imagePullProgress || instance.pullProgress || instance.progress || instance.statusProgress || {};
  const loaded = Number(source.loadedBytes ?? source.currentBytes ?? source.downloadedBytes ?? instance.downloadedBytes);
  const total = Number(source.totalBytes ?? source.sizeBytes ?? instance.totalBytes);
  let percent = Number(source.percent ?? source.percentage ?? instance.progressPercent);
  if (!Number.isFinite(percent) && Number.isFinite(loaded) && Number.isFinite(total) && total > 0) percent = loaded / total * 100;
  const state = String(source.state || source.phase || instance.status || '');
  const message = String(source.message || instance.statusMessage || instance.statusDetail || instance.message || '');
  const pulling = /pull|download|image/i.test(`${state} ${message}`);
  if (!pulling && !Number.isFinite(percent) && !Number.isFinite(loaded)) return undefined;
  return {
    phase: pulling ? 'pulling_image' : state || 'provisioning',
    label: pulling ? '正在拉取容器镜像' : '正在初始化',
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : undefined,
    loadedBytes: Number.isFinite(loaded) ? loaded : undefined,
    totalBytes: Number.isFinite(total) ? total : undefined,
    message: message || undefined,
  };
}

function authRequired(name, value, envName) {
  if (!value) throw new ProviderError(name, `缺少服务端环境变量 ${envName}`, 503);
  return value;
}


async function mapLimit(items, limit, fn) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      output[index] = await fn(items[index], index);
    }
  }));
  return output;
}

module.exports = {
  ProviderError,
  call,
  normalizeStatus,
  providerProvisionProgress,
  authRequired,
  mapLimit,
};
