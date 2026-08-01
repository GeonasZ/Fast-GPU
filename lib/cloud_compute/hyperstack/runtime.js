const PROVIDER_ID = 'hyperstack';
const CONFIG_RECORD = '__hyperstack_config__';
const POLICY_RECORD = '__hyperstack_keypair_policies__';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const PROVISION_PHASES = {
  awaiting_ssh: '正在等待 Hyperstack SSH 可用',
  uploading_bootstrap: '正在通过 SSH 上传初始化文件',
  vm_startup: '正在执行 VM 开机配置',
  ensuring_vm_ssh: '正在确认 VM SSH 服务',
  checking_registry: '正在检查 NGC 镜像仓库',
  pulling_image: '正在下载容器镜像',
  image_pulled: '容器镜像下载完成',
  validating_cuda: '正在验证 CUDA 与 PyTorch',
  starting_runtime: '正在启动运行环境',
  installing_dependencies: '正在安装实例工具',
  ready: '运行环境已就绪',
};

function parseRecord(store, key, fallback = {}) {
  try { return JSON.parse(store.get(key) || JSON.stringify(fallback)); }
  catch { return fallback; }
}

function createRuntime({ env, adapter, providerKeyStore, sshStore }) {
  let metadataPromise;

  function restore() {
    const saved = parseRecord(providerKeyStore, CONFIG_RECORD);
    Object.assign(env, saved);
    Object.assign(adapter.env, saved);
    return saved;
  }

  function policies() { return parseRecord(providerKeyStore, POLICY_RECORD); }
  function savePolicies(value) {
    providerKeyStore.set(POLICY_RECORD, JSON.stringify(value));
  }

  function managedKeypair(id, name = '') {
    const direct = sshStore.get(PROVIDER_ID, `keypair:${id}`);
    if (direct || !name) return direct;
    const legacy = sshStore.get(PROVIDER_ID, `keypair:${name}`);
    if (!legacy) return null;
    if (String(id) !== String(name)) {
      sshStore.save(`keypair:${id}`, {
        provider: PROVIDER_ID,
        privateKey: legacy.privateKey,
        publicKey: legacy.publicKey,
        internalPort: legacy.internalPort || sshStore.port,
        username: legacy.username || 'ubuntu',
      });
    }
    return legacy;
  }

  async function resources() {
    const discovered = await adapter.configurationResources();
    const configuredPolicies = policies();
    return {
      ...discovered,
      keypairs: discovered.keypairs.map(keypair => ({
        ...keypair,
        platformManaged: Boolean(managedKeypair(keypair.id, keypair.name)),
        registrationPolicy: configuredPolicies[String(keypair.id)] || {
          mode: 'on-demand', environments: [],
        },
      })),
    };
  }

  async function registerKeypair(source, environmentName, discovered) {
    const credential = managedKeypair(source.id, source.name);
    if (!credential) {
      throw Object.assign(Error('SSH Keypair 不是平台管理的，无法复制'), {
        status: 409, code: 'hyperstack_keypair_not_managed',
      });
    }
    const existing = discovered.keypairs.find(item =>
      item.environmentName === environmentName && source.fingerprint &&
      item.fingerprint === source.fingerprint,
    );
    if (existing) return existing;
    if (discovered.keypairs.some(item =>
      item.environmentName === environmentName && item.name === source.name,
    )) {
      throw Object.assign(Error(`${environmentName} 中已有同名但不同的 Keypair`), {
        status: 409, code: 'hyperstack_keypair_name_conflict',
      });
    }
    const created = await adapter.importKeypair({
      name: source.name,
      environmentName,
      publicKey: credential.publicKey,
    });
    const replica = {
      id: created.id,
      name: created.name || source.name,
      environmentName: created.environment?.name || environmentName,
      region: created.environment?.region || discovered.environments
        .find(item => item.name === environmentName)?.region,
      fingerprint: created.fingerprint || source.fingerprint,
    };
    sshStore.save(`keypair:${replica.id}`, {
      provider: PROVIDER_ID,
      privateKey: credential.privateKey,
      publicKey: credential.publicKey,
      internalPort: sshStore.port,
      username: credential.username || 'ubuntu',
    });
    discovered.keypairs.push(replica);
    return replica;
  }

  async function ensureRegionMetadata(force = false) {
    const environmentName = env.HYPERSTACK_ENVIRONMENT;
    const keyName = env.HYPERSTACK_KEY_NAME;
    if (!adapter.token || !environmentName || !keyName) return null;
    if (!force && env.HYPERSTACK_REGION && env.HYPERSTACK_KEYPAIR_ID) {
      return { region: env.HYPERSTACK_REGION, environmentName, keyName };
    }
    if (metadataPromise) return metadataPromise;
    metadataPromise = (async () => {
      const discovered = await resources();
      const environment = discovered.environments.find(item => item.name === environmentName);
      const keypair = discovered.keypairs.find(item =>
        String(item.id) === String(env.HYPERSTACK_KEYPAIR_ID || '') ||
        (item.name === keyName && item.environmentName === environmentName),
      );
      if (!environment) throw Object.assign(Error(`Environment ${environmentName} 不存在`), { status: 409, code: 'hyperstack_environment_missing' });
      if (!keypair) throw Object.assign(Error(`Keypair ${keyName} 不存在`), { status: 409, code: 'hyperstack_keypair_missing' });
      if (keypair.environmentName !== environmentName) {
        throw Object.assign(Error(`Keypair ${keyName} 不属于 ${environmentName}`), {
          status: 409, code: 'hyperstack_keypair_environment_mismatch',
        });
      }
      const region = keypair.region || environment.region;
      if (!region) throw Object.assign(Error('无法确认 Keypair 所属区域'), { status: 409, code: 'hyperstack_keypair_region_unknown' });
      const metadata = {
        HYPERSTACK_REGION: region,
        HYPERSTACK_KEYPAIR_ENVIRONMENT: environmentName,
        HYPERSTACK_KEYPAIR_ID: String(keypair.id),
      };
      const saved = { ...parseRecord(providerKeyStore, CONFIG_RECORD), ...metadata };
      providerKeyStore.set(CONFIG_RECORD, JSON.stringify(saved));
      Object.assign(env, metadata);
      Object.assign(adapter.env, metadata);
      return { region, environmentName, keyName };
    })().finally(() => { metadataPromise = null; });
    return metadataPromise;
  }

  async function prepareOfferRegions() {
    if (!adapter.token || !env.HYPERSTACK_KEY_NAME) return;
    const discovered = await resources();
    const source = discovered.keypairs.find(item =>
      String(item.id) === String(env.HYPERSTACK_KEYPAIR_ID || '') ||
      (item.name === env.HYPERSTACK_KEY_NAME && item.environmentName === env.HYPERSTACK_ENVIRONMENT),
    );
    if (!source) return;
    const policy = source.registrationPolicy || { mode: 'on-demand', environments: [] };
    const allowed = policy.mode === 'selected'
      ? new Set([source.environmentName, ...(policy.environments || [])])
      : new Set(discovered.environments.map(item => item.name));
    const regions = discovered.environments
      .filter(item => allowed.has(item.name)).map(item => item.region).filter(Boolean);
    const value = JSON.stringify([...new Set(regions)]);
    env.HYPERSTACK_REGIONS = value;
    adapter.env.HYPERSTACK_REGIONS = value;
  }

  async function prepareCreate(options) {
    const discovered = await resources();
    const source = discovered.keypairs.find(item =>
      String(item.id) === String(env.HYPERSTACK_KEYPAIR_ID || '') ||
      (item.name === env.HYPERSTACK_KEY_NAME && item.environmentName === env.HYPERSTACK_ENVIRONMENT),
    );
    if (!source) throw Object.assign(Error('已配置的 SSH Keypair 不存在'), { status: 409 });
    const credential = managedKeypair(source.id, source.name);
    if (!credential) throw Object.assign(Error('当前 SSH Keypair 不是平台管理的，无法自动连接 VM'), { status: 409, code: 'hyperstack_keypair_not_managed' });
    const environments = discovered.environments.filter(item => item.region === options.region);
    if (!environments.length) throw Object.assign(Error(`${options.region} 没有可用的 Environment`), { status: 409, code: 'hyperstack_environment_region_missing' });
    const policy = source.registrationPolicy || { mode: 'on-demand', environments: [] };
    const target = environments.find(item => item.name === source.environmentName) ||
      environments.find(item => (policy.environments || []).includes(item.name)) ||
      (policy.mode === 'on-demand' ? environments[0] : null);
    if (!target) throw Object.assign(Error(`${options.region} 未在该 Keypair 的指定 Environment 列表中`), { status: 409, code: 'hyperstack_environment_not_selected' });
    let targetKeypair = discovered.keypairs.find(item =>
      item.environmentName === target.name && source.fingerprint && item.fingerprint === source.fingerprint,
    );
    if (!targetKeypair) {
      if (policy.mode !== 'on-demand') throw Object.assign(Error('指定 Environment 中尚未注册该 Keypair'), { status: 409 });
      targetKeypair = await registerKeypair(source, target.name, discovered);
    }
    return { environmentName: target.name, keyName: targetKeypair.name, credential };
  }

  async function saveConfiguration(input) {
    const values = {
      HYPERSTACK_ENVIRONMENT: String(input.environment || '').trim(),
      HYPERSTACK_KEY_NAME: String(input.keyName || '').trim(),
      HYPERSTACK_IMAGE_NAME: String(input.imageName || '').trim(),
      HYPERSTACK_IMAGE_USER: String(input.imageUser || 'ubuntu').trim(),
      HYPERSTACK_AGENT_CIDR: String(input.agentCidr || '0.0.0.0/0').trim(),
    };
    if (!values.HYPERSTACK_ENVIRONMENT || !values.HYPERSTACK_KEY_NAME || !values.HYPERSTACK_IMAGE_NAME || !values.HYPERSTACK_IMAGE_USER) {
      throw Object.assign(Error('Environment、SSH Keypair、Image 和 SSH 用户均为必填项'), { status: 400 });
    }
    const discovered = await adapter.configurationResources();
    const selectedEnvironment = discovered.environments.find(item => item.name === values.HYPERSTACK_ENVIRONMENT);
    const selectedKeypair = discovered.keypairs.find(item =>
      String(item.id) === String(input.keypairId || '') ||
      (item.name === values.HYPERSTACK_KEY_NAME && item.environmentName === values.HYPERSTACK_ENVIRONMENT),
    );
    if (!selectedEnvironment) throw Object.assign(Error('所选 Environment 不存在'), { status: 409 });
    if (!selectedKeypair) throw Object.assign(Error('所选 SSH Keypair 不存在'), { status: 409 });
    if (!managedKeypair(selectedKeypair.id, selectedKeypair.name)) throw Object.assign(Error('请选择平台管理的 SSH Keypair'), { status: 409, code: 'hyperstack_keypair_not_managed' });
    if (selectedKeypair.environmentName !== values.HYPERSTACK_ENVIRONMENT) throw Object.assign(Error('所选 SSH Keypair 不属于所选 Environment'), { status: 409 });
    values.HYPERSTACK_REGION = selectedKeypair.region || selectedEnvironment.region;
    values.HYPERSTACK_KEYPAIR_ENVIRONMENT = selectedKeypair.environmentName;
    values.HYPERSTACK_KEYPAIR_ID = String(selectedKeypair.id);
    if (!values.HYPERSTACK_REGION) throw Object.assign(Error('无法确认所选 SSH Keypair 的区域'), { status: 409 });
    if (values.HYPERSTACK_AGENT_CIDR && !/^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$/.test(values.HYPERSTACK_AGENT_CIDR)) {
      throw Object.assign(Error('访问 CIDR 格式无效，例如 203.0.113.10/32'), { status: 400 });
    }
    providerKeyStore.set(CONFIG_RECORD, JSON.stringify(values));
    Object.assign(env, values);
    Object.assign(adapter.env, values);
    return {
      configured: true,
      environment: values.HYPERSTACK_ENVIRONMENT,
      region: values.HYPERSTACK_REGION,
      keyName: values.HYPERSTACK_KEY_NAME,
      keypairId: values.HYPERSTACK_KEYPAIR_ID,
      keypairEnvironment: values.HYPERSTACK_KEYPAIR_ENVIRONMENT,
      imageName: values.HYPERSTACK_IMAGE_NAME,
      imageUser: values.HYPERSTACK_IMAGE_USER,
      agentCidr: values.HYPERSTACK_AGENT_CIDR,
    };
  }

  async function handleRequest(req, url, readBody) {
    const base = `/api/providers/${PROVIDER_ID}`;
    if (req.method === 'GET' && url.pathname === `${base}/resources`) {
      return { status: 200, data: await resources() };
    }
    const registration = url.pathname.match(new RegExp(`^${base}/keypairs/([^/]+)/registration$`));
    if (req.method === 'PUT' && registration) {
      const keypairId = decodeURIComponent(registration[1]);
      const input = await readBody(req);
      const mode = input.mode === 'selected' ? 'selected' : 'on-demand';
      const requested = Array.isArray(input.environments)
        ? [...new Set(input.environments.map(item => String(item).trim()).filter(Boolean))] : [];
      const discovered = await resources();
      const source = discovered.keypairs.find(item => String(item.id) === keypairId);
      if (!source) throw Object.assign(Error('Keypair 不存在'), { status: 404 });
      if (!source.platformManaged) throw Object.assign(Error('只能配置平台管理的 SSH Keypair'), { status: 409 });
      const known = new Set(discovered.environments.map(item => item.name));
      if (requested.some(name => !known.has(name))) throw Object.assign(Error('指定的 Environment 不存在'), { status: 409 });
      if (mode === 'selected') for (const name of requested) await registerKeypair(source, name, discovered);
      const value = policies();
      value[keypairId] = { mode, environments: mode === 'selected' ? requested : [] };
      savePolicies(value);
      await prepareOfferRegions();
      return { status: 200, data: { saved: true, keypairId, ...value[keypairId] } };
    }
    const keypair = url.pathname.match(new RegExp(`^${base}/keypairs/([^/]+)$`));
    if (req.method === 'DELETE' && keypair) {
      const keypairId = decodeURIComponent(keypair[1]);
      const discovered = await resources();
      const selected = discovered.keypairs.find(item => String(item.id) === keypairId);
      if (!selected) throw Object.assign(Error('Keypair 不存在'), { status: 404 });
      await adapter.deleteKeypair(keypairId);
      sshStore.remove(PROVIDER_ID, `keypair:${keypairId}`);
      if (selected.name) sshStore.remove(PROVIDER_ID, `keypair:${selected.name}`);
      const value = policies();
      delete value[keypairId];
      savePolicies(value);
      if (String(env.HYPERSTACK_KEYPAIR_ID || '') === keypairId) {
        const saved = parseRecord(providerKeyStore, CONFIG_RECORD);
        for (const key of ['HYPERSTACK_ENVIRONMENT','HYPERSTACK_KEY_NAME','HYPERSTACK_REGION','HYPERSTACK_KEYPAIR_ENVIRONMENT','HYPERSTACK_KEYPAIR_ID']) {
          delete saved[key]; delete env[key]; delete adapter.env[key];
        }
        providerKeyStore.set(CONFIG_RECORD, JSON.stringify(saved));
      }
      await prepareOfferRegions();
      return { status: 200, data: { deleted: true, id: keypairId } };
    }
    if (req.method === 'POST' && url.pathname === `${base}/keypairs`) {
      const input = await readBody(req);
      const environmentName = String(input.environment || '').trim();
      if (!environmentName) throw Object.assign(Error('请先选择 Environment'), { status: 400 });
      const name = `fast-gpu-managed-${Date.now().toString(36)}`;
      const managed = sshStore.createKey();
      const created = await adapter.importKeypair({ name, environmentName, publicKey: managed.publicKey });
      let keypairId = String(created.id || '');
      if (!keypairId) {
        const refreshed = await adapter.configurationResources();
        keypairId = String(refreshed.keypairs.find(item => item.name === (created.name || name) && item.environmentName === environmentName)?.id || name);
      }
      sshStore.save(`keypair:${keypairId}`, {
        provider: PROVIDER_ID,
        privateKey: managed.privateKey,
        publicKey: managed.publicKey,
        internalPort: sshStore.port,
        username: 'ubuntu',
      });
      return { status: 201, data: { id: keypairId, name: created.name || name, environmentName: created.environment?.name || environmentName, fingerprint: created.fingerprint } };
    }
    if (req.method === 'PUT' && url.pathname === `${base}/config`) {
      return { status: 200, data: await saveConfiguration(await readBody(req)) };
    }
    return null;
  }

  async function provisionViaSsh(instanceId, options, credential, tools) {
    const id = String(instanceId);
    const token = randomBytes(12).toString('hex');
    const transferDir = path.join(os.tmpdir(), `fast-gpu-${PROVIDER_ID}-${token}`);
    const keyFile = path.join(os.tmpdir(), `fast-gpu-${PROVIDER_ID}-${token}.pem`);
    const knownHostsFile = path.join(transferDir, 'known_hosts');
    const remoteDir = `/tmp/fast-gpu-${PROVIDER_ID}-${token}`;
    const setRuntime = (phase, extra = {}) => tools.setRuntime(id, {
      status: phase === 'ready' ? 'ready' : phase === 'failed' ? 'failed' : 'provisioning',
      phase,
      phaseLabel: PROVISION_PHASES[phase] || extra.phaseLabel || phase,
      updatedAt: new Date().toISOString(),
      ...extra,
    });
    let failureLog = '';
    setRuntime('awaiting_ssh');
    try {
      const managed = await tools.waitForManagedSsh(PROVIDER_ID, id, 10 * 60 * 1000);
      const values = {
        FLEET_AGENT_ID: credential.agentId,
        FLEET_AGENT_SECRET: credential.secret,
        FLEET_PROVIDER: PROVIDER_ID,
        FLEET_INSTANCE_NAME: options.name || 'fast-gpu',
        FLEET_SSH_PORT: String(options.sshPort || managed.port),
        FLEET_SSH_PUBLIC_KEY: managed.publicKey,
        FLEET_SSH_USER: managed.username,
        FLEET_ALLOW_CUDA128_FALLBACK: options.allowCuda128Fallback ? '1' : '0',
        FLEET_EXPECTED_CUDA_MAJOR: String(options.expectedCudaMajor || 13),
        FLEET_CONTAINER_IMAGE_CUDA13: tools.resolveCuda13Image(env),
        FLEET_CONTAINER_IMAGE_CUDA128: tools.resolveCuda128Image(env),
        FLEET_LOCAL_BOOTSTRAP_PATH: `${remoteDir}/bootstrap.sh`,
        FLEET_LOCAL_AGENT_PATH: `${remoteDir}/agent.js`,
      };
      if (options.startupScript) values.FLEET_STARTUP_SCRIPT_B64 = Buffer.from(options.startupScript, 'utf8').toString('base64');
      if (options.vmStartupScript) values.FLEET_VM_STARTUP_SCRIPT_B64 = Buffer.from(options.vmStartupScript, 'utf8').toString('base64');
      if (options.imageUrl) {
        values[options.expectedCudaMajor === 12 ? 'FLEET_CONTAINER_IMAGE_CUDA128' : 'FLEET_CONTAINER_IMAGE_CUDA13'] = options.imageUrl;
      }
      if (tools.telemetryMode() === 'named-tunnel' && env.BASE_URL) {
        values.BASE_URL = String(env.BASE_URL).replace(/\/+$/, '');
        values.FLEET_TELEMETRY_PUSH_URL = new URL('/api/agent/telemetry', env.BASE_URL).href;
      }
      const storageEnvironment = {
        ...Object.fromEntries(
          tools.storageEnvironmentKeys
            .filter(key => env[key])
            .map(key => [key, env[key]]),
        ),
        ...tools.storageProvisioningEnvironment(env),
      };
      if (Object.keys(storageEnvironment).length)
        values.FLEET_STORAGE_ENV_B64 = Buffer.from(
          JSON.stringify(storageEnvironment),
          'utf8',
        ).toString('base64');
      const envText = Object.entries(values)
        .map(([key, value]) => `${key}=${tools.shellQuote(value)}`).join('\n') + '\n';
      fs.mkdirSync(transferDir, { recursive: true });
      const sources = {
        'hyperstack.sh': path.join(__dirname, 'agent', 'hyperstack.sh'),
        'bootstrap.sh': path.join(tools.projectRoot, 'agent', 'bootstrap.sh'),
        'agent.js': path.join(tools.projectRoot, 'agent', 'agent.js'),
      };
      for (const [name, source] of Object.entries(sources)) fs.copyFileSync(source, path.join(transferDir, name));
      fs.writeFileSync(path.join(transferDir, 'provision.env'), envText, { mode: 0o600 });
      fs.writeFileSync(path.join(transferDir, 'run.sh'),
        `#!/usr/bin/env bash\nset +e\nset -a\nsource ${remoteDir}/provision.env\nset +a\nbash ${remoteDir}/hyperstack.sh\ncode=$?\nprintf '%s\\n' "$code" > ${remoteDir}/provision.exit\nexit "$code"\n`,
        { mode: 0o700 });
      fs.writeFileSync(keyFile, tools.openSshPrivateKey(managed.privateKey), { mode: 0o600 });
      tools.securePrivateKeyFile(keyFile);
      const sshArgs = [
        '-T', '-i', keyFile, '-p', String(managed.port), '-o', 'BatchMode=yes',
        '-o', `UserKnownHostsFile=${knownHostsFile}`, '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1',
      ];
      const target = `${managed.username}@${managed.host}`;
      const deadline = Date.now() + 10 * 60 * 1000;
      while (true) {
        try { await tools.runCommand('ssh', [...sshArgs, target, 'true']); break; }
        catch (error) {
          if (Date.now() >= deadline) throw error;
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }
      setRuntime('uploading_bootstrap');
      await tools.runCommand('ssh', [...sshArgs, target, `mkdir -p ${remoteDir}`]);
      await tools.runCommand('scp', [
        '-i', keyFile, '-P', String(managed.port), '-o', 'BatchMode=yes',
        '-o', `UserKnownHostsFile=${knownHostsFile}`, '-o', 'StrictHostKeyChecking=accept-new',
        ...['hyperstack.sh','bootstrap.sh','agent.js','provision.env','run.sh'].map(name => path.join(transferDir, name)),
        `${target}:${remoteDir}/`,
      ]);
      const privilege = managed.username === 'root' ? '' : 'sudo -n ';
      const remote = `nohup ${privilege}bash ${remoteDir}/run.sh >${remoteDir}/runner.log 2>&1 </dev/null & echo $!`;
      const remotePid = String(await tools.runCommand('ssh', [...sshArgs, target, remote])).trim();
      if (!/^\d+$/.test(remotePid)) throw Error('SSH 初始化任务未返回有效 PID');
      let exitCode = '';
      while (!exitCode) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        try {
          const state = String(await tools.runCommand('ssh', [
            ...sshArgs, target,
            `${privilege}sh -c 'cat /var/lib/fast-gpu/provision.phase 2>/dev/null || true; printf "\\n__EXIT__\\n"; cat ${remoteDir}/provision.exit 2>/dev/null || true'`,
          ]));
          const [phase, result = ''] = state.split('\n__EXIT__\n');
          if (phase.trim() && phase.trim() !== 'ready') setRuntime(phase.trim());
          exitCode = result.trim();
        } catch {}
      }
      if (exitCode !== '0') {
        failureLog = String(await tools.runCommand('ssh', [
          ...sshArgs, target,
          `${privilege}tail -n 80 /var/lib/fast-gpu/provision.log 2>/dev/null || true`,
        ]).catch(() => '')).trim();
        throw Error(failureLog || `初始化退出码 ${exitCode}`);
      }
      const profile = JSON.parse(await tools.runCommand('ssh', [
        ...sshArgs, target, `${privilege}cat /var/lib/fast-gpu/profile.json`,
      ]));
      if (profile.status !== 'ready') throw Error('初始化脚本结束但运行环境未就绪');
      setRuntime('ready', profile);
    } catch (error) {
      setRuntime('failed', {
        phaseLabel: 'SSH 自动装机失败',
        reason: error.message,
        log: failureLog || error.message,
      });
      tools.logError(`初始化失败，保留实例供排障`, id, error.message);
    } finally {
      tools.removeTemporaryFile(keyFile);
      fs.rmSync(transferDir, { recursive: true, force: true });
    }
  }

  return {
    restore,
    resources,
    managedKeypair,
    ensureRegionMetadata,
    prepareOfferRegions,
    prepareCreate,
    provisionViaSsh,
    handleRequest,
  };
}

module.exports = { createRuntime };
