const fs = require('node:fs');
const path = require('node:path');
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ALGORITHM = 'aes-256-gcm';

function masterKey(env) {
  const value = String(env.FLEET_CREDENTIAL_ENCRYPTION_KEY || '').trim();
  const key = /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('FLEET_CREDENTIAL_ENCRYPTION_KEY 必须是 32-byte base64 或 64 位十六进制密钥');
  return key;
}

function createProviderKeyStore(env = process.env) {
  const filename = path.resolve(env.FLEET_DATABASE_PATH || path.join(__dirname, '..', '.data', 'fleet.sqlite'));
  const key = masterKey(env);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS provider_api_keys (
      provider TEXT PRIMARY KEY,
      encrypted_key BLOB NOT NULL,
      encryption_iv BLOB NOT NULL,
      encryption_tag BLOB NOT NULL,
      encryption_algorithm TEXT NOT NULL,
      key_suffix TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS provider_api_key_entries (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      encrypted_key BLOB NOT NULL,
      encryption_iv BLOB NOT NULL,
      encryption_tag BLOB NOT NULL,
      encryption_algorithm TEXT NOT NULL,
      key_suffix TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS provider_api_key_entries_provider_created
      ON provider_api_key_entries(provider, created_at DESC);
    CREATE TABLE IF NOT EXISTS provider_api_key_active (
      provider TEXT PRIMARY KEY,
      key_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  // Allow users to name each provider key so they can tell keys apart at a glance.
  // Added after launch, so existing SQLite files are migrated in place.
  if (!db.prepare("SELECT 1 FROM pragma_table_info('provider_api_key_entries') WHERE name = 'label'").get()) {
    db.exec("ALTER TABLE provider_api_key_entries ADD COLUMN label TEXT NOT NULL DEFAULT ''");
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('provider_api_keys') WHERE name = 'label'").get()) {
    db.exec("ALTER TABLE provider_api_keys ADD COLUMN label TEXT NOT NULL DEFAULT ''");
  }
  const getRecord = db.prepare('SELECT * FROM provider_api_keys WHERE provider = ?');
  const listRecords = db.prepare('SELECT provider, key_suffix AS keySuffix, created_at AS createdAt, updated_at AS updatedAt FROM provider_api_keys');
  const upsert = db.prepare(`
    INSERT INTO provider_api_keys (provider, encrypted_key, encryption_iv, encryption_tag, encryption_algorithm, key_suffix, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET encrypted_key=excluded.encrypted_key, encryption_iv=excluded.encryption_iv,
      encryption_tag=excluded.encryption_tag, encryption_algorithm=excluded.encryption_algorithm,
      key_suffix=excluded.key_suffix, updated_at=excluded.updated_at
  `);
  const remove = db.prepare('DELETE FROM provider_api_keys WHERE provider = ?');
  const getEntry = db.prepare('SELECT * FROM provider_api_key_entries WHERE id = ? AND provider = ?');
  const latestEntry = db.prepare('SELECT * FROM provider_api_key_entries WHERE provider = ? ORDER BY rowid DESC LIMIT 1');
  const listEntries = db.prepare('SELECT id, provider, key_suffix AS keySuffix, label, created_at AS createdAt FROM provider_api_key_entries WHERE provider = ? ORDER BY rowid DESC');
  const insertEntry = db.prepare('INSERT INTO provider_api_key_entries (id, provider, encrypted_key, encryption_iv, encryption_tag, encryption_algorithm, key_suffix, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const removeEntry = db.prepare('DELETE FROM provider_api_key_entries WHERE id = ? AND provider = ?');
  const updateEntryLabel = db.prepare('UPDATE provider_api_key_entries SET label = ? WHERE id = ? AND provider = ?');
  const updateLegacyLabel = db.prepare('UPDATE provider_api_keys SET label = ?, updated_at = ? WHERE provider = ?');
  const getActive = db.prepare('SELECT key_id AS keyId FROM provider_api_key_active WHERE provider = ?');
  const setActive = db.prepare('INSERT INTO provider_api_key_active (provider, key_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET key_id=excluded.key_id, updated_at=excluded.updated_at');
  const removeActive = db.prepare('DELETE FROM provider_api_key_active WHERE provider = ?');

  function aad(provider) { return Buffer.from(`fast-gpu:provider-api-key:${provider}`); }
  function entryAad(provider, id) { return Buffer.from(`fast-gpu:provider-api-key:${provider}:${id}`); }
  function normalizeLabel(label) { return String(label || '').trim().slice(0, 120); }
  function decrypt(record) {
    if (record.encryption_algorithm !== ALGORITHM) throw new Error('不支持的厂商 Key 加密算法');
    const decipher = createDecipheriv(ALGORITHM, key, record.encryption_iv);
    decipher.setAAD(aad(record.provider));
    decipher.setAuthTag(record.encryption_tag);
    return Buffer.concat([decipher.update(record.encrypted_key), decipher.final()]).toString('utf8');
  }
  function decryptEntry(record) {
    if (record.encryption_algorithm !== ALGORITHM) throw new Error('不支持的厂商 Key 加密算法');
    const decipher = createDecipheriv(ALGORITHM, key, record.encryption_iv);
    decipher.setAAD(entryAad(record.provider, record.id));
    decipher.setAuthTag(record.encryption_tag);
    return Buffer.concat([decipher.update(record.encrypted_key), decipher.final()]).toString('utf8');
  }
  function availableKeys(provider) {
    const entries = listEntries.all(provider);
    const legacy = getRecord.get(provider);
    if (legacy) entries.push({ id: `legacy:${provider}`, provider, keySuffix: legacy.key_suffix, label: legacy.label || '', createdAt: legacy.created_at });
    return entries;
  }
  function activeKeyId(provider) {
    const keys = availableKeys(provider), selected = getActive.get(provider)?.keyId;
    if (selected && keys.some(item => item.id === selected)) return selected;
    const fallback = keys[0]?.id;
    if (fallback) setActive.run(provider, fallback, new Date().toISOString());
    else removeActive.run(provider);
    return fallback || null;
  }

  return {
    set(provider, value) {
      const apiKey = String(value || '').trim();
      const maxLength = String(provider).startsWith('__') ? 1024 * 1024 : 8192;
      if (!apiKey || apiKey.length > maxLength) throw Object.assign(new Error('保存内容为空或超过存储限制'), { status: 400 });
      const iv = randomBytes(12), cipher = createCipheriv(ALGORITHM, key, iv);
      cipher.setAAD(aad(provider));
      const encrypted = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
      const now = new Date().toISOString(), existing = getRecord.get(provider);
      upsert.run(provider, encrypted, iv, cipher.getAuthTag(), ALGORITHM, apiKey.slice(-4), existing?.created_at || now, now);
      return this.status(provider);
    },
    add(provider, value, label) {
      const apiKey = String(value || '').trim();
      if (!apiKey || apiKey.length > 8192) throw Object.assign(new Error('API Key 不能为空且不能超过 8192 个字符'), { status: 400 });
      if (!/^[\x21-\x7e]+$/.test(apiKey)) throw Object.assign(new Error('API Key 只能包含 ASCII 字母、数字和符号，不能包含空格或中文'), { status: 400, code: 'provider_api_key_invalid_format' });
      const id = randomBytes(12).toString('hex'), iv = randomBytes(12), cipher = createCipheriv(ALGORITHM, key, iv);
      cipher.setAAD(entryAad(provider, id));
      const encrypted = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
      const keyLabel = normalizeLabel(label);
      insertEntry.run(id, provider, encrypted, iv, cipher.getAuthTag(), ALGORITHM, apiKey.slice(-4), keyLabel, new Date().toISOString());
      setActive.run(provider, id, new Date().toISOString());
      return { id, provider, keySuffix: apiKey.slice(-4), label: keyLabel, createdAt: new Date().toISOString() };
    },
    renameKey(provider, id, label) {
      const keyId = String(id), keyLabel = normalizeLabel(label);
      if (keyId === `legacy:${provider}`) {
        return Boolean(updateLegacyLabel.run(keyLabel, new Date().toISOString(), provider).changes);
      }
      const result = updateEntryLabel.run(keyLabel, keyId, provider);
      return Boolean(result.changes);
    },
    get(provider) {
      const selected = activeKeyId(provider);
      if (selected && !selected.startsWith('legacy:')) {
        const entry = getEntry.get(selected, provider);
        if (entry) return decryptEntry(entry);
      }
      const record = getRecord.get(provider);
      return record ? decrypt(record) : null;
    },
    getKey(provider, id) {
      const keyId = String(id);
      if (keyId === `legacy:${provider}`) {
        const record = getRecord.get(provider);
        return record ? decrypt(record) : null;
      }
      const entry = getEntry.get(keyId, provider);
      return entry ? decryptEntry(entry) : null;
    },
    listKeys(provider) {
      const selected = activeKeyId(provider);
      return availableKeys(provider).map(item => ({ ...item, active: item.id === selected }));
    },
    activateKey(provider, id) {
      const keyId = String(id);
      if (!availableKeys(provider).some(item => item.id === keyId)) return false;
      setActive.run(provider, keyId, new Date().toISOString());
      return true;
    },
    removeKey(provider, id) {
      const keyId = String(id), wasActive = activeKeyId(provider) === keyId;
      const removed = keyId === `legacy:${provider}` ? Boolean(remove.run(provider).changes) : Boolean(removeEntry.run(keyId, provider).changes);
      if (removed && wasActive) {
        removeActive.run(provider);
        activeKeyId(provider);
      }
      return removed;
    },
    status(provider) {
      const keys = this.listKeys(provider);
      const active = keys.find(item => item.active);
      return keys.length ? { provider, configured: true, keyCount: keys.length, activeKeyId: active?.id, keySuffix: active?.keySuffix, keys } : { provider, configured: false, keyCount: 0, keys: [] };
    },
    list() { return listRecords.all().map(record => ({ ...record, configured: true })); },
    remove(provider) { return Boolean(remove.run(provider).changes); },
    close() { db.close(); },
  };
}

module.exports = { createProviderKeyStore };
