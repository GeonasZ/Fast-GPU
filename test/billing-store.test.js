const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBillingStore } = require('../lib/billing-store');

test('billing ledger persists running segments and resumes without duplicates', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-billing-'));
  const filename = path.join(directory, 'fleet.sqlite');
  const env = { FLEET_DATABASE_PATH: filename };
  const started = '2026-01-01T00:00:00.000Z';
  let store = createBillingStore(env);
  store.observe({ id: 'gpu-1', provider: 'runpod', name: 'job', status: 'running', price: 2, priceUnit: 'USD/hour' }, { createdAt: started, at: started });
  assert.equal(store.estimate('runpod', 'gpu-1', Date.parse('2026-01-01T00:30:00.000Z')).amount, 1);
  store.close();

  store = createBillingStore(env);
  store.observe({ id: 'gpu-1', provider: 'runpod', name: 'job', status: 'running', price: 2, priceUnit: 'USD/hour' }, { at: '2026-01-01T00:30:00.000Z' });
  const resumed = store.estimate('runpod', 'gpu-1', Date.parse('2026-01-01T01:00:00.000Z'));
  assert.equal(resumed.amount, 2);
  assert.equal(resumed.segmentCount, 1);
  store.observe({ id: 'gpu-1', provider: 'runpod', status: 'stopped', price: 2, priceUnit: 'USD/hour' }, { at: '2026-01-01T01:00:00.000Z' });
  assert.equal(store.estimate('runpod', 'gpu-1', Date.parse('2026-01-01T02:00:00.000Z')).amount, 2);
  assert.equal(store.estimate('runpod', 'gpu-1').hasRunBefore, true);
  store.close();
});

test('billing ledger keeps provider reconciliation separate from estimates', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-reconciliation-'));
  const store = createBillingStore({ FLEET_DATABASE_PATH: path.join(directory, 'fleet.sqlite') });
  const imported = store.importReconciliation({
    provider: 'ppio', amount: 12.34, currency: 'CNY',
    periodStart: '2026-01-01T00:00:00Z', periodEnd: '2026-01-02T00:00:00Z',
    providerRecordId: 'bill-1',
  });
  assert.equal(imported.amount, 12.34);
  assert.equal(store.listReconciliations().length, 1);
  store.close();
});

test('instance display names persist without replacing the provider name', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-rename-'));
  const store = createBillingStore({ FLEET_DATABASE_PATH: path.join(directory, 'fleet.sqlite') });
  try {
    const instance = { id: 'rename-1', provider: 'ppio', name: 'provider-name', status: 'running', price: 1, priceUnit: 'CNY/hour' };
    store.observe(instance);
    assert.equal(store.renameInstance('ppio', 'rename-1', '训练任务 A').display_name, '训练任务 A');
    const refreshed = { ...instance, name: 'provider-name' };
    store.observe(refreshed);
    assert.equal(refreshed.name, '训练任务 A');
    assert.equal(refreshed.providerNameOriginal, 'provider-name');
    assert.throws(() => store.renameInstance('ppio', 'rename-1', ''));
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
