const fs = require('node:fs');
const path = require('node:path');
const { loadProviderConfig, publicProviderConfig } = require('../provider-config');

let cachedEntries;

function entries() {
  if (cachedEntries) return cachedEntries;
  cachedEntries = fs.readdirSync(__dirname, { withFileTypes: true })
    .filter(item => item.isDirectory())
    .map(item => {
      const directory = path.join(__dirname, item.name);
      const filename = path.join(directory, 'provider.yaml');
      const implementation = path.join(directory, 'index.js');
      if (!fs.existsSync(filename) || !fs.existsSync(implementation)) return null;
      const config = loadProviderConfig(filename);
      if (config.kind !== 's3' || config.id !== item.name) {
        throw new Error(`S3 provider directory ${item.name} does not match its declaration`);
      }
      return Object.freeze({ id: config.id, config, implementation: require(implementation) });
    })
    .filter(Boolean)
    .sort((a, b) => Number(a.config.order || 0) - Number(b.config.order || 0) || a.id.localeCompare(b.id));
  return Object.freeze(cachedEntries);
}

function definitions() {
  return entries().map(entry => publicProviderConfig(entry.config));
}

function providerModule(id) {
  const entry = entries().find(item => item.id === id);
  if (!entry) throw Object.assign(new Error(`Unknown S3 provider: ${id}`), { status: 400 });
  return entry.implementation;
}

function enabled(value) {
  return value === true || value === 1 || /^(?:1|true|yes|on)$/i.test(String(value || ''));
}

function provisioningConfigs(env = process.env) {
  return entries().flatMap(entry => {
    const values = Object.fromEntries(
      entry.config.fields.map(field => [field.id, env[field.storageKey] ?? field.default ?? '']),
    );
    if (!enabled(values.enabled)) return [];
    return [{
      name: entry.id,
      provider: entry.implementation.rcloneProvider || 'Other',
      endpoint: entry.implementation.normalizeEndpoint(values.endpoint),
      accessKeyId: String(values.accessKeyId || ''),
      secretAccessKey: String(values.secretAccessKey || ''),
      region: entry.implementation.resolveRegion(values.region),
    }];
  });
}

function provisioningEnvironment(env = process.env) {
  const configs = provisioningConfigs(env);
  if (!configs.length) return {};
  return {
    FLEET_STORAGE_PROVIDERS_B64: Buffer.from(JSON.stringify(configs), 'utf8').toString('base64'),
  };
}

module.exports = {
  definitions,
  entries,
  providerModule,
  provisioningConfigs,
  provisioningEnvironment,
};
