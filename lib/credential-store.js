const fs = require('node:fs');
const path = require('node:path');
const {
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const SSH_ENCRYPTION_ALGORITHM = 'aes-256-gcm';

function databaseFilename(env) {
  return path.resolve(env.FLEET_DATABASE_PATH || path.join(__dirname, '..', '.data', 'fleet.sqlite'));
}

function encryptionKey(env) {
  const configured = String(env.FLEET_CREDENTIAL_ENCRYPTION_KEY || '').trim();
  const key = /^[a-f0-9]{64}$/i.test(configured)
    ? Buffer.from(configured, 'hex')
    : Buffer.from(configured, 'base64');
  if (key.length !== 32) {
    throw new Error('FLEET_CREDENTIAL_ENCRYPTION_KEY 未配置或格式错误：必须提供原来的 32-byte key（base64 或 64 位十六进制），不能临时生成新值');
  }
  return key;
}

function hashSecret(secret, salt = randomBytes(16)) {
  return { salt: salt.toString('hex'), hash: scryptSync(secret, salt, 32).toString('hex') };
}

function sshEd25519PublicKey(publicKey) {
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const type = Buffer.from('ssh-ed25519');
  const wire = Buffer.alloc(4 + type.length + 4 + raw.length);
  wire.writeUInt32BE(type.length, 0);
  type.copy(wire, 4);
  wire.writeUInt32BE(raw.length, 4 + type.length);
  raw.copy(wire, 8 + type.length);
  return `ssh-ed25519 ${wire.toString('base64')} fast-gpu-managed`;
}

function createCredentialStore(env = process.env) {
  const filename = databaseFilename(env);
  const masterKey = encryptionKey(env);
  const sshPort = Number(env.FLEET_SSH_PORT || 22022);
  if (!Number.isInteger(sshPort) || sshPort < 1024 || sshPort > 65535 || sshPort === 22) {
    throw new Error('FLEET_SSH_PORT must be a non-default port between 1024 and 65535');
  }

  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS agent_credentials (
      agent_id TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      secret_salt TEXT NOT NULL,
      provider TEXT NOT NULL,
      instance_name TEXT NOT NULL,
      provider_instance_id TEXT,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
    DROP INDEX IF EXISTS agent_credentials_provider_instance;
    CREATE UNIQUE INDEX agent_credentials_provider_instance
      ON agent_credentials(provider, provider_instance_id)
      WHERE provider_instance_id IS NOT NULL AND revoked_at IS NULL;
    CREATE TABLE IF NOT EXISTS ssh_credentials (
      provider TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      username TEXT NOT NULL,
      public_key TEXT NOT NULL,
      encrypted_private_key BLOB NOT NULL,
      encryption_iv BLOB NOT NULL,
      encryption_tag BLOB NOT NULL,
      encryption_algorithm TEXT NOT NULL,
      internal_port INTEGER NOT NULL,
      host TEXT,
      external_port INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      PRIMARY KEY (provider, provider_instance_id)
    );
    CREATE TABLE IF NOT EXISTS instance_access_credentials (
      provider TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      credential_type TEXT NOT NULL,
      username TEXT NOT NULL,
      encrypted_secret BLOB NOT NULL,
      encryption_iv BLOB NOT NULL,
      encryption_tag BLOB NOT NULL,
      encryption_algorithm TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      PRIMARY KEY (provider, provider_instance_id)
    );
    CREATE TABLE IF NOT EXISTS instance_telemetry_history (
      provider TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (provider, provider_instance_id)
    );
  `);

  const insertAgent = db.prepare('INSERT INTO agent_credentials (agent_id, secret_hash, secret_salt, provider, instance_name, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const findActiveAgent = db.prepare('SELECT * FROM agent_credentials WHERE agent_id = ? AND revoked_at IS NULL');
  const findActiveAgentByInstance = db.prepare('SELECT * FROM agent_credentials WHERE provider = ? AND provider_instance_id = ? AND revoked_at IS NULL');
  const listActiveBoundAgents = db.prepare(`SELECT provider, provider_instance_id AS id, created_at AS createdAt
    FROM agent_credentials WHERE provider_instance_id IS NOT NULL AND revoked_at IS NULL`);
  const bindAgent = db.prepare('UPDATE agent_credentials SET provider_instance_id = ? WHERE agent_id = ? AND revoked_at IS NULL');
  const revokeAgent = db.prepare('UPDATE agent_credentials SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL');
  const revokeAgentsByInstance = db.prepare('UPDATE agent_credentials SET revoked_at = ? WHERE provider = ? AND provider_instance_id = ? AND revoked_at IS NULL');
  const insertSsh = db.prepare(`
    INSERT INTO ssh_credentials (
      provider, provider_instance_id, username, public_key, encrypted_private_key,
      encryption_iv, encryption_tag, encryption_algorithm, internal_port, host, external_port, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const findSsh = db.prepare('SELECT * FROM ssh_credentials WHERE provider = ? AND provider_instance_id = ?');
  const listSsh = db.prepare(`
    SELECT provider, provider_instance_id AS id, username, public_key AS publicKey,
      internal_port AS internalPort, host, external_port AS externalPort,
      created_at AS createdAt, updated_at AS updatedAt
    FROM ssh_credentials
  `);
  const updateSsh = db.prepare('UPDATE ssh_credentials SET host = ?, external_port = ?, updated_at = ? WHERE provider = ? AND provider_instance_id = ?');
  const deleteSsh = db.prepare('DELETE FROM ssh_credentials WHERE provider = ? AND provider_instance_id = ?');
  const upsertAccess = db.prepare(`
    INSERT INTO instance_access_credentials (
      provider, provider_instance_id, credential_type, username, encrypted_secret,
      encryption_iv, encryption_tag, encryption_algorithm, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, provider_instance_id) DO UPDATE SET
      credential_type=excluded.credential_type, username=excluded.username,
      encrypted_secret=excluded.encrypted_secret, encryption_iv=excluded.encryption_iv,
      encryption_tag=excluded.encryption_tag, encryption_algorithm=excluded.encryption_algorithm,
      updated_at=excluded.updated_at
  `);
  const findAccess = db.prepare('SELECT * FROM instance_access_credentials WHERE provider = ? AND provider_instance_id = ?');
  const listAccess = db.prepare(`SELECT provider, provider_instance_id AS id, created_at AS createdAt
    FROM instance_access_credentials`);
  const deleteAccess = db.prepare('DELETE FROM instance_access_credentials WHERE provider = ? AND provider_instance_id = ?');
  const upsertTelemetryHistory = db.prepare(`
    INSERT INTO instance_telemetry_history (provider, provider_instance_id, last_seen_at)
    VALUES (?, ?, ?)
    ON CONFLICT(provider, provider_instance_id) DO UPDATE SET
      last_seen_at=excluded.last_seen_at
  `);
  const findTelemetryHistory = db.prepare(
    'SELECT last_seen_at AS lastSeenAt FROM instance_telemetry_history WHERE provider = ? AND provider_instance_id = ?',
  );
  const deleteTelemetryHistory = db.prepare(
    'DELETE FROM instance_telemetry_history WHERE provider = ? AND provider_instance_id = ?',
  );

  function aad(provider, id) {
    return Buffer.from(`fast-gpu:ssh:${provider}:${id}`);
  }

  function encryptPrivateKey(provider, id, privateKey) {
    const iv = randomBytes(12);
    const cipher = createCipheriv(SSH_ENCRYPTION_ALGORITHM, masterKey, iv);
    cipher.setAAD(aad(provider, id));
    const encrypted = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
    return { encrypted, iv, tag: cipher.getAuthTag() };
  }

  function decryptPrivateKey(record) {
    if (record.encryption_algorithm !== SSH_ENCRYPTION_ALGORITHM) {
      throw new Error(`Unsupported SSH credential encryption algorithm: ${record.encryption_algorithm}`);
    }
    const decipher = createDecipheriv(SSH_ENCRYPTION_ALGORITHM, masterKey, record.encryption_iv);
    decipher.setAAD(aad(record.provider, record.provider_instance_id));
    decipher.setAuthTag(record.encryption_tag);
    return Buffer.concat([decipher.update(record.encrypted_private_key), decipher.final()]).toString('utf8');
  }

  function accessAad(provider, id, type) {
    return Buffer.from(`fast-gpu:instance-access:${provider}:${id}:${type}`);
  }

  function encryptAccessSecret(provider, id, type, secret) {
    const iv = randomBytes(12);
    const cipher = createCipheriv(SSH_ENCRYPTION_ALGORITHM, masterKey, iv);
    cipher.setAAD(accessAad(provider, id, type));
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return { encrypted, iv, tag: cipher.getAuthTag() };
  }

  function decryptAccessSecret(record) {
    const decipher = createDecipheriv(SSH_ENCRYPTION_ALGORITHM, masterKey, record.encryption_iv);
    decipher.setAAD(accessAad(record.provider, record.provider_instance_id, record.credential_type));
    decipher.setAuthTag(record.encryption_tag);
    return Buffer.concat([decipher.update(record.encrypted_secret), decipher.final()]).toString('utf8');
  }

  const encryptedCredential = db.prepare('SELECT * FROM ssh_credentials LIMIT 1').get();
  if (encryptedCredential) {
    try {
      decryptPrivateKey(encryptedCredential);
    } catch (cause) {
      db.close();
      const error = new Error('FLEET_CREDENTIAL_ENCRYPTION_KEY 与现有凭据数据库不匹配：无法解密已保存的 SSH 私钥。请恢复创建这些凭据时使用的原始主密钥');
      error.code = 'credential_encryption_key_mismatch';
      error.cause = cause;
      throw error;
    }
  }

  const agents = {
    create(provider, instanceName) {
      const agentId = randomBytes(16).toString('hex');
      const secret = randomBytes(32).toString('base64url');
      const digest = hashSecret(secret);
      insertAgent.run(agentId, digest.hash, digest.salt, provider, instanceName, new Date().toISOString());
      return { agentId, secret };
    },
    bind(agentId, providerInstanceId) {
      if (!bindAgent.run(String(providerInstanceId), agentId).changes) {
        throw new Error('agent credential not found while binding instance');
      }
    },
    authenticate(agentId, secret) {
      if (!agentId || !secret) return null;
      const record = findActiveAgent.get(String(agentId));
      if (!record) return null;
      const actual = scryptSync(String(secret), Buffer.from(record.secret_salt, 'hex'), 32);
      const expected = Buffer.from(record.secret_hash, 'hex');
      return actual.length === expected.length && timingSafeEqual(actual, expected) ? record : null;
    },
    findByInstance(provider, id) {
      return findActiveAgentByInstance.get(String(provider), String(id)) || null;
    },
    list() {
      return listActiveBoundAgents.all();
    },
    revokeAgent(agentId) {
      return Boolean(revokeAgent.run(new Date().toISOString(), String(agentId)).changes);
    },
    revokeInstance(provider, id) {
      return Boolean(revokeAgentsByInstance.run(new Date().toISOString(), provider, String(id)).changes);
    },
  };

  const ssh = {
    port: sshPort,
    createKey() {
      const pair = generateKeyPairSync('ed25519');
      return {
        privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        publicKey: sshEd25519PublicKey(pair.publicKey),
      };
    },
    save(id, record) {
      const provider = String(record.provider);
      const providerInstanceId = String(id);
      const sealed = encryptPrivateKey(provider, providerInstanceId, record.privateKey);
      insertSsh.run(
        provider, providerInstanceId, record.username, record.publicKey, sealed.encrypted,
        sealed.iv, sealed.tag, SSH_ENCRYPTION_ALGORITHM, record.internalPort,
        record.host || null, record.externalPort || null, new Date().toISOString(),
      );
      return this.get(provider, providerInstanceId);
    },
    get(provider, id) {
      const record = findSsh.get(String(provider), String(id));
      if (!record) return null;
      return {
        provider: record.provider,
        id: record.provider_instance_id,
        username: record.username,
        publicKey: record.public_key,
        privateKey: decryptPrivateKey(record),
        internalPort: record.internal_port,
        host: record.host,
        externalPort: record.external_port,
        createdAt: record.created_at,
        updatedAt: record.updated_at,
      };
    },
    list() {
      return listSsh.all();
    },
    update(provider, id, patch) {
      const current = findSsh.get(String(provider), String(id));
      if (!current) return null;
      updateSsh.run(
        patch.host === undefined ? current.host : patch.host,
        patch.externalPort === undefined ? current.external_port : patch.externalPort,
        new Date().toISOString(),
        String(provider),
        String(id),
      );
      return this.get(provider, id);
    },
    remove(provider, id) {
      return Boolean(deleteSsh.run(String(provider), String(id)).changes);
    },
  };

  const access = {
    save(provider, id, { type, username, secret }) {
      if (!['privateKey', 'password'].includes(type) || !secret)
        throw new Error('Unsupported or empty instance access credential');
      const now = new Date().toISOString(),
        sealed = encryptAccessSecret(String(provider), String(id), type, String(secret));
      upsertAccess.run(
        String(provider), String(id), type, String(username || 'root'),
        sealed.encrypted, sealed.iv, sealed.tag, SSH_ENCRYPTION_ALGORITHM,
        now, now,
      );
      return { provider: String(provider), id: String(id), type, username: String(username || 'root') };
    },
    get(provider, id) {
      const record = findAccess.get(String(provider), String(id));
      if (!record) return null;
      return {
        provider: record.provider,
        id: record.provider_instance_id,
        type: record.credential_type,
        username: record.username,
        secret: decryptAccessSecret(record),
      };
    },
    list() {
      return listAccess.all();
    },
    remove(provider, id) {
      return Boolean(deleteAccess.run(String(provider), String(id)).changes);
    },
  };

  const telemetryHistory = {
    markSeen(provider, id, at = new Date().toISOString()) {
      upsertTelemetryHistory.run(String(provider), String(id), String(at));
    },
    get(provider, id) {
      return findTelemetryHistory.get(String(provider), String(id)) || null;
    },
    remove(provider, id) {
      return Boolean(deleteTelemetryHistory.run(String(provider), String(id)).changes);
    },
  };

  return { agents, ssh, access, telemetryHistory, filename, close() { db.close(); } };
}

module.exports = { createCredentialStore, hashSecret };
