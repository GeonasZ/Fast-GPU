const test = require('node:test');
const assert = require('node:assert/strict');
const {parseWindowsListeningPids,waitForPortAvailable} = require('../lib/local-port');

test('finds only processes listening on the requested Windows TCP port', () => {
  const output = [
    '  TCP    127.0.0.1:4173       0.0.0.0:0       LISTENING       1200',
    '  TCP    127.0.0.1:41730      0.0.0.0:0       LISTENING       1300',
    '  TCP    127.0.0.1:4173       127.0.0.1:50000 ESTABLISHED     1400',
    '  TCP    [::]:4173            [::]:0          LISTENING       1200',
  ].join('\r\n');
  assert.deepEqual(parseWindowsListeningPids(output, 4173), [1200]);
});

test('waits until the local port can be bound', async () => {
  let attempts = 0;
  const available = await waitForPortAvailable(4173, {
    timeoutMs: 100,
    intervalMs: 1,
    canBind: async () => ++attempts === 3,
  });
  assert.equal(available, true);
  assert.equal(attempts, 3);
});
