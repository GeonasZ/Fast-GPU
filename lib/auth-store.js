const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } = require('node:crypto');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function passwordHash(password, salt = randomBytes(16)) {
  return `${salt.toString('base64')}:${scryptSync(password, salt, 32).toString('base64')}`;
}

function verifyPassword(password, encoded) {
  const [saltText, hashText] = String(encoded || '').split(':');
  if (!saltText || !hashText) return false;
  const expected = Buffer.from(hashText, 'base64');
  const actual = scryptSync(password, Buffer.from(saltText, 'base64'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function tokenHash(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function createAuthStore(env = process.env) {
  const filename = path.resolve(env.FLEET_DATABASE_PATH || path.join(__dirname, '..', '.data', 'fleet.sqlite'));
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS app_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS user_sessions_user_id ON user_sessions(user_id);
  `);
  const findUser = db.prepare('SELECT id, email, display_name AS displayName, created_at AS createdAt FROM app_users WHERE email = ?');
  const findPassword = db.prepare('SELECT password_hash AS passwordHash FROM app_users WHERE email = ?');
  const insertUser = db.prepare('INSERT INTO app_users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)');
  const insertSession = db.prepare('INSERT INTO user_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)');
  const findSession = db.prepare(`SELECT u.id, u.email, u.display_name AS displayName, u.created_at AS createdAt
    FROM user_sessions s JOIN app_users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`);
  const deleteSession = db.prepare('DELETE FROM user_sessions WHERE token_hash = ?');
  const deleteExpired = db.prepare('DELETE FROM user_sessions WHERE expires_at <= ?');

  function validate(email, password, displayName) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error('请输入有效的邮箱地址'), { status: 400 });
    if (String(password).length < 10) throw Object.assign(new Error('密码至少需要 10 个字符'), { status: 400 });
    if (String(password).length > 256) throw Object.assign(new Error('密码不能超过 256 个字符'), { status: 400 });
    if (displayName != null && (String(displayName).trim().length < 2 || String(displayName).trim().length > 60)) {
      throw Object.assign(new Error('名称需要 2–60 个字符'), { status: 400 });
    }
  }

  function issueSession(userId) {
    deleteExpired.run(new Date().toISOString());
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    insertSession.run(tokenHash(token), userId, expiresAt.toISOString(), now.toISOString());
    return { token, expiresAt };
  }

  return {
    register({ email, password, displayName }) {
      email = normalizeEmail(email);
      displayName = String(displayName || '').trim();
      validate(email, password, displayName);
      if (findUser.get(email)) throw Object.assign(new Error('该邮箱已注册'), { status: 409, code: 'email_exists' });
      const id = randomUUID(), now = new Date().toISOString();
      insertUser.run(id, email, displayName, passwordHash(String(password)), now);
      return { user: findUser.get(email), session: issueSession(id) };
    },
    login({ email, password }) {
      email = normalizeEmail(email);
      if (String(password || '').length > 256) throw Object.assign(new Error('邮箱或密码错误'), { status: 401, code: 'invalid_credentials' });
      const credential = findPassword.get(email);
      if (!credential || !verifyPassword(String(password || ''), credential.passwordHash)) {
        throw Object.assign(new Error('邮箱或密码错误'), { status: 401, code: 'invalid_credentials' });
      }
      const user = findUser.get(email);
      return { user, session: issueSession(user.id) };
    },
    authenticate(token) {
      if (!token) return null;
      return findSession.get(tokenHash(token), new Date().toISOString()) || null;
    },
    logout(token) {
      if (token) deleteSession.run(tokenHash(token));
    },
    close() {
      db.close();
    },
  };
}

module.exports = { createAuthStore };
