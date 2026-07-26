const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('runtime image leaves fast-moving developer CLIs to instance bootstrap', () => {
  const dockerfile = read('Dockerfile.runtime');
  assert.match(dockerfile, /FLEET_PREBUILT_IMAGE=1/);
  assert.doesNotMatch(dockerfile, /@openai\/codex/);
  assert.doesNotMatch(dockerfile, /@anthropic-ai\/claude-code/);
  const bootstrap = read('agent/bootstrap.sh');
  assert.match(bootstrap, /@openai\/codex@latest/);
  assert.match(bootstrap, /@anthropic-ai\/claude-code@latest/);
});

test('scheduled workflow only publishes and promotes the default runtime version', () => {
  const workflow = read('.github/workflows/update-codex-runtime.yml');
  const testAt = workflow.indexOf('Test candidate image');
  const promoteAt = workflow.indexOf('Promote tested digest');
  assert.ok(testAt > 0 && promoteAt > testAt);
  assert.match(workflow, /RUNTIME_VERSION: "26\.03"/);
  assert.doesNotMatch(workflow, /RUNTIME_VERSION: "26\.01"/);
  assert.doesNotMatch(workflow, /RUNTIME_VERSION: "25\.12"/);
  assert.match(workflow, /steps\.build\.outputs\.digest/);
  assert.match(workflow, /--tag "\$\{image\}:stable-cuda13"/);
});

test('bootstrap installs dependencies for an on-demand image and checks the cloud GPU', () => {
  const bootstrap = read('agent/bootstrap.sh');
  assert.match(bootstrap, /FLEET_PREBUILT_IMAGE:-0/);
  assert.match(bootstrap, /install_runtime_dependencies/);
  assert.match(bootstrap, /profile failed failed/);
  assert.match(bootstrap, /installing_runtime_dependencies/);
  assert.match(bootstrap, /rclone rsync/);
  assert.match(bootstrap, /npm install -g/);
  assert.doesNotMatch(bootstrap, /FLEET_VERIFY_GPU=1 \/opt\/gpu-fleet\/verify-image\.sh/);
  assert.match(bootstrap, /command -v nvidia-smi/);
  assert.match(bootstrap, /nvidia-smi >\/dev\/null/);
  assert.match(bootstrap, /torch\.cuda\.is_available/);
});

test('rsync is available on new runtimes and repaired on existing instances', () => {
  const dockerfile = read('Dockerfile.runtime');
  const server = read('server.js');
  assert.match(dockerfile, /rclone rsync/);
  assert.match(server, /command -v rsync/);
  assert.match(server, /remote_rsync_unavailable/);
  assert.match(server, /apt-get install -y --no-install-recommends rsync/);
});

test('runtime repository derives all supported prebuilt image tags', () => {
  const {runtimeImages} = require('../lib/runtime-images');
  const images = runtimeImages({FLEET_RUNTIME_IMAGE_REPOSITORY: 'ghcr.io/example/runtime'});
  assert.equal(images[0].image, 'ghcr.io/example/runtime:pytorch-2.11-cuda13.2-ngc26.03');
  assert.equal(images[0].buildMode, 'prebuilt');
  assert.equal(images[1].image, 'ghcr.io/example/runtime:pytorch-2.10-cuda13.1-ngc26.01');
  assert.equal(images[1].buildMode, 'prebuilt');
  assert.equal(images[2].image, 'ghcr.io/example/runtime:pytorch-2.7-cuda12.8-ngc25.03');
  assert.equal(images[2].buildMode, 'prebuilt');
});

test('default catalog distinguishes published platform images from startup-configured NGC images', () => {
  const {runtimeImages, resolveRuntimeImage} = require('../lib/runtime-images');
  const images = runtimeImages({});
  assert.deepEqual(
    images.slice(0, 3).map(({image, buildMode}) => ({image, buildMode})),
    [
      {image: 'ghcr.io/geonasz/gpu-scheduling-platform-runtime:pytorch-2.11-cuda13.2-ngc26.03', buildMode: 'prebuilt'},
      {image: 'ghcr.io/geonasz/gpu-scheduling-platform-runtime:pytorch-2.10-cuda13.1-ngc26.01', buildMode: 'prebuilt'},
      {image: 'ghcr.io/geonasz/gpu-scheduling-platform-runtime:pytorch-2.7-cuda12.8-ngc25.03', buildMode: 'prebuilt'},
    ],
  );
  assert.deepEqual(images.slice(3).map(item => item.buildMode), ['on-demand', 'on-demand']);
  assert.ok(images.slice(3).every(item => item.buildModeLabel.includes('开机安装')));
  assert.ok(images.every(item => !item.buildModeLabel.includes('临时')));
  assert.deepEqual(images[0].availableBuildModes, ['prebuilt', 'on-demand']);
  assert.equal(
    resolveRuntimeImage(images[0].id, {}, 'on-demand').image,
    'nvcr.io/nvidia/pytorch:26.03-py3',
  );
  assert.throws(
    () => resolveRuntimeImage(images[3].id, {}, 'prebuilt'),
    error => error.code === 'invalid_image_build_mode',
  );
});

test('launch UI submits a separately selected image acquisition mode', () => {
  const app = read('public/app.js');
  const html = read('public/index.html');
  const server = read('server.js');
  assert.match(html, /id="imageBuildMode"/);
  assert.match(app, /image\.availableBuildModes/);
  assert.match(app, /imageBuildMode:\s*selected\.provider/);
  assert.match(server, /resolveRuntimeImage\(\s*d\.imageVersion,\s*process\.env,\s*d\.imageBuildMode/);
});

test('candidate image verification checks npm but not fast-moving CLIs', () => {
  const verification = read('agent/verify-image.sh');
  assert.match(verification, /required=\([^\n]*npm/);
  assert.doesNotMatch(verification, /claude --version/);
  assert.doesNotMatch(verification, /CODEX_VERSION/);
});

test('runtime installs SSH and verifies startup with init-system fallbacks', () => {
  const dockerfile = read('Dockerfile.runtime');
  const bootstrap = read('agent/bootstrap.sh');
  const ssh = read('agent/ensure-ssh.sh');
  const hyperstack = read('agent/hyperstack.sh');
  assert.match(dockerfile, /openssh-server/);
  assert.match(dockerfile, /EXPOSE 22 3000/);
  assert.match(bootstrap, /ensure-ssh\.sh/);
  assert.match(ssh, /systemctl enable --now/);
  assert.match(ssh, /update-rc\.d ssh defaults/);
  assert.match(ssh, /\/usr\/sbin\/sshd/);
  assert.match(ssh, /pgrep -x sshd/);
  assert.match(ssh, /ssh-keyscan/);
  assert.match(ssh, /ssh-autostart-mode/);
  for (const config of [bootstrap, ssh, hyperstack]) {
    assert.match(config, /PasswordAuthentication no/);
    assert.match(config, /KbdInteractiveAuthentication no/);
    assert.match(config, /PubkeyAuthentication yes/);
    assert.match(config, /PermitEmptyPasswords no/);
  }
  assert.match(bootstrap, /PermitRootLogin prohibit-password/);
  assert.match(ssh, /PermitRootLogin prohibit-password/);
  assert.match(hyperstack, /PermitRootLogin no/);
  assert.match(hyperstack, /tailscale up --auth-key="file:/);
  assert.doesNotMatch(hyperstack, /set -x/);
});

test('runtime uses a lightweight init to forward signals and reap child processes', () => {
  const dockerfile = read('Dockerfile.runtime');
  const bootstrap = read('agent/bootstrap.sh');
  const provisioning = read('lib/provisioning.js');
  const providers = read('lib/providers.js');
  const minimalSsh = read('lib/provider-startup/minimal-ssh.js');
  const hyperstack = read('agent/hyperstack.sh');
  assert.match(dockerfile, /\btini\b/);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/bin\/tini", "-g", "--"\]/);
  assert.match(bootstrap, /\btini\b/);
  for (const generator of ['ppioStartupCommand','autodlStartupCommand','runpodStartupCommand','hyperstackStartup']) {
    assert.match(providers, new RegExp(generator));
  }
  for (const startup of [provisioning, hyperstack]) {
    assert.match(startup, /ps -p 1 -o comm=/);
    assert.match(startup, /exec tini -g -- sleep infinity/);
    assert.match(startup, /else exec sleep infinity/);
  }
  assert.match(minimalSsh, /exec sleep infinity/);
});

test('bootstrap starts SSH before validating the provider image', () => {
  const bootstrap = read('agent/bootstrap.sh');
  const start = bootstrap.lastIndexOf('\nstart_ssh_early\n');
  assert.ok(start > 0);
  assert.ok(start < bootstrap.indexOf('\nsource /etc/os-release\n'));
  assert.ok(start < bootstrap.indexOf('expected_cuda_major='));
  assert.match(bootstrap, /command -v python3[^]*?\|\| return 0/);
});

test('platform restart recovery does not rerun CUDA provisioning and failed runtimes keep SSH probing', () => {
  const bootstrap = read('agent/bootstrap.sh');
  const server = read('server.js');
  const recovery = bootstrap.indexOf('FLEET_RECOVERY_ONLY');
  assert.ok(recovery > bootstrap.lastIndexOf('\nstart_ssh_early\n'));
  assert.ok(recovery < bootstrap.indexOf('expected_cuda_major='));
  assert.match(server, /reinjectTelemetryAgent\(providerId, id, \{ recoveryOnly: true \}\)/);
  assert.match(bootstrap, /远端 SSH 与遥测连接已恢复/);
  assert.match(server, /telemetryHistory\.get\(instance\.provider, instance\.id\)/);
  assert.match(server, /FLEET_TELEMETRY_RECOVERY_STARTUP_GRACE_MS/);
  assert.match(server, /!startupGraceActive/);
  assert.match(server, /\["running", "provisioning", "failed"\]\.includes\(status\)/);
});

test('telemetry uses persistent per-instance credentials instead of a global token', () => {
  const server = read('server.js');
  const agent = read('agent/agent.js');
  const bootstrap = read('agent/bootstrap.sh');
  const provisioning = read('lib/provisioning.js');
  assert.match(server, /createCredentialStore/);
  assert.match(server, /revokeInstance/);
  assert.match(agent, /FLEET_AGENT_ID/);
  assert.match(agent, /FLEET_AGENT_SECRET/);
  assert.doesNotMatch(provisioning, /FLEET_AGENT_TOKEN/);
  assert.match(agent, /if\(!response\.ok\)throw Error/);
  assert.match(server, /findByInstance\(x\.provider,\s*id\)/);
  assert.match(bootstrap, /start_existing_agent/);
});

test('managed SSH remains available when agent telemetry is unavailable', () => {
  const server = read('server.js');
  const app = read('public/app.js');
  assert.doesNotMatch(server, /requireDeveloperTools/);
  assert.match(app, /SSH \/ 文件/);
  assert.match(app, /accessible\s*=\s*Boolean\(instance\.sshReady\)/);
  assert.match(app, /button\.disabled\s*=\s*!accessible/);
  assert.match(server, /scheduleSshReadinessProbe/);
  assert.match(server, /x\.status\s*===\s*["']running["']/);
  assert.match(server, /\.\.\.current[\s\S]*probing:\s*true/);
  assert.match(server, /verifyManagedSsh\(\{\s*\.\.\.managed,\s*keyFile\s*\}/);
  assert.doesNotMatch(app, /ssh\/check/);
  assert.match(app, /\/files\?provider=/);
  assert.doesNotMatch(app, /SSH 尚未就绪：["']?\s*\+\s*instance\.sshDiagnostic\.message/);
  assert.doesNotMatch(server, /SSH 无法连接，文件上传已取消/);
  assert.match(app, /scpUploadInProgress/);
  assert.match(app, /uploadScpItem\([\s\S]*uploadController\.signal/);
  assert.doesNotMatch(app, /uploadScpFile'\)\.onclick/);
  assert.match(server, /runCommand\(["']ssh["'],\s*args/);
  assert.match(server, /pty\.spawn\(\s*sshExecutable/);
  assert.match(server, /client\/ssh\/install/);
  assert.match(app, /SSH 长连接（默认）/);
  assert.match(app, /Cloudflare Named Tunnel/);
  assert.doesNotMatch(app, /trycloudflare|cloudflareTunnelEnabled/);
  assert.doesNotMatch(server, /cloudflareTunnel|trycloudflare/);
  assert.match(server, /sshTelemetrySessions/);
  assert.match(server, /ServerAliveInterval/);
  assert.match(server, /cloudflareCertificatePath/);
  assert.match(server, /startCloudflareLogin/);
  assert.match(server, /configureNamedTunnel/);
  assert.match(server, /verifyNamedTunnel/);
  assert.match(app, /Cloudflare 尚未登录/);
  assert.match(app, /showNamedTunnelHelp/);
  assert.match(app, /保存并测试/);
  assert.match(server, /function removeTemporaryFile/);
  assert.match(server, /reinjectTelemetryAgent/);
  assert.match(server, /operation\s*===\s*["']start["']/);
  assert.match(server, /agent\.env/);
  assert.match(server, /permission denied/);
  assert.match(server, /authorized_keys/);
  assert.match(server, /function scheduleBaseUrlSynchronization/);
  assert.match(server, /includeUnregistered:\s*true/);
  assert.match(server, /synchronizingRunningInstances/);
  assert.match(app, /读取 BASE_URL 更新状态失败/);
  assert.match(server, /\/opt\/gpu-fleet\/bootstrap\.sh/);
  assert.match(server, /runCommand\(["']scp["']/);
  assert.match(server, /copyFileSync\(path\.join\(__dirname,\s*["']agent["'],\s*["']bootstrap\.sh["']/);
  const revokeIndex=server.search(/revokeAgent\(\s*previousCredential\.agent_id/);
  assert.ok(revokeIndex>=0&&server.indexOf('agentCredentials.bind(',revokeIndex)>revokeIndex);
  assert.match(server, /function canProbeSsh/);
  assert.match(server, /probeOutboundReachabilityViaSsh/);
  assert.match(server, /outbound-via-ssh/);
  assert.doesNotMatch(server, /实例尚无公网 SSH 地址/);
  assert.match(read('public/reachability.js'), /实例主动访问外部网站的真实情况/);
  assert.match(server, /PreferredAuthentications=password,keyboard-interactive/);
  assert.match(server, /provider-password-repair/);
  assert.match(app, /data-install-ssh="system"/);
  assert.match(app, /data-install-ssh="application"/);
});

test('running container instances receive bootstrap over SSH when telemetry is absent', () => {
  const server = read('server.js');
  const app = read('public/app.js');
  assert.doesNotMatch(server, /instance\.provider\s*===\s*["']autodl["']/);
  assert.match(server, /instance\.provider\s*!==\s*["']hyperstack["']/);
  assert.match(server, /ssh_bootstrap_injection_failed/);
  assert.match(server, /instance\.status\s*===\s*["']running["']/);
  assert.match(server, /completeBaseUrlUpdate\(providerId,\s*id\)/);
  assert.match(server, /phase:\s*["']awaiting_ssh["']/);
  assert.match(server, /sshReadiness\.set\(updateKey,[\s\S]*?ready:\s*true[\s\S]*?phase:\s*["']uploading_bootstrap["']/);
  assert.match(app, /\["awaiting_ssh",\s*"uploading_bootstrap"\]\.includes\(i\.runtime\?\.phase\)/);
});

test('provider running state stays green while platform initialization remains visible', () => {
  const server = read('server.js');
  const app = read('public/app.js');
  assert.match(server, /providerState:\s*x\.status/);
  assert.match(app, /i\.providerState\s*===\s*["']running["']/);
  assert.match(app, /供应商运行中/);
  assert.match(app, /data-initialization-started-at/);
  assert.match(app, /正在安装并配置 SSH/);
  assert.match(app, /正在等待 SSH 安装并就绪/);
  assert.match(app, /正在检测 SSH 是否就绪/);
  assert.match(app, /const sshMarkup = instance\.sshDiagnostic\?\.message/);
  assert.match(app, /i\.lifecycleAction\s*===\s*["']delete["'][\s\S]*["']terminating["']/);
  assert.match(app, /右上角状态必须一直使用红色 terminating/);
  assert.match(app, /canStart\s*=\s*\["stopped",\s*"stopping"\]\.includes\(visualStatus\)/);
  assert.match(app, /state\s*===\s*["']stopping["']\s*\?\s*["']启动["']/);
  assert.match(app, /生命周期按钮必须跟右上角的派生状态使用同一口径/);
  assert.match(app, /正在安装构建工具与运行依赖/);
  assert.match(app, /正在安装开发工具/);
});

test('provider-side deletion and startup reconciliation purge stale instance artifacts', () => {
  const server = read('server.js');
  assert.match(server, /function purgeRemovedInstanceArtifacts/);
  assert.match(server, /agentCredentials\.revokeInstance/);
  assert.match(server, /sshStore\.remove/);
  assert.match(server, /instanceAccessStore\.remove/);
  assert.match(server, /pushedTelemetry\.delete/);
  assert.match(server, /telemetryDiagnostics\.delete/);
  assert.match(server, /function reconcileProviderInventory/);
  assert.match(server, /failedProviders\.has/);
  assert.match(server, /启动后实例与凭据对账失败/);
});

test('existing instance adoption persists only after the generated key connects', () => {
  const server = read('server.js');
  const app = read('public/app.js');
  assert.match(server, /pendingInstanceAdoptions/);
  assert.ok(server.includes('\\/adoption\\/prepare'));
  assert.ok(server.includes('\\/adoption\\/verify'));
  const verifyIndex = server.indexOf('privateKey: pending.pair.privateKey');
  const saveIndex = server.indexOf('sshStore.save(id', verifyIndex);
  assert.ok(verifyIndex >= 0 && saveIndex > verifyIndex);
  assert.match(app, /校验失败，未保存平台密钥/);
  assert.match(app, /method === "privateKey"/);
  assert.match(app, /method === "password"/);
});

test('instance lifecycle decorator does not retrigger its MutationObserver forever', () => {
  const app = read('public/app.js');
  assert.match(app, /pill\.textContent\s*!==/);
  assert.match(app, /instance\.lifecycleAction\s*!==\s*["']start["']/);
  const server = read('server.js');
  assert.match(server, /recentlyCreated\s*=/);
  assert.match(server, /20\s*\*\s*60\s*\*\s*1000/);
  assert.match(server, /lifecycleAction:\s*action\?\.action/);
  assert.match(app, /初始化镜像中/);
  assert.match(app, /正在安装构建工具与运行依赖/);
  assert.match(app, /正在安装开发工具/);
});

test('Hyperstack SSH CIDR defaults to all IPv4 sources for portable direct access', () => {
  const app = read('public/app.js');
  assert.match(app, /input\.value\s*=\s*["']0\.0\.0\.0\/0["']/);
  assert.match(app, /SSH 来源 CIDR/);
});
