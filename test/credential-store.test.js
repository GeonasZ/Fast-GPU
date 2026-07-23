const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCredentialStore } = require('../lib/credential-store');

function environment(filename, key = Buffer.alloc(32, 7).toString('base64')) {
  return {
    FLEET_DATABASE_PATH: filename,
    FLEET_CREDENTIAL_ENCRYPTION_KEY: key,
    FLEET_SSH_PORT: '22022',
  };
}

test('agent and SSH credentials share SQLite without storing plaintext secrets', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-credentials-'));
  const filename = path.join(directory, 'fleet.sqlite');
  try {
    const first = createCredentialStore(environment(filename));
    const agent = first.agents.create('runpod', 'gpu-a');
    first.agents.bind(agent.agentId, 'pod-1');
    const key = first.ssh.createKey();
    first.ssh.save('pod-1', {
      provider: 'runpod',
      username: 'root',
      publicKey: key.publicKey,
      privateKey: key.privateKey,
      internalPort: first.ssh.port,
    });
    first.close();

    const database = fs.readFileSync(filename);
    assert.equal(database.includes(Buffer.from(agent.secret)), false);
    assert.equal(database.includes(Buffer.from(key.privateKey)), false);

    const restarted = createCredentialStore(environment(filename));
    assert.equal(restarted.agents.authenticate(agent.agentId, agent.secret).provider_instance_id, 'pod-1');
    assert.equal(restarted.ssh.get('runpod', 'pod-1').privateKey, key.privateKey);
    restarted.ssh.update('runpod', 'pod-1', { host: '203.0.113.8', externalPort: 32123 });
    assert.equal(restarted.ssh.get('runpod', 'pod-1').externalPort, 32123);
    assert.equal(restarted.agents.revokeInstance('runpod', 'pod-1'), true);
    assert.equal(restarted.ssh.remove('runpod', 'pod-1'), true);
    assert.equal(restarted.agents.authenticate(agent.agentId, agent.secret), null);
    assert.equal(restarted.ssh.get('runpod', 'pod-1'), null);
    restarted.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('credential store rejects missing or incorrect encryption keys and port 22', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-credentials-config-'));
  const filename = path.join(directory, 'fleet.sqlite');
  try {
    assert.throws(() => createCredentialStore({ FLEET_DATABASE_PATH: filename }), /FLEET_CREDENTIAL_ENCRYPTION_KEY/);
    assert.throws(() => createCredentialStore(environment(filename, 'short')), /32-byte key/);
    assert.throws(() => createCredentialStore({ ...environment(filename), FLEET_SSH_PORT: '22' }), /non-default port/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SSH private keys cannot be decrypted with a different master key', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-credential-key-'));
  const filename = path.join(directory, 'fleet.sqlite');
  try {
    const first = createCredentialStore(environment(filename));
    const key = first.ssh.createKey();
    first.ssh.save('pod-1', {
      provider: 'runpod',
      username: 'root',
      publicKey: key.publicKey,
      privateKey: key.privateKey,
      internalPort: first.ssh.port,
    });
    first.close();
    const wrongKey = Buffer.alloc(32, 9).toString('base64');
    const reopened = createCredentialStore(environment(filename, wrongKey));
    assert.throws(() => reopened.ssh.get('runpod', 'pod-1'));
    reopened.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
