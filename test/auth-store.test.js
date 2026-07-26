const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAuthStore } = require('../lib/auth-store');

test('web users can register, authenticate, log out, and log in again', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-auth-test-'));
  const store = createAuthStore({ FLEET_DATABASE_PATH: path.join(directory, 'fleet.sqlite') });
  try {
    const created = store.register({ email: ' USER@example.com ', password: 'long-password', displayName: 'Test User' });
    assert.equal(created.user.email, 'user@example.com');
    assert.equal(store.authenticate(created.session.token).displayName, 'Test User');
    store.logout(created.session.token);
    assert.equal(store.authenticate(created.session.token), null);
    const loggedIn = store.login({ email: 'user@example.com', password: 'long-password' });
    assert.equal(loggedIn.user.id, created.user.id);
    assert.throws(() => store.register({ email: 'user@example.com', password: 'another-long-password', displayName: 'Other' }), /已注册/);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
