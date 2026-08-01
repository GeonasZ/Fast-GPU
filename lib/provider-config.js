const fs = require('node:fs');
const path = require('node:path');

const KINDS = new Set(['cloud_compute', 's3']);
const CONTROLS = new Set(['text', 'password', 'url', 'checkbox', 'select', 'popup']);
const DECODERS = new Set(['json', 'text', 'base64-json']);

function assertLocalApiSource(source, providerId, key) {
  if (!source) return;
  if (!source.url || !String(source.url).startsWith('/api/')) {
    throw new Error(`${providerId}.${key}.url must be a same-origin /api/ path`);
  }
  if (source.decoder && !DECODERS.has(source.decoder)) {
    throw new Error(`${providerId}.${key}.decoder is unsupported`);
  }
}

function validateProviderConfig(config, filename) {
  if (!config || typeof config !== 'object' || !config.id || !KINDS.has(config.kind)) {
    throw new Error(`Invalid provider config: ${filename}`);
  }
  if (!Array.isArray(config.fields)) throw new Error(`${config.id}.fields must be an array`);
  if (config.clientModule && !/^[a-zA-Z0-9._-]+\.js$/.test(config.clientModule)) {
    throw new Error(`${config.id}.clientModule must be a local JavaScript filename`);
  }
  const ids = new Set();
  for (const field of config.fields) {
    if (!field.id || !field.storageKey || !CONTROLS.has(field.control)) {
      throw new Error(`${config.id} contains an invalid field`);
    }
    if (ids.has(field.id)) throw new Error(`${config.id} contains duplicate field ${field.id}`);
    ids.add(field.id);
    if (field.control === 'password' && field.masked !== true) {
      throw new Error(`${config.id}.${field.id} password fields must be masked`);
    }
    assertLocalApiSource(field.optionsSource, config.id, `${field.id}.optionsSource`);
    assertLocalApiSource(field.autoFill, config.id, `${field.id}.autoFill`);
  }
  return Object.freeze(config);
}

function loadProviderConfig(filename) {
  const absolute = path.resolve(filename);
  return validateProviderConfig(JSON.parse(fs.readFileSync(absolute, 'utf8')), absolute);
}

function publicProviderConfig(config) {
  return {
    id: config.id,
    kind: config.kind,
    title: config.title,
    description: config.description || '',
    currency: config.currency || '',
    portals: config.portals || [],
    fields: config.fields.map(field => ({ ...field })),
    launch: config.launch || {},
    offerPresentation: config.offerPresentation || 'standard',
    clientModule: config.clientModule
      ? `/provider-assets/${encodeURIComponent(config.id)}/${encodeURIComponent(config.clientModule)}`
      : '',
    errorPolicies: config.errorPolicies || {},
    instanceAccess: config.instanceAccess || null,
  };
}

module.exports = { loadProviderConfig, publicProviderConfig, validateProviderConfig };
