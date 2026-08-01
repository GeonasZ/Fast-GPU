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
      if (config.kind !== 'cloud_compute' || config.id !== item.name) {
        throw new Error(`Cloud provider directory ${item.name} does not match its declaration`);
      }
      return Object.freeze({ id: config.id, config, implementation: require(implementation) });
    })
    .filter(Boolean)
    .sort((a, b) => Number(a.config.order || 0) - Number(b.config.order || 0) || a.id.localeCompare(b.id));
  return Object.freeze(cachedEntries);
}

function adapters(env = process.env) {
  return Object.fromEntries(entries().map(entry => [entry.id, entry.implementation.createAdapter(env)]));
}

function definitions() {
  return entries().map(entry => publicProviderConfig(entry.config));
}

function providerModule(id) {
  const entry = entries().find(item => item.id === id);
  if (!entry) throw Object.assign(new Error(`Unknown cloud provider: ${id}`), { status: 400 });
  return entry.implementation;
}

module.exports = { adapters, definitions, entries, providerModule };
