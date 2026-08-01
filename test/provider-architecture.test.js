const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { entries: cloudEntries, adapters, definitions: cloudDefinitions } = require('../lib/cloud_compute/registry');
const {
  entries: s3Entries,
  definitions: s3Definitions,
  provisioningConfigs: s3ProvisioningConfigs,
} = require('../lib/s3/registry');
const startupProfiles = require('../lib/startup_profiles/registry');

test('provider registries preserve every persisted provider id', () => {
  const cloudIds = cloudEntries().map(entry => entry.id);
  const s3Ids = s3Entries().map(entry => entry.id);
  assert.deepEqual(cloudIds, ['ppio', 'autodl', 'hyperstack', 'runpod']);
  assert.deepEqual(s3Ids, ['r2', 'oss']);
  assert.deepEqual(Object.keys(adapters({})), cloudIds);
});

test('provider YAML declarations are valid and never expose executable decoders', () => {
  const configs = [...cloudDefinitions(), ...s3Definitions()];
  assert.deepEqual(configs.map(item => item.id), [
    ...cloudEntries().map(entry => entry.id),
    ...s3Entries().map(entry => entry.id),
  ]);
  for (const config of configs) {
    assert.ok(config.title);
    assert.ok(config.fields.length);
    for (const field of config.fields) {
      assert.ok(field.storageKey);
      if (field.control === 'password') assert.equal(field.masked, true);
      if (field.optionsSource) assert.match(field.optionsSource.url, /^\/api\//);
      if (field.autoFill) assert.match(field.autoFill.url, /^\/api\//);
    }
  }
});

test('S3 declarations preserve all existing environment storage keys', () => {
  const keys = s3Definitions().flatMap(config => config.fields.map(field => field.storageKey));
  for (const key of [
    'R2_S3_ENABLED', 'R2_S3_ENDPOINT', 'R2_S3_BUCKET', 'R2_S3_PREFIX',
    'R2_S3_REGION', 'R2_S3_ACCESS_KEY_ID', 'R2_S3_SECRET_ACCESS_KEY',
    'OSS_S3_ENABLED', 'OSS_S3_ENDPOINT', 'OSS_S3_BUCKET', 'OSS_S3_PREFIX',
    'OSS_S3_REGION', 'OSS_S3_ACCESS_KEY_ID', 'OSS_S3_SECRET_ACCESS_KEY',
  ]) assert.ok(keys.includes(key), `missing persisted key ${key}`);
});

test('S3 provisioning payload is normalized without provider branches in common code', () => {
  const env = {};
  for (const entry of s3Entries()) {
    for (const field of entry.config.fields) {
      if (field.id === 'enabled') env[field.storageKey] = '1';
      else if (field.id === 'endpoint') env[field.storageKey] = `https://${entry.id}.storage.test`;
      else if (field.id === 'accessKeyId') env[field.storageKey] = `${entry.id}-access`;
      else if (field.id === 'secretAccessKey') env[field.storageKey] = `${entry.id}-secret`;
      else if (field.id === 'region') env[field.storageKey] = field.default || 'test-region';
    }
  }
  const configs = s3ProvisioningConfigs(env);
  assert.deepEqual(configs.map(item => item.name), s3Entries().map(item => item.id));
  assert.ok(configs.every(item => item.endpoint && item.accessKeyId && item.secretAccessKey));
});

test('legacy startup imports resolve to provider-owned implementations', () => {
  const pairs = [
    ['ppio', 'ppioStartupCommand'],
    ['autodl', 'autodlStartupCommand'],
    ['runpod', 'runpodStartupCommand'],
    ['hyperstack', 'hyperstackStartup'],
  ];
  for (const [id, exportName] of pairs) {
    const legacy = require(path.join('..', 'lib', 'provider-startup', id));
    const current = require(path.join('..', 'lib', 'cloud_compute', id, 'startup'));
    assert.strictEqual(legacy[exportName], current[exportName]);
  }
});

test('every cloud provider owns the complete instance capability interface', () => {
  const operations = [
    'initialize', 'resolveSsh', 'installPackages', 'upload', 'download',
    'outboundProbe', 'gpuBenchmark', 'shouldUsePasswordTerminal',
  ];
  for (const entry of cloudEntries()) {
    assert.ok(entry.implementation.instance, `${entry.id} has no instance interface`);
    for (const operation of operations)
      assert.equal(
        typeof entry.implementation.instance[operation],
        'function',
        `${entry.id} does not implement ${operation}`,
      );
  }
});

test('built-in startup profiles are isolated directories with stable ids', () => {
  const profiles = startupProfiles.entries({});
  assert.deepEqual(
    profiles.map(profile => profile.id).sort(),
    [
      'preset-ngc-24.10', 'preset-ngc-25.01', 'preset-pytorch-2.10',
      'preset-pytorch-2.11', 'preset-pytorch-2.7', 'preset-vm-default',
    ],
  );
  assert.ok(profiles.every(profile => profile.script.startsWith('#!/usr/bin/env bash')));
});

test('common modules contain no registered provider ids', () => {
  const fs = require('node:fs');
  const cloudIds = cloudEntries().map(entry => entry.id);
  const s3Ids = s3Entries().map(entry => entry.id);
  const commonFiles = [
    'server.js', 'public/app.js', 'public/providers-page.js',
    'public/instances-page.js', 'public/storage-page.js', 'public/index.html',
    'lib/provisioning.js', 'lib/provider-config.js', 'lib/provider-validation.js',
    'lib/cloud_compute/registry.js', 'lib/s3/registry.js',
    'lib/cloud_compute/common/http.js',
    'lib/cloud_compute/common/instance-capabilities.js',
    'agent/bootstrap.sh', 'agent/telemetry.py',
  ];
  for (const filename of commonFiles) {
    const source = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8').toLowerCase();
    for (const id of [...cloudIds, ...s3Ids])
      assert.doesNotMatch(source, new RegExp(`\\b${id}\\b`, 'i'), `${filename} hardcodes ${id}`);
  }
});

test('instance refresh dispatches provider-owned frontend lifecycle hooks', () => {
  const fs = require('node:fs');
  const providersPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'providers-page.js'), 'utf8');
  const instancesPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'instances-page.js'), 'utf8');
  const providerClient = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'cloud_compute', 'ppio', 'client.js'),
    'utf8',
  );
  assert.match(providersPage, /function runProviderExtensionHook\(/);
  assert.match(instancesPage, /runProviderExtensionHook\("instancesLoaded"/);
  assert.doesNotMatch(instancesPage, /applyInstancePrices\(/);
  assert.match(providerClient, /instancesLoaded\(/);
});

test('server exposes provider declarations without credential values', () => {
  const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /\/api\/provider-config/);
  assert.match(source, /cloudProviderConfigDefinitions/);
  assert.doesNotMatch(JSON.stringify([...cloudDefinitions(), ...s3Definitions()]), /secret-[a-z0-9]/i);
});
