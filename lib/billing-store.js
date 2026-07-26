const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_USER_ID = 'user:default';
const DEFAULT_WORKSPACE_ID = 'workspace:default';

function createBillingStore(env = process.env) {
  const filename = path.resolve(env.FLEET_DATABASE_PATH || path.join(__dirname, '..', '.data', 'fleet.sqlite'));
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS provider_accounts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      name TEXT NOT NULL,
      external_account_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (workspace_id, provider, name)
    );
    CREATE TABLE IF NOT EXISTS managed_instances (
      provider TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      provider_account_id TEXT NOT NULL,
      name TEXT,
      display_name TEXT,
      product_id TEXT,
      status TEXT NOT NULL,
      ever_running INTEGER NOT NULL DEFAULT 0,
      price REAL,
      currency TEXT,
      price_period TEXT,
      price_source TEXT,
      created_at TEXT NOT NULL,
      first_observed_at TEXT NOT NULL,
      last_observed_at TEXT NOT NULL,
      deleted_at TEXT,
      PRIMARY KEY (provider, provider_instance_id)
    );
    CREATE INDEX IF NOT EXISTS managed_instances_workspace_owner
      ON managed_instances(workspace_id, owner_user_id);
    CREATE TABLE IF NOT EXISTS provider_account_credentials (
      provider_account_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      credential_key_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS billing_segments (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      price REAL,
      currency TEXT,
      price_period TEXT NOT NULL,
      price_source TEXT,
      start_reason TEXT NOT NULL,
      end_reason TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS billing_segments_one_open
      ON billing_segments(provider, provider_instance_id) WHERE ended_at IS NULL;
    CREATE TABLE IF NOT EXISTS cost_reconciliations (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_account_id TEXT NOT NULL,
      provider_instance_id TEXT,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      source TEXT NOT NULL,
      provider_record_id TEXT,
      imported_at TEXT NOT NULL,
      UNIQUE(provider, provider_account_id, provider_record_id)
    );
  `);
  if (!db.prepare("SELECT 1 FROM pragma_table_info('managed_instances') WHERE name = 'display_name'").get()) {
    db.exec('ALTER TABLE managed_instances ADD COLUMN display_name TEXT');
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('managed_instances') WHERE name = 'ever_running'").get()) {
    db.exec('ALTER TABLE managed_instances ADD COLUMN ever_running INTEGER NOT NULL DEFAULT 0');
  }

  const now = new Date().toISOString();
  db.prepare('INSERT OR IGNORE INTO users (id, display_name, created_at) VALUES (?, ?, ?)').run(DEFAULT_USER_ID, 'Default user', now);
  db.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').run(DEFAULT_WORKSPACE_ID, 'Default workspace', now);
  db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run(DEFAULT_WORKSPACE_ID, DEFAULT_USER_ID, 'owner', now);

  const getInstance = db.prepare('SELECT * FROM managed_instances WHERE provider = ? AND provider_instance_id = ?');
  const openSegment = db.prepare('SELECT * FROM billing_segments WHERE provider = ? AND provider_instance_id = ? AND ended_at IS NULL');
  const insertSegment = db.prepare(`INSERT INTO billing_segments
    (id, provider, provider_instance_id, started_at, price, currency, price_period, price_source, start_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const closeSegment = db.prepare(`UPDATE billing_segments SET ended_at = ?, end_reason = ?
    WHERE provider = ? AND provider_instance_id = ? AND ended_at IS NULL`);

  function providerAccount(provider, workspaceId = DEFAULT_WORKSPACE_ID) {
    const id = `provider-account:${workspaceId}:${provider}`;
    const timestamp = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO provider_accounts
      (id, workspace_id, provider, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, workspaceId, provider, `${provider} default`, timestamp, timestamp);
    return id;
  }

  function parsePriceUnit(value) {
    const [currency = 'CNY', period = 'hour'] = String(value || 'CNY/hour').split('/');
    return { currency, period };
  }

  function observe(instance, options = {}) {
    const provider = String(instance.provider), id = String(instance.id);
    const timestamp = options.at || new Date().toISOString();
    const previous = getInstance.get(provider, id);
    const accountId = options.providerAccountId || previous?.provider_account_id || providerAccount(provider);
    const unit = parsePriceUnit(instance.priceUnit || (previous?.currency && `${previous.currency}/${previous.price_period}`));
    const price = Number(instance.price);
    const usablePrice = Number.isFinite(price) && price > 0 ? price : previous?.price;
    const observedStatus = String(instance.status || 'unknown');
    const status = (
      ['stopping', 'terminating'].includes(previous?.status) && ['running', 'provisioning'].includes(observedStatus)
    ) || (
      previous?.status === 'starting' && observedStatus === 'stopped'
    ) ? previous.status : observedStatus;
    if (!previous) {
      db.prepare(`INSERT INTO managed_instances
        (provider, provider_instance_id, workspace_id, owner_user_id, provider_account_id, name, product_id,
         status, ever_running, price, currency, price_period, price_source, created_at, first_observed_at, last_observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(provider, id, options.workspaceId || DEFAULT_WORKSPACE_ID, options.ownerUserId || DEFAULT_USER_ID,
          accountId, instance.name || id, instance.productId || null, status, observedStatus === 'running' ? 1 : 0, usablePrice || null,
          unit.currency, unit.period, instance.priceSource || options.priceSource || 'provider-observation',
          options.createdAt || timestamp, timestamp, timestamp);
    } else {
      db.prepare(`UPDATE managed_instances SET name = ?, product_id = COALESCE(?, product_id), status = ?, ever_running = CASE WHEN ? = 'running' THEN 1 ELSE ever_running END,
        price = COALESCE(?, price), currency = COALESCE(?, currency), price_period = COALESCE(?, price_period),
        price_source = COALESCE(?, price_source), last_observed_at = ?, deleted_at = CASE WHEN ? = 'terminated' THEN ? ELSE deleted_at END
        WHERE provider = ? AND provider_instance_id = ?`)
        .run(instance.name || previous.name, instance.productId || null, status, observedStatus, usablePrice || null,
          unit.currency, unit.period, instance.priceSource || null, timestamp, status, timestamp, provider, id);
    }
    const running = ['running', 'provisioning', 'starting'].includes(status);
    const segment = openSegment.get(provider, id);
    if (running && !segment && !['stopping', 'terminating'].includes(previous?.status)) {
      insertSegment.run(randomUUID(), provider, id, options.createdAt || timestamp, usablePrice || null,
        unit.currency, unit.period, instance.priceSource || options.priceSource || 'provider-observation',
        options.createdAt ? 'platform_create' : 'status_observed_running');
    } else if (!running && segment) {
      closeSegment.run(timestamp, `status_observed_${status}`, provider, id);
    }
    const record = getInstance.get(provider, id);
    if (record?.display_name) {
      instance.providerNameOriginal = instance.name;
      instance.name = record.display_name;
    }
    return record;
  }

  function markMissing(provider, ids, at = new Date().toISOString()) {
    const rows = db.prepare('SELECT provider_instance_id, created_at, status FROM managed_instances WHERE provider = ? AND deleted_at IS NULL').all(provider);
    const present = new Set(ids.map(String));
    for (const row of rows) {
      if (present.has(String(row.provider_instance_id))) continue;
      if (row.status !== 'terminating' && Date.parse(at) - Date.parse(row.created_at) < 20 * 60 * 1000) continue;
      closeSegment.run(at, 'instance_missing_from_provider', provider, row.provider_instance_id);
      db.prepare(`UPDATE managed_instances SET status = 'terminated', deleted_at = ?, last_observed_at = ?
        WHERE provider = ? AND provider_instance_id = ?`).run(at, at, provider, row.provider_instance_id);
    }
  }

  function estimate(provider, id, at = Date.now()) {
    const record = getInstance.get(String(provider), String(id));
    if (!record) return null;
    const segments = db.prepare('SELECT * FROM billing_segments WHERE provider = ? AND provider_instance_id = ? ORDER BY started_at').all(String(provider), String(id));
    const totals = {};
    let unknownSeconds = 0;
    for (const segment of segments) {
      const endedAt = segment.ended_at ? Date.parse(segment.ended_at) : Number(at);
      const seconds = Math.max(0, (endedAt - Date.parse(segment.started_at)) / 1000);
      if (Number.isFinite(segment.price) && segment.price > 0 && segment.price_period === 'hour') {
        totals[segment.currency] = (totals[segment.currency] || 0) + segment.price * seconds / 3600;
      } else unknownSeconds += seconds;
    }
    return {
      estimated: true,
      totals,
      amount: Object.keys(totals).length === 1 ? totals[Object.keys(totals)[0]] : null,
      currency: Object.keys(totals).length === 1 ? Object.keys(totals)[0] : null,
      unknownSeconds,
      runningSince: segments.findLast(segment => !segment.ended_at)?.started_at || null,
      hasRunBefore: Boolean(record.ever_running),
      segmentCount: segments.length,
      hourlyPrice: Number.isFinite(record.price) ? record.price : null,
      priceUnit: record.currency && record.price_period ? `${record.currency}/${record.price_period}` : null,
      priceSource: record.price_source,
      updatedAt: new Date(at).toISOString(),
    };
  }

  return {
    defaults: { userId: DEFAULT_USER_ID, workspaceId: DEFAULT_WORKSPACE_ID },
    providerAccount,
    bindProviderCredential(provider, credentialKeyId, workspaceId = DEFAULT_WORKSPACE_ID) {
      const accountId = providerAccount(String(provider), workspaceId);
      db.prepare(`INSERT INTO provider_account_credentials
        (provider_account_id, provider, credential_key_id, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(provider_account_id) DO UPDATE SET credential_key_id = excluded.credential_key_id,
          updated_at = excluded.updated_at`)
        .run(accountId, String(provider), String(credentialKeyId), new Date().toISOString());
      return accountId;
    },
    observe,
    markMissing,
    estimate,
    getInstance(provider, id) {
      return getInstance.get(String(provider), String(id)) || null;
    },
    renameInstance(provider, id, displayName) {
      const name = String(displayName || '').trim();
      if (!name || name.length > 80 || /[\0\r\n]/.test(name)) {
        throw Object.assign(new Error('实例昵称长度必须为 1–80 个字符，且不能包含换行'), { status: 400 });
      }
      const result = db.prepare(`UPDATE managed_instances SET display_name = ?, last_observed_at = ?
        WHERE provider = ? AND provider_instance_id = ?`)
        .run(name, new Date().toISOString(), String(provider), String(id));
      return result.changes ? getInstance.get(String(provider), String(id)) : null;
    },
    recordRequestedAction(provider, id, operation, at = new Date().toISOString()) {
      const record = getInstance.get(String(provider), String(id));
      if (!record) return null;
      if (operation === 'start' && !openSegment.get(String(provider), String(id))) {
        insertSegment.run(randomUUID(), String(provider), String(id), at, record.price, record.currency,
          record.price_period || 'hour', record.price_source, 'start_requested');
      }
      if (operation === 'stop' || operation === 'delete') {
        closeSegment.run(at, `${operation}_requested`, String(provider), String(id));
      }
      db.prepare(`UPDATE managed_instances SET status = ?, last_observed_at = ?
        WHERE provider = ? AND provider_instance_id = ?`)
        .run(operation === 'delete' ? 'terminating' : operation === 'stop' ? 'stopping' : 'starting',
          at, String(provider), String(id));
      return getInstance.get(String(provider), String(id));
    },
    listAccounts(workspaceId = DEFAULT_WORKSPACE_ID) {
      return db.prepare(`SELECT a.*, c.credential_key_id FROM provider_accounts a
        LEFT JOIN provider_account_credentials c ON c.provider_account_id = a.id
        WHERE a.workspace_id = ? ORDER BY a.provider, a.name`).all(workspaceId);
    },
    listInstances(workspaceId = DEFAULT_WORKSPACE_ID) {
      return db.prepare('SELECT * FROM managed_instances WHERE workspace_id = ? ORDER BY last_observed_at DESC').all(workspaceId);
    },
    importReconciliation(input) {
      const amount = Number(input.amount);
      if (!input.provider || !Number.isFinite(amount) || amount < 0 || !input.currency || !input.periodStart || !input.periodEnd) {
        throw Object.assign(new Error('provider、非负 amount、currency、periodStart 和 periodEnd 必填'), { status: 400 });
      }
      const accountId = input.providerAccountId || providerAccount(String(input.provider));
      const id = randomUUID(), importedAt = new Date().toISOString();
      db.prepare(`INSERT INTO cost_reconciliations
        (id, provider, provider_account_id, provider_instance_id, period_start, period_end, amount,
         currency, source, provider_record_id, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, String(input.provider), accountId, input.providerInstanceId ? String(input.providerInstanceId) : null,
          String(input.periodStart), String(input.periodEnd), amount, String(input.currency),
          String(input.source || 'provider-history'), input.providerRecordId ? String(input.providerRecordId) : null, importedAt);
      return { id, provider: String(input.provider), providerAccountId: accountId, amount, currency: String(input.currency), importedAt };
    },
    listReconciliations(workspaceId = DEFAULT_WORKSPACE_ID) {
      return db.prepare(`SELECT r.* FROM cost_reconciliations r
        JOIN provider_accounts a ON a.id = r.provider_account_id
        WHERE a.workspace_id = ? ORDER BY r.imported_at DESC`).all(workspaceId);
    },
    close() { db.close(); },
  };
}

module.exports = { createBillingStore, DEFAULT_USER_ID, DEFAULT_WORKSPACE_ID };
