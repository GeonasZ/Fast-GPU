const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('runtime image pins the detected CLI versions and marks itself prebuilt', () => {
  const dockerfile = read('Dockerfile.runtime');
  assert.match(dockerfile, /ARG CODEX_VERSION/);
  assert.match(dockerfile, /ARG CLAUDE_CODE_VERSION/);
  assert.match(dockerfile, /@openai\/codex@\$\{CODEX_VERSION\}/);
  assert.match(dockerfile, /@anthropic-ai\/claude-code@\$\{CLAUDE_CODE_VERSION\}/);
  assert.match(dockerfile, /FLEET_PREBUILT_IMAGE=1/);
  assert.doesNotMatch(dockerfile, /@openai\/codex@latest/);
  assert.doesNotMatch(dockerfile, /@anthropic-ai\/claude-code@latest/);
});

test('scheduled workflow tests a digest before promoting stable', () => {
  const workflow = read('.github/workflows/update-codex-runtime.yml');
  const testAt = workflow.indexOf('Test candidate image');
  const promoteAt = workflow.indexOf('Promote tested digest');
  assert.ok(testAt > 0 && promoteAt > testAt);
  assert.match(workflow, /npm view @openai\/codex@latest version/);
  assert.match(workflow, /npm view @anthropic-ai\/claude-code@latest version/);
  assert.match(workflow, /codex-\$\{codex_version\}-claude-\$\{claude_version\}/);
  assert.match(workflow, /steps\.build\.outputs\.digest/);
  assert.match(workflow, /--tag "\$\{image\}:stable"/);
});

test('bootstrap skips build-time verification for a prebuilt image but checks the cloud GPU', () => {
  const bootstrap = read('agent/bootstrap.sh');
  assert.match(bootstrap, /FLEET_PREBUILT_IMAGE:-0/);
  assert.doesNotMatch(bootstrap, /FLEET_VERIFY_GPU=1 \/opt\/gpu-fleet\/verify-image\.sh/);
  assert.match(bootstrap, /command -v nvidia-smi/);
  assert.match(bootstrap, /nvidia-smi >\/dev\/null/);
});

test('candidate image verification includes Claude Code', () => {
  const verification = read('agent/verify-image.sh');
  assert.match(verification, /required=\([^\n]*claude/);
  assert.match(verification, /claude --version/);
  assert.match(verification, /CLAUDE_CODE_VERSION/);
});

test('runtime installs SSH and verifies startup with init-system fallbacks', () => {
  const dockerfile = read('Dockerfile.runtime');
  const bootstrap = read('agent/bootstrap.sh');
  const ssh = read('agent/ensure-ssh.sh');
  assert.match(dockerfile, /openssh-server/);
  assert.match(dockerfile, /EXPOSE 22 3000/);
  assert.match(bootstrap, /ensure-ssh\.sh/);
  assert.match(ssh, /systemctl enable --now/);
  assert.match(ssh, /update-rc\.d ssh defaults/);
  assert.match(ssh, /\/usr\/sbin\/sshd/);
  assert.match(ssh, /pgrep -x sshd/);
  assert.match(ssh, /ssh-keyscan/);
  assert.match(ssh, /ssh-autostart-mode/);
});

test('telemetry uses persistent per-instance credentials instead of a global token', () => {
  const server = read('server.js');
  const agent = read('agent/agent.js');
  const provisioning = read('lib/provisioning.js');
  assert.match(server, /createCredentialStore/);
  assert.match(server, /revokeInstance/);
  assert.match(agent, /FLEET_AGENT_ID/);
  assert.match(agent, /FLEET_AGENT_SECRET/);
  assert.doesNotMatch(provisioning, /FLEET_AGENT_TOKEN/);
  assert.match(agent, /if\(!response\.ok\)throw Error/);
});
