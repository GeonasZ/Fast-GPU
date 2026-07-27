const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");
const pty = require("node-pty");
const {
  randomBytes,
  createPrivateKey,
  createPublicKey,
  publicEncrypt,
  createCipheriv,
  constants,
} = require("node:crypto");
const { adapters, ProviderError } = require("./lib/providers");
const { createCredentialStore } = require("./lib/credential-store");
const { createProviderKeyStore } = require("./lib/provider-key-store");
const { createBillingStore } = require("./lib/billing-store");
const objectStorage = require("./lib/object-storage");
const {
  validateProvisioning,
  resolveCuda13Image,
  publicControlPlaneError,
} = require("./lib/provisioning");
const { runtimeImages, resolveRuntimeImage } = require("./lib/runtime-images");
const { isStaleInventoryError } = require("./lib/inventory");
const {
  createAutoDLImageImportManager,
} = require("./lib/autodl-image-imports");
const {
  resolveTool,
  installTool,
  systemToolsDirectory,
  applicationToolsDirectory,
} = require("./lib/local-tools");
const { createAuthStore } = require("./lib/auth-store");
const CLIENT_MODE = process.env.FLEET_CLIENT_MODE === "local" ? "local" : "web";
const HOST =
  process.env.HOST || (CLIENT_MODE === "local" ? "127.0.0.1" : "0.0.0.0");
const cliDirectory = path.resolve(__dirname, ".data", "bin");
function pathSegments(value = process.env.PATH || "") {
  return String(value)
    .split(path.delimiter)
    .map((item) => item.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}
function cliPathRegistered() {
  return pathSegments().some(
    (item) => path.resolve(item).toLowerCase() === cliDirectory.toLowerCase(),
  );
}
function registerCliPath() {
  if (CLIENT_MODE !== "local" || process.platform !== "win32")
    throw Object.assign(
      Error("注册 PATH 目前只支持 Windows 本地一体化客户端"),
      { status: 409 },
    );
  fs.mkdirSync(cliDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(cliDirectory, "fast-gpu.cmd"),
    `@echo off\r\n"${process.execPath}" "${path.resolve(__dirname, "local-launcher.js")}" %*\r\n`,
    "utf8",
  );
  if (!cliPathRegistered()) {
    const escaped = cliDirectory.replaceAll("'", "''");
    const script = `$target='${escaped}';$current=[Environment]::GetEnvironmentVariable('Path','User');$parts=@($current -split ';'|Where-Object{$_});if(-not ($parts|Where-Object{$_.TrimEnd('\\') -ieq $target.TrimEnd('\\')})){[Environment]::SetEnvironmentVariable('Path',(($parts+$target)-join ';'),'User')}`;
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, encoding: "utf8" },
    );
    if (result.error || result.status !== 0)
      throw Object.assign(
        Error(
          `写入用户 PATH 失败：${String(result.error?.message || result.stderr || result.stdout).trim()}`,
        ),
        { status: 500 },
      );
    process.env.PATH = [...pathSegments(), cliDirectory].join(path.delimiter);
  }
  return { registered: true, directory: cliDirectory, command: "fast-gpu" };
}
const parentPid = Number(process.env.FLEET_PARENT_PID);
if (Number.isInteger(parentPid) && parentPid > 0) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch (error) {
      if (error.code === "ESRCH") process.exit(0);
    }
  }, 500).unref();
}
function commandAvailable(command) {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  return (
    spawnSync(lookup, [command], { windowsHide: true, stdio: "ignore" })
      .status === 0
  );
}
function executablePath(command) {
  if (command === "ssh") {
    const managed = resolveTool("ssh");
    if (managed.executable && managed.executable !== "ssh")
      return managed.executable;
  }
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(lookup, [command], {
    windowsHide: true,
    encoding: "utf8",
  });
  if (result.status !== 0) return "";
  const candidates = String(result.stdout || "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  return (
    candidates.find(
      (value) => process.platform !== "win32" || /\.exe$/i.test(value),
    ) ||
    candidates[0] ||
    ""
  );
}
function resolveRsyncCommand() {
  return resolveTool("rsync").executable;
}
function probeSsh(host, port = 22, timeout = 8000) {
  return new Promise((resolve) => {
    const started = Date.now(),
      socket = net.createConnection({ host, port });
    let done = false;
    const finish = (reachable, error = "") => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({
        generatedAt: new Date().toISOString(),
        mode: "ssh",
        host,
        port,
        reachable,
        allReachable: reachable,
        latencyMs: Date.now() - started,
        error,
      });
    };
    socket.setTimeout(timeout, () => finish(false, "SSH connection timed out"));
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => finish(false, error.message));
  });
}
async function probeOutboundReachabilityViaSsh(providerId, id) {
  const managed = await managedSshConnection(providerId, id);
  if (!managed)
    throw Object.assign(
      Error("该实例没有托管 SSH 凭据，无法在实例内部执行外网测试"),
      { status: 409, code: "ssh_credentials_unavailable" },
    );
  const targets = {
    huggingface: "https://huggingface.co",
    cloudflare: "https://www.cloudflare.com",
    aws: "https://aws.amazon.com",
    openai: "https://api.openai.com/v1/models",
    google: "https://www.google.com/generate_204",
  };
  const source = `import json, subprocess, time
targets=${JSON.stringify(targets)}
result={}
for name, url in targets.items():
    command=["curl","--noproxy","*","-o","/dev/null","-sS","-w","%{http_code}|%{remote_ip}|%{time_namelookup}|%{time_connect}|%{time_appconnect}|%{time_total}","--connect-timeout","8","--max-time","20",url]
    run=subprocess.run(command, capture_output=True, text=True)
    parts=(run.stdout.strip().split("|")+[""]*6)[:6]
    status, remote_ip, dns, connect, tls, total=parts
    def milliseconds(value):
        try: return float(value)*1000
        except ValueError: return None
    result[name]={"url":url,"proxyBypassed":True,"reachable":status[:1] in "234","status":int(status or 0),"remoteIp":remote_ip,"dnsMs":milliseconds(dns),"connectMs":milliseconds(connect),"tlsMs":milliseconds(tls),"totalMs":milliseconds(total),"error":run.stderr.strip()}
print(json.dumps({"generatedAt":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),"mode":"outbound-via-ssh","targets":result}))
`;
  const remote = `printf '%s' '${Buffer.from(source).toString("base64")}' | base64 -d | python3`;
  const token = randomBytes(12).toString("hex"),
    keyFile = path.join(os.tmpdir(), `gpu-fleet-reachability-${token}.pem`);
  try {
    fs.writeFileSync(keyFile, openSshPrivateKey(managed.privateKey), {
      mode: 0o600,
    });
    securePrivateKeyFile(keyFile);
    const output = await runCommand(
      "ssh",
      [
        "-i",
        keyFile,
        "-p",
        String(managed.port),
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "ConnectionAttempts=1",
        `${managed.username}@${managed.host}`,
        remote,
      ],
      { timeout: 120000, killSignal: "SIGKILL" },
    );
    return JSON.parse(output.trim());
  } catch (cause) {
    throw Object.assign(Error(`实例外网可达性测试失败：${cause.message}`), {
      status: 502,
      code: "reachability_probe_failed",
      cause,
    });
  } finally {
    removeTemporaryFile(keyFile);
  }
}
process.env.FLEET_SSH_PORT = String(process.env.FLEET_SSH_PORT || 22022);
let baseUrlSource = process.env.BASE_URL ? "environment" : "none";
function applyBaseUrl(value) {
  const base = String(value || "")
    .trim()
    .replace(/\/+$/, "");
  if (!base) {
    for (const key of [
      "BASE_URL",
      "PUBLIC_BASE_URL",
      "FLEET_BOOTSTRAP_URL",
      "FLEET_AGENT_JS_URL",
    ])
      delete process.env[key];
    return;
  }
  process.env.BASE_URL = base;
  process.env.PUBLIC_BASE_URL = new URL("/", base).href;
  process.env.FLEET_BOOTSTRAP_URL = new URL(
    "/provision/bootstrap.sh",
    base,
  ).href;
  process.env.FLEET_AGENT_JS_URL = new URL("/provision/agent.js", base).href;
}
if (process.env.BASE_URL) {
  try {
    const issue = publicControlPlaneError(process.env.BASE_URL);
    if (
      issue &&
      CLIENT_MODE === "local" &&
      process.env.FLEET_DEPLOYMENT_MODE === "all-in-one"
    ) {
      console.warn(
        `忽略无效的 BASE_URL，等待在一体化客户端中重新配置：${issue}`,
      );
      delete process.env.BASE_URL;
      baseUrlSource = "none";
    } else applyBaseUrl(process.env.BASE_URL);
  } catch (error) {
    if (
      CLIENT_MODE !== "local" ||
      process.env.FLEET_DEPLOYMENT_MODE !== "all-in-one"
    )
      throw error;
    console.warn(
      `忽略无效的 BASE_URL，等待在一体化客户端中重新配置：${error.message}`,
    );
    delete process.env.BASE_URL;
    baseUrlSource = "none";
  }
}
const providerDefinitions = {
  ppio: {
    env: "PPIO_API_KEY",
    keyUrl: "https://ppio.com/settings/key-management",
  },
  autodl: { env: "AUTODL_TOKEN", keyUrl: "https://www.autodl.com/" },
  hyperstack: {
    env: "HYPERSTACK_API_KEY",
    keyUrl: "https://console.hyperstack.cloud/api-keys",
  },
  runpod: {
    env: "RUNPOD_API_KEY",
    keyUrl: "https://www.console.runpod.io/user/settings",
  },
};
const credentialStore = createCredentialStore(process.env),
  providerKeyStore = createProviderKeyStore(process.env),
  billingStore = createBillingStore(process.env),
  authStore = createAuthStore(process.env);
const savedControlPlaneConfig = providerKeyStore.get(
  "__control_plane_config__",
);
let savedControlPlaneSettings = {};
if (savedControlPlaneConfig) {
  try {
    savedControlPlaneSettings = JSON.parse(savedControlPlaneConfig) || {};
    if (!process.env.BASE_URL && savedControlPlaneSettings.baseUrl) {
      applyBaseUrl(savedControlPlaneSettings.baseUrl);
      baseUrlSource = "saved";
    }
  } catch (error) {
    console.error("读取控制面配置失败", error.message);
  }
}
let telemetryMode =
  process.env.FLEET_TELEMETRY_MODE === "named-tunnel"
    ? "named-tunnel"
    : savedControlPlaneSettings.telemetryMode === "named-tunnel"
      ? "named-tunnel"
      : "ssh";
process.env.FLEET_TELEMETRY_MODE = telemetryMode;
const STORAGE_ENV_KEYS = {
  r2: {
    endpoint: "R2_S3_ENDPOINT",
    bucket: "R2_S3_BUCKET",
    prefix: "R2_S3_PREFIX",
    region: "R2_S3_REGION",
    accessKeyId: "R2_S3_ACCESS_KEY_ID",
    secretAccessKey: "R2_S3_SECRET_ACCESS_KEY",
    enabled: "R2_S3_ENABLED",
  },
  oss: {
    endpoint: "OSS_S3_ENDPOINT",
    bucket: "OSS_S3_BUCKET",
    prefix: "OSS_S3_PREFIX",
    region: "OSS_S3_REGION",
    accessKeyId: "OSS_S3_ACCESS_KEY_ID",
    secretAccessKey: "OSS_S3_SECRET_ACCESS_KEY",
    enabled: "OSS_S3_ENABLED",
  },
};
function applyStorageConfig(config) {
  process.env.STORAGE_PRIMARY_PROVIDER = String(config.primaryProvider || "r2");
  for (const [provider, keys] of Object.entries(STORAGE_ENV_KEYS)) {
    const values = config.providers?.[provider] || {};
    for (const [field, key] of Object.entries(keys)) {
      const value =
        field === "enabled"
          ? values.enabled
            ? "1"
            : ""
          : String(values[field] || "");
      if (value) process.env[key] = value;
      else delete process.env[key];
    }
  }
}
// Resolved credentials + bucket for an enabled storage provider. Returns null
// when the provider is disabled or incomplete, so callers can 409 early.
function storageProviderConfig(providerId, requireEnabled = true) {
  const keys = STORAGE_ENV_KEYS[providerId];
  if (!keys || (requireEnabled && process.env[keys.enabled] !== "1")) return null;
  const bucket = process.env[keys.bucket];
  if (
    !bucket ||
    !process.env[keys.endpoint] ||
    !process.env[keys.accessKeyId] ||
    !process.env[keys.secretAccessKey]
  )
    return null;
  return {
    provider: providerId,
    endpoint: process.env[keys.endpoint],
    region: process.env[keys.region],
    accessKeyId: process.env[keys.accessKeyId],
    secretAccessKey: process.env[keys.secretAccessKey],
    bucket,
    prefix: process.env[keys.prefix] || "",
  };
}
// In-flight multipart uploads. The authoritative resume state lives on R2
// (UploadId + parts); this map just lets us reconcile on create and list
// resumable uploads. It is rebuilt from R2 on demand when the client supplies
// an uploadId, so it survives nothing and needs to survive nothing.
const STORAGE_UPLOAD_STATE_KEY = "__object_storage_uploads__";
function loadActiveUploads() {
  try {
    const saved = providerKeyStore.get(STORAGE_UPLOAD_STATE_KEY);
    return new Map(
      Object.entries(saved ? JSON.parse(saved) : {}).filter(
        ([uploadId, record]) =>
          /^[a-zA-Z0-9._-]+$/.test(uploadId) && record && typeof record === "object",
      ),
    );
  } catch (error) {
    console.error("读取对象存储上传缓存失败", error.message);
    return new Map();
  }
}
const activeUploads = loadActiveUploads();
const activeUploadRuns = new Map();
function persistActiveUploads() {
  providerKeyStore.set(
    STORAGE_UPLOAD_STATE_KEY,
    JSON.stringify(Object.fromEntries(activeUploads)),
  );
}
function normalizeObjectKey(value) {
  const key = String(value || "").replace(/^\/+/, "");
  if (!key || key.includes("..") || /[\x00-\x1f]/.test(key))
    throw Object.assign(Error("目标 Key 不能为空且不能包含 .. 或控制字符"), {
      status: 400,
      code: "invalid_object_key",
    });
  return key;
}
function resolveDestinationKey(prefix, rawKey) {
  const clean = normalizeObjectKey(rawKey);
  const trimmedPrefix = String(prefix || "").replace(/^\/+|\/+$/g, "");
  return trimmedPrefix ? `${trimmedPrefix}/${clean}` : clean;
}
function storedStorageConfig() {
  const value = providerKeyStore.get("__object_storage_config__");
  if (!value) return null;
  return JSON.parse(value);
}
let savedStorageConfig = null;
try {
  savedStorageConfig = storedStorageConfig();
  if (savedStorageConfig) {
    applyStorageConfig(savedStorageConfig);
  }
} catch (error) {
  console.error("读取对象存储配置失败", error.message);
}
const savedHyperstackConfig = providerKeyStore.get("__hyperstack_config__");
if (savedHyperstackConfig) {
  try {
    Object.assign(process.env, JSON.parse(savedHyperstackConfig));
  } catch (error) {
    console.error("读取 Hyperstack 配置失败", error.message);
  }
}
const savedTailscaleAuthKey = providerKeyStore.get("__tailscale_auth_key__");
if (savedTailscaleAuthKey)
  process.env.TAILSCALE_AUTH_KEY = savedTailscaleAuthKey;
for (const [id, definition] of Object.entries(providerDefinitions)) {
  const saved = providerKeyStore.get(id);
  if (saved) {
    process.env[definition.env] = saved;
    const activeKeyId = providerKeyStore.status(id).activeKeyId;
    if (activeKeyId) billingStore.bindProviderCredential(id, activeKeyId);
  }
}
const PORT = Number(process.env.PORT || 4173),
  root = path.join(__dirname, "public"),
  providers = adapters();
const agentCredentials = credentialStore.agents,
  sshStore = credentialStore.ssh,
  instanceAccessStore = credentialStore.access,
  telemetryHistory = credentialStore.telemetryHistory;
for (const [providerId, adapter] of Object.entries(providers)) {
  const action = adapter.action.bind(adapter);
  adapter.create = async (options) => {
    const credential = agentCredentials.create(
      providerId,
      options.name || "gpu-fleet",
    );
    try {
      const isolated = adapters({
        ...process.env,
        FLEET_AGENT_ID: credential.agentId,
        FLEET_AGENT_SECRET: credential.secret,
      })[providerId];
      const item = await isolated.create(options);
      agentCredentials.bind(credential.agentId, item.id);
      return item;
    } catch (error) {
      agentCredentials.revokeAgent(credential.agentId);
      throw error;
    }
  };
  adapter.action = async (id, operation) => {
    const result = await action(id, operation);
    if (operation === "delete") {
      agentCredentials.revokeInstance(providerId, id);
      sshStore.remove(providerId, id);
      instanceAccessStore.remove(providerId, id);
    }
    if (operation === "start")
      void reinjectTelemetryAgent(providerId, id, { recoveryOnly: true }).catch((error) => {
        const credential = agentCredentials.findByInstance(providerId, id),
          key = credential
            ? `${credential.provider}:${credential.instance_name}`
            : `${providerId}:${id}`;
        instanceTelemetryKeys.set(String(id), key);
        telemetryDiagnostics.set(key, {
          state: "agent_error",
          message: `遥测 Agent 重新注入失败：${error.message}`,
          component: "Agent 自愈",
          code: error.code || "agent_reinject_failed",
          at: Date.now(),
        });
        console.error(
          `实例 ${providerId}/${id} 遥测 Agent 重新注入失败：`,
          error.message,
        );
      });
    return result;
  };
}
const autodlImageImports = createAutoDLImageImportManager(providers.autodl);
const agentTargets = new Map(),
  hyperstackProvisioning = new Map(),
  instanceRuntime = new Map(),
  baseUrlUpdates = new Map(),
  pushedTelemetry = new Map(),
  telemetryDiagnostics = new Map(),
  instanceTelemetryKeys = new Map(),
  instanceFirstSeen = new Map(),
  telemetryReadyKeys = new Set(),
  lifecycleActions = new Map(),
  benchmarkJobs = new Map(),
  sshBenchmarkRuns = new Map(),
  sshSessions = new Map(),
  sshTelemetrySessions = new Map(),
  telemetryListeners = new Map(),
  persistedTelemetryThisRun = new Set(),
  sshReadiness = new Map(),
  inventoryMissingObservations = new Map();
const platformStartedAt = Date.now(),
  telemetryRecoveryStartupGraceMs = Math.max(
    0,
    Number(process.env.FLEET_TELEMETRY_RECOVERY_STARTUP_GRACE_MS) || 300000,
  );
function persistTelemetrySeen(providerId, instanceId) {
  if (instanceId === undefined || instanceId === null) return;
  const key = `${providerId}:${instanceId}`;
  if (persistedTelemetryThisRun.has(key)) return;
  telemetryHistory.markSeen(providerId, instanceId);
  persistedTelemetryThisRun.add(key);
}
function purgeRemovedInstanceArtifacts(providerId, id) {
  const instanceId = String(id),
    telemetryKey = instanceTelemetryKeys.get(instanceId),
    sshKey = `${providerId}:${instanceId}`;
  agentCredentials.revokeInstance(providerId, instanceId);
  sshStore.remove(providerId, instanceId);
  instanceAccessStore.remove(providerId, instanceId);
  telemetryHistory.remove(providerId, instanceId);
  persistedTelemetryThisRun.delete(sshKey);
  stopSshTelemetry(sshKey);
  agentTargets.delete(instanceId);
  instanceRuntime.delete(instanceId);
  baseUrlUpdates.delete(sshKey);
  instanceFirstSeen.delete(instanceId);
  lifecycleActions.delete(instanceId);
  sshReadiness.delete(sshKey);
  if (telemetryKey) {
    pushedTelemetry.delete(telemetryKey);
    telemetryDiagnostics.delete(telemetryKey);
    telemetryListeners.delete(telemetryKey);
  }
  instanceTelemetryKeys.delete(instanceId);
}
function reconcileProviderInventory(result) {
  const failedProviders = new Set(result.errors.map((x) => x.providerId)),
    seenByProvider = new Map(
      Object.keys(providers).map((id) => [
        id,
        new Set(
          result.data
            .filter((x) => x.provider === id)
            .map((x) => String(x.id)),
        ),
      ]),
    );
  for (const instance of result.data) {
    billingStore.observe(instance);
    inventoryMissingObservations.delete(`${instance.provider}:${instance.id}`);
  }

  const candidates = new Map();
  for (const record of [
    ...billingStore.listInstances(),
    ...sshStore.list(),
    ...agentCredentials.list(),
    ...instanceAccessStore.list(),
  ]) {
    const providerId = String(record.provider),
      id = String(record.provider_instance_id || record.id),
      key = `${providerId}:${id}`,
      previous = candidates.get(key);
    candidates.set(key, {
      provider: providerId,
      id,
      createdAt:
        previous?.createdAt ||
        record.created_at ||
        record.createdAt ||
        record.first_observed_at,
    });
  }
  for (const candidate of candidates.values()) {
    if (
      failedProviders.has(candidate.provider)
    )
      continue;
    const key = `${candidate.provider}:${candidate.id}`;
    if (seenByProvider.get(candidate.provider)?.has(candidate.id)) {
      inventoryMissingObservations.delete(key);
      continue;
    }
    inventoryMissingObservations.set(
      key,
      (inventoryMissingObservations.get(key) || 0) + 1,
    );
  }
  for (const providerId of Object.keys(providers)) {
    if (failedProviders.has(providerId)) continue;
    const presentOrUnconfirmed = new Set(seenByProvider.get(providerId) || []);
    for (const candidate of candidates.values()) {
      if (candidate.provider !== providerId) continue;
      const key = `${providerId}:${candidate.id}`,
        deleteConfirmed =
          lifecycleActions.get(candidate.id)?.action === "delete";
      if (!deleteConfirmed && (inventoryMissingObservations.get(key) || 0) < 2)
        presentOrUnconfirmed.add(candidate.id);
    }
    billingStore.markMissing(providerId, [...presentOrUnconfirmed]);
  }
  for (const candidate of candidates.values()) {
    if (
      failedProviders.has(candidate.provider) ||
      seenByProvider.get(candidate.provider)?.has(candidate.id)
    )
      continue;
    const billing = billingStore.getInstance(candidate.provider, candidate.id),
      deleteConfirmed =
        lifecycleActions.get(candidate.id)?.action === "delete",
      confirmedMissing =
        deleteConfirmed ||
        billing?.status === "terminated" ||
        (inventoryMissingObservations.get(
          `${candidate.provider}:${candidate.id}`,
        ) || 0) >= 2;
    if (confirmedMissing) {
      purgeRemovedInstanceArtifacts(candidate.provider, candidate.id);
      inventoryMissingObservations.delete(
        `${candidate.provider}:${candidate.id}`,
      );
    }
  }
  return { failedProviders, seenByProvider };
}
function publishTelemetry(key, data) {
  for (const listener of telemetryListeners.get(key) || []) listener(data);
}
function completeBaseUrlUpdate(providerId, id) {
  const key = `${providerId}:${id}`;
  baseUrlUpdates.delete(key);
}
const telemetryGraceMs = Math.max(
  0,
  Number(process.env.FLEET_TELEMETRY_GRACE_MS) || 10000,
);
function json(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(data));
}
function cookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim().split("=").map(decodeURIComponent))
      .filter((pair) => pair.length === 2),
  );
}
function sessionUser(req) {
  return CLIENT_MODE === "local"
    ? { id: "local", email: "", displayName: "本地用户", local: true }
    : authStore.authenticate(cookies(req).fleet_session);
}
function sessionCookie(req, session) {
  const secure =
    String(req.headers["x-forwarded-proto"] || "")
      .split(",")[0]
      .trim() === "https:" ||
    String(req.headers["x-forwarded-proto"] || "")
      .split(",")[0]
      .trim() === "https" ||
    String(process.env.BASE_URL || "").startsWith("https://");
  return `fleet_session=${encodeURIComponent(session.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000))}${secure ? "; Secure" : ""}`;
}
function clearSessionCookie() {
  return "fleet_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}
function encryptedDownload(
  secret,
  publicKey,
  filename,
  contentType = "application/octet-stream",
) {
  let recipient;
  try {
    recipient = createPublicKey({
      key: Buffer.from(String(publicKey || ""), "base64"),
      format: "der",
      type: "spki",
    });
  } catch {
    throw Object.assign(Error("下载端临时公钥无效"), { status: 400 });
  }
  if (recipient.asymmetricKeyType !== "rsa")
    throw Object.assign(Error("下载端必须使用 RSA 临时公钥"), { status: 400 });
  const aesKey = randomBytes(32),
    iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", aesKey, iv),
    ciphertext = Buffer.concat([
      cipher.update(String(secret), "utf8"),
      cipher.final(),
    ]);
  const wrappedKey = publicEncrypt(
    {
      key: recipient,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    aesKey,
  );
  return {
    algorithm: "RSA-OAEP-256+A256GCM",
    wrappedKey: wrappedKey.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    filename,
    contentType,
  };
}
function body(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => {
      s += c;
      if (s.length > 1e6) reject(Error("请求体过大"));
    });
    req.on("end", () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        reject(Object.assign(Error("JSON 格式错误"), { status: 400 }));
      }
    });
  });
}
const parsedRequestBodies = new WeakMap(),
  readRequestBody = body;
body = function (req) {
  if (!parsedRequestBodies.has(req))
    parsedRequestBodies.set(req, readRequestBody(req));
  return parsedRequestBodies.get(req);
};
function receiveUpload(
  req,
  filename,
  limit = Math.max(1, Number(process.env.FLEET_DIRECT_UPLOAD_MAX_GB) || 5) *
    1024 ** 3,
) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > limit) {
      req.resume();
      return reject(
        Object.assign(
          Error(`直接上传最大支持 ${Math.round(limit / 1024 ** 3)} GB`),
          { status: 413 },
        ),
      );
    }
    const output = fs.createWriteStream(filename, { mode: 0o600, flags: "wx" });
    let size = 0,
      settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      output.destroy();
      fs.rm(filename, { force: true }, () => {});
      reject(error);
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit)
        fail(
          Object.assign(
            Error(`直接上传最大支持 ${Math.round(limit / 1024 ** 3)} GB`),
            { status: 413 },
          ),
        );
    });
    req.once("aborted", () =>
      fail(Object.assign(Error("浏览器上传已中断"), { status: 499 })),
    );
    req.once("error", fail);
    output.once("error", fail);
    output.once("finish", () => {
      if (!settled) {
        settled = true;
        resolve(size);
      }
    });
    req.pipe(output);
  });
}
function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true }),
      output = [];
    child.stdout?.on("data", (x) => output.push(x));
    child.stderr?.on("data", (x) => output.push(x));
    child.once("error", (error) =>
      reject(
        Object.assign(new Error(`${command} 启动失败：${error.message}`), {
          status: 500,
        }),
      ),
    );
    child.once("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(output).toString())
        : reject(
            Object.assign(
              new Error(
                Buffer.concat(output).toString().trim() ||
                  `${command} 退出码 ${code}`,
              ),
              { status: 502 },
            ),
          ),
    );
  });
}
const executeCommand = runCommand;
runCommand = function (command, args, options = {}) {
  if (
    path
      .basename(String(command))
      .toLowerCase()
      .replace(/\.exe$/, "") === "scp" &&
    args.length
  ) {
    args = [...args];
    const target = String(args.at(-1)),
      separator = target.indexOf(":");
    if (separator > 0) {
      const host = target.slice(0, separator + 1),
        remote = target.slice(separator + 1);
      if (remote.startsWith("'") && remote.endsWith("'")) {
        args[args.length - 1] =
          host + remote.slice(1, -1).replaceAll(`'"'"'`, "'");
      }
    }
  }
  return executeCommand(command, args, options);
};
const controlPlaneProbeToken = randomBytes(24).toString("hex");
let cloudflareLoginProcess = null,
  cloudflareLoginState = { state: "idle", url: "", error: "" },
  namedTunnelProcess = null,
  namedTunnelState = {
    state: "stopped",
    hostname: "",
    tunnelId: "",
    error: "",
  };
function cloudflareCertificatePath() {
  const candidates = [
    process.env.TUNNEL_ORIGIN_CERT,
    path.join(os.homedir(), ".cloudflared", "cert.pem"),
    path.join(os.homedir(), ".cloudflare-warp", "cert.pem"),
  ].filter(Boolean);
  return candidates.find((filename) => fs.existsSync(filename)) || "";
}
function cloudflareStatus() {
  const resolved = resolveTool("cloudflared"),
    certificate = cloudflareCertificatePath();
  return {
    installed: Boolean(resolved.executable),
    source: resolved.source,
    loggedIn: Boolean(certificate),
    certificateDirectory: certificate ? path.dirname(certificate) : "",
    login: cloudflareLoginState,
    tunnel: namedTunnelState,
  };
}
function runCloudflared(args, { timeout = 120000 } = {}) {
  const executable = resolveTool("cloudflared").executable;
  if (!executable)
    throw Object.assign(Error("本机尚未安装 cloudflared"), {
      status: 409,
      code: "cloudflared_missing",
    });
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }),
      stdout = [],
      stderr = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(Object.assign(Error("cloudflared 命令执行超时"), { status: 504 }));
    }, timeout);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString(),
        err = Buffer.concat(stderr).toString();
      code === 0
        ? resolve({ stdout: out, stderr: err })
        : reject(
            Object.assign(
              Error((err || out).trim() || `cloudflared 退出码 ${code}`),
              { status: 502, code: "cloudflared_command_failed" },
            ),
          );
    });
  });
}
function startCloudflareLogin() {
  if (cloudflareLoginProcess) return cloudflareLoginState;
  const executable = resolveTool("cloudflared").executable;
  if (!executable)
    throw Object.assign(Error("请先安装 cloudflared"), {
      status: 409,
      code: "cloudflared_missing",
    });
  cloudflareLoginState = { state: "waiting_browser", url: "", error: "" };
  const child = spawn(executable, ["tunnel", "login"], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  cloudflareLoginProcess = child;
  const inspect = (chunk) => {
    const match = String(chunk).match(/https:\/\/[^\s]+/i);
    if (match)
      cloudflareLoginState = {
        ...cloudflareLoginState,
        url: match[0].replace(/[),.]+$/, ""),
      };
  };
  child.stdout.on("data", inspect);
  child.stderr.on("data", inspect);
  child.once("error", (error) => {
    cloudflareLoginProcess = null;
    cloudflareLoginState = { state: "failed", url: "", error: error.message };
  });
  child.once("close", (code) => {
    cloudflareLoginProcess = null;
    cloudflareLoginState = cloudflareCertificatePath()
      ? { state: "logged_in", url: "", error: "" }
      : {
          state: "failed",
          url: "",
          error: `登录未完成（退出码 ${code}）`,
        };
  });
  return cloudflareLoginState;
}
async function verifyNamedTunnel(baseUrl, timeout = 60000) {
  const endpoint = new URL("/api/tunnel/health", baseUrl).href,
    deadline = Date.now() + timeout;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(8000),
        }),
        payload = await response.json().catch(() => ({}));
      if (response.ok && payload.token === controlPlaneProbeToken) return true;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw Object.assign(
    Error(
      `Named Tunnel 公网回探失败：${lastError || "域名没有返回当前平台"}`,
    ),
    { status: 409, code: "named_tunnel_verification_failed" },
  );
}
async function configureNamedTunnel(baseUrl) {
  if (
    CLIENT_MODE !== "local" ||
    process.env.FLEET_DEPLOYMENT_MODE !== "all-in-one"
  )
    return verifyNamedTunnel(baseUrl);
  const status = cloudflareStatus();
  if (!status.installed)
    throw Object.assign(Error("请先安装 cloudflared"), {
      status: 409,
      code: "cloudflared_missing",
    });
  if (!status.loggedIn)
    throw Object.assign(Error("Cloudflare 尚未登录，请先完成浏览器授权"), {
      status: 409,
      code: "cloudflare_not_logged_in",
    });
  const hostname = new URL(baseUrl).hostname,
    tunnelName = `fast-gpu-${hostname.replace(/[^a-z0-9-]/gi, "-").slice(0, 48)}`;
  let tunnels;
  try {
    tunnels = JSON.parse(
      (await runCloudflared(["tunnel", "list", "--output", "json"])).stdout ||
        "[]",
    );
  } catch (error) {
    throw Object.assign(Error(`读取 Cloudflare Tunnel 失败：${error.message}`), {
      status: error.status || 502,
      code: "cloudflare_tunnel_list_failed",
    });
  }
  let tunnel = tunnels.find((item) => item.name === tunnelName);
  if (!tunnel) {
    await runCloudflared(["tunnel", "create", tunnelName]);
    tunnels = JSON.parse(
      (await runCloudflared(["tunnel", "list", "--output", "json"])).stdout ||
        "[]",
    );
    tunnel = tunnels.find((item) => item.name === tunnelName);
  }
  const tunnelId = String(tunnel?.id || tunnel?.uuid || "");
  if (!tunnelId)
    throw Object.assign(Error("Named Tunnel 已创建，但无法读取 Tunnel ID"), {
      status: 502,
    });
  await runCloudflared([
    "tunnel",
    "route",
    "dns",
    tunnelId,
    hostname,
  ]);
  if (namedTunnelProcess) {
    try {
      namedTunnelProcess.kill();
    } catch {}
    namedTunnelProcess = null;
  }
  const executable = resolveTool("cloudflared").executable,
    args = [
      "tunnel",
      "--url",
      `http://127.0.0.1:${Number(process.env.PORT || 4173)}`,
      "run",
      tunnelId,
    ],
    child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  namedTunnelProcess = child;
  namedTunnelState = {
    state: "starting",
    hostname,
    tunnelId,
    error: "",
  };
  const inspect = (chunk) => {
    if (/registered tunnel connection|connection .* registered/i.test(chunk))
      namedTunnelState = { ...namedTunnelState, state: "running", error: "" };
  };
  child.stdout.on("data", inspect);
  child.stderr.on("data", inspect);
  child.once("error", (error) => {
    namedTunnelProcess = null;
    namedTunnelState = {
      state: "failed",
      hostname,
      tunnelId,
      error: error.message,
    };
  });
  child.once("close", (code) => {
    if (namedTunnelProcess === child) namedTunnelProcess = null;
    if (namedTunnelState.hostname === hostname)
      namedTunnelState = {
        state: "failed",
        hostname,
        tunnelId,
        error: `cloudflared 已退出（${code}）`,
      };
  });
  try {
    await verifyNamedTunnel(baseUrl);
    namedTunnelState = { state: "running", hostname, tunnelId, error: "" };
    return namedTunnelState;
  } catch (error) {
    try {
      child.kill();
    } catch {}
    if (namedTunnelProcess === child) namedTunnelProcess = null;
    namedTunnelState = {
      state: "failed",
      hostname,
      tunnelId,
      error: error.message,
    };
    throw error;
  }
}
async function verifyManagedSsh(managed, timeout = 20000) {
  const args = [
    "-i",
    managed.keyFile,
    "-p",
    String(managed.port),
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "ConnectionAttempts=1",
    `${managed.username}@${managed.host}`,
    "true",
  ];
  try {
    await runCommand("ssh", args, { timeout, killSignal: "SIGKILL" });
  } catch (cause) {
    throw Object.assign(
      Error(`SSH 无法连接：${cause.message}`),
      { status: 502, code: "ssh_unreachable", cause },
    );
  }
}
async function waitForProviderSsh(adapter, id, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (true) {
    try {
      return await adapter.getSshConnection(id);
    } catch (error) {
      if (error.code !== "ssh_pending") throw error;
      if (Date.now() >= deadline)
        throw Object.assign(
          Error(
            "SSH 连接超时：实例已运行，但厂商在 30 秒内仍未返回公网 SSH 凭据",
          ),
          { status: 409, code: "ssh_timeout" },
        );
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}
function canProbeSsh(runtime) {
  return (
    !runtime ||
    runtime?.status === "ready" ||
    [
      "installing_runtime_dependencies",
      "installing_developer_tools",
      "verifying_gpu",
      "starting_agent",
      "syncing_data",
      "telemetry_ready",
      "ready",
    ].includes(runtime?.phase)
  );
}
function scheduleSshReadinessProbe(providerId, id, runtime) {
  const key = `${providerId}:${id}`,
    current = sshReadiness.get(key);
  if (
    !canProbeSsh(runtime) ||
    current?.ready ||
    current?.probing ||
    Date.now() - (current?.checkedAt || 0) < 3000
  )
    return;
  // 重试期间保留上一条诊断，避免界面在“无错误”和“SSH 尚未就绪”
  // 之间闪烁。只有新的探测结果完成后才替换错误内容。
  sshReadiness.set(key, {
    ...current,
    ready: false,
    probing: true,
    checkedAt: Date.now(),
  });
  void (async () => {
    let keyFile = "";
    try {
      const managed = await managedSshConnection(providerId, id);
      if (!managed) throw Error("SSH 公网入口尚未分配");
      keyFile = path.join(
        os.tmpdir(),
        `gpu-fleet-readiness-${randomBytes(12).toString("hex")}.pem`,
      );
      fs.writeFileSync(keyFile, openSshPrivateKey(managed.privateKey), {
        mode: 0o600,
      });
      securePrivateKeyFile(keyFile);
      await verifyManagedSsh({ ...managed, keyFile }, 12000);
      sshReadiness.set(key, {
        ready: true,
        probing: false,
        checkedAt: Date.now(),
        error: "",
      });
    } catch (error) {
      sshReadiness.set(key, {
        ready: false,
        probing: false,
        checkedAt: Date.now(),
        error: error.message,
      });
    } finally {
      if (keyFile) removeTemporaryFile(keyFile);
    }
  })();
}
async function managedSshConnection(providerId, id) {
  const adapter = provider(providerId),
    saved = sshStore.get(providerId, id);
  if (!saved) return null;
  let host = saved.host,
    port = Number(saved.externalPort);
  if ((!host || !port) && typeof adapter.resolveSshEndpoint === "function")
    ({ host, port } = await adapter.resolveSshEndpoint(id, saved.internalPort));
  else if (!host || !port) {
    const listed = await adapter.listInstances(),
      instance = listed.find((x) => String(x.id) === String(id));
    if (!instance)
      throw Object.assign(Error("实例不存在或厂商 API 暂未返回实例"), {
        status: 404,
        code: "ssh_provider_error",
      });
    host = instance.sshHost || instance.ip;
    port = Number(instance.sshPort);
  }
  if (!host || !port)
    throw Object.assign(Error("厂商尚未分配 SSH 公网地址或映射端口"), {
      status: 409,
      code: "ssh_pending",
    });
  if (port === 22)
    throw Object.assign(Error("拒绝使用默认 SSH 端口"), {
      status: 409,
      code: "ssh_provider_error",
    });
  const record = sshStore.update(providerId, id, { host, externalPort: port });
  const identityFile =
    `gpu-fleet-${providerId}-${id}`.replace(/[^a-z0-9._-]/gi, "_") + ".pem";
  return {
    ...record,
    host,
    port,
    identityFile,
    command: `ssh -i "${identityFile}" -p ${port} ${record.username}@${host}`,
  };
}
function closeSshSession(sessionId) {
  const session = sshSessions.get(sessionId);
  if (!session) return false;
  sshSessions.delete(sessionId);
  session.process.kill();
  if (session.keyFile) fs.rm(session.keyFile, { force: true }, () => {});
  return true;
}
function removeTemporaryFile(filename, attempt = 0) {
  fs.rm(filename, { force: true }, (error) => {
    if (!error) return;
    if (
      process.platform === "win32" &&
      ["EPERM", "EBUSY"].includes(error.code) &&
      attempt < 12
    ) {
      try {
        fs.chmodSync(filename, 0o600);
      } catch {}
      const timer = setTimeout(
        () => removeTemporaryFile(filename, attempt + 1),
        Math.min(100 * 2 ** attempt, 2000),
      );
      timer.unref?.();
    } else console.warn(`临时文件清理失败：${filename}：${error.message}`);
  });
}
function securePrivateKeyFile(filename) {
  fs.chmodSync(filename, 0o600);
  if (process.platform !== "win32") return;
  const identity = spawnSync("whoami", [], {
    encoding: "utf8",
    windowsHide: true,
  });
  const account = String(identity.stdout || "").trim();
  if (identity.status !== 0 || !account)
    throw new Error("无法确定运行平台服务的 Windows 账号");
  const acl = spawnSync(
    "icacls",
    [filename, "/inheritance:r", "/grant:r", `${account}:(R)`],
    { encoding: "utf8", windowsHide: true },
  );
  if (acl.status !== 0)
    throw new Error(
      `无法收紧 SSH 临时私钥权限：${String(acl.stderr || acl.stdout).trim()}`,
    );
}
async function waitForManagedSsh(providerId, id, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const managed = await managedSshConnection(providerId, id);
      if (managed) return managed;
    } catch (error) {
      if (
        !["ssh_pending", "ssh_provider_error"].includes(error.code) &&
        error.status !== 404
      )
        throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw Object.assign(
    Error("实例启动后 120 秒内 SSH 仍不可用，无法重新注入遥测 Agent"),
    { code: "agent_reinject_ssh_timeout" },
  );
}
async function repairManagedSshKeyWithProviderPassword(
  providerId,
  id,
  publicKey,
) {
  const adapter = provider(providerId);
  if (typeof adapter.getSshConnection !== "function" || !publicKey)
    throw Object.assign(Error("厂商未提供可用于恢复托管公钥的密码凭据"), {
      code: "ssh_key_repair_unavailable",
    });
  const legacy = await waitForProviderSsh(adapter, id),
    sshExecutable = executablePath("ssh");
  if (!sshExecutable)
    throw Object.assign(Error("本机未找到 OpenSSH 客户端"), {
      code: "ssh_client_unavailable",
    });
  const encodedKey = Buffer.from(String(publicKey)).toString("base64"),
    marker = `__FLEET_KEY_REPAIRED_${randomBytes(6).toString("hex")}__`;
  const command = `mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"; touch "$HOME/.ssh/authorized_keys"; key="$(printf '%s' '${encodedKey}' | base64 -d)"; grep -qxF "$key" "$HOME/.ssh/authorized_keys" || printf '%s\\n' "$key" >> "$HOME/.ssh/authorized_keys"; chmod 600 "$HOME/.ssh/authorized_keys"; unset key; echo '${marker}'\r`;
  await new Promise((resolve, reject) => {
    const child = pty.spawn(
      sshExecutable,
      [
        "-tt",
        "-p",
        String(legacy.port),
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "PreferredAuthentications=password,keyboard-interactive",
        "-o",
        "PubkeyAuthentication=no",
        `${legacy.username}@${legacy.host}`,
      ],
      {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: { ...process.env, TERM: "xterm-256color" },
      },
    );
    let passwordSent = false,
      commandSent = false,
      output = "",
      settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {}
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(
      () =>
        finish(
          Object.assign(Error("厂商密码登录后修复托管公钥超时"), {
            code: "ssh_key_repair_timeout",
          }),
        ),
      30000,
    );
    child.onData((chunk) => {
      const text = String(chunk);
      output = (output + text).slice(-8000);
      if (!passwordSent && /(?:password|密码)\s*:/i.test(text)) {
        passwordSent = true;
        child.write(String(legacy.password) + "\r");
        return;
      }
      if (
        passwordSent &&
        !commandSent &&
        !/permission denied|authentication failed/i.test(output)
      ) {
        commandSent = true;
        setTimeout(() => child.write(command), 100);
      }
      if (output.includes(marker)) finish();
    });
    child.onExit(({ exitCode }) => {
      if (!settled)
        finish(
          Object.assign(
            Error(
              `厂商密码 SSH 在修复公钥前退出（${exitCode}）：${output.trim()}`,
            ),
            { code: "ssh_key_repair_failed" },
          ),
        );
    });
  });
}
const pendingInstanceAdoptions = new Map();
function adoptionInstallCommand(publicKey) {
  const encoded = Buffer.from(String(publicKey)).toString("base64");
  return `mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"; touch "$HOME/.ssh/authorized_keys"; key="$(printf '%s' '${encoded}' | base64 -d)"; grep -qxF "$key" "$HOME/.ssh/authorized_keys" || printf '%s\\n' "$key" >> "$HOME/.ssh/authorized_keys"; chmod 600 "$HOME/.ssh/authorized_keys"; unset key`;
}
async function sshWithPrivateKey({ host, port, username, privateKey, remote }) {
  const token = randomBytes(12).toString("hex"),
    keyFile = path.join(os.tmpdir(), `gpu-fleet-adopt-${token}.pem`);
  try {
    fs.writeFileSync(keyFile, openSshPrivateKey(privateKey), { mode: 0o600 });
    securePrivateKeyFile(keyFile);
    return await runCommand("ssh", [
      "-T", "-i", keyFile, "-p", String(port),
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=10",
      "-o", "ConnectionAttempts=1",
      `${username}@${host}`,
      remote,
    ]);
  } finally {
    removeTemporaryFile(keyFile);
  }
}
async function sshWithPassword({ host, port, username, password, remote }) {
  const sshExecutable = executablePath("ssh");
  if (!sshExecutable)
    throw Object.assign(Error("本机未找到 OpenSSH 客户端"), {
      code: "ssh_client_unavailable",
    });
  const marker = `__FLEET_ADOPTED_${randomBytes(6).toString("hex")}__`,
    command = `${remote}; echo '${marker}'\r`;
  await new Promise((resolve, reject) => {
    const child = pty.spawn(
      sshExecutable,
      [
        "-tt", "-p", String(port),
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "PreferredAuthentications=password,keyboard-interactive",
        "-o", "PubkeyAuthentication=no",
        `${username}@${host}`,
      ],
      {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: { ...process.env, TERM: "xterm-256color" },
      },
    );
    let passwordSent = false, commandSent = false, output = "", settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(
      () => finish(Object.assign(Error("SSH 密码验证超时"), {
        code: "ssh_password_timeout",
      })),
      30000,
    );
    child.onData((chunk) => {
      const text = String(chunk);
      output = (output + text).slice(-8000);
      if (!passwordSent && /(?:password|密码)\s*:/i.test(text)) {
        passwordSent = true;
        child.write(String(password) + "\r");
        return;
      }
      if (passwordSent && !commandSent &&
          !/permission denied|authentication failed/i.test(output)) {
        commandSent = true;
        setTimeout(() => child.write(command), 100);
      }
      if (output.includes(marker)) finish();
    });
    child.onExit(({ exitCode }) => {
      if (!settled)
        finish(Object.assign(
          Error(`SSH 密码登录失败（${exitCode}）：${output.trim()}`),
          { code: "ssh_password_failed" },
        ));
    });
  });
}
async function reinjectTelemetryAgent(providerId, id, { recoveryOnly = false } = {}) {
  const listed = await provider(providerId).listInstances(),
    instance = listed.find((item) => String(item.id) === String(id));
  if (!instance)
    throw Object.assign(
      Error("供应商尚未返回已启动实例，无法重新注入遥测 Agent"),
      { code: "agent_reinject_instance_missing" },
    );
  const updateKey = `${providerId}:${id}`;
  baseUrlUpdates.set(updateKey, {
    status: "updating",
    phase: "awaiting_ssh",
    phaseLabel: "正在等待 SSH 可用",
    updatedAt: new Date().toISOString(),
  });
  const previousCredential = agentCredentials.findByInstance(providerId, id);
  const credential = agentCredentials.create(
    providerId,
    instance.name || "gpu-fleet",
  );
  const managed = await waitForManagedSsh(providerId, id),
    token = randomBytes(12).toString("hex"),
    keyFile = path.join(os.tmpdir(), `gpu-fleet-agent-${token}.pem`),
    transferDir = path.join(os.tmpdir(), `gpu-fleet-bootstrap-${token}`),
    remoteDir = `/tmp/gpu-fleet-bootstrap-${token}`;
  // The active credential index is unique per provider instance. Revoke the
  // stale credential before binding its replacement after a platform restart.
  if (previousCredential?.agent_id)
    agentCredentials.revokeAgent(previousCredential.agent_id);
  agentCredentials.bind(credential.agentId, id);
  const values = {
    FLEET_AGENT_ID: credential.agentId,
    FLEET_AGENT_SECRET: credential.secret,
    FLEET_PROVIDER: providerId,
    FLEET_INSTANCE_NAME: instance.name || "gpu-fleet",
    FLEET_SSH_PORT: String(
      managed.internalPort || process.env.FLEET_SSH_PORT || 22022,
    ),
    FLEET_SSH_PUBLIC_KEY: managed.publicKey,
    FLEET_SSH_USER: managed.username,
  };
  if (recoveryOnly) values.FLEET_RECOVERY_ONLY = "1";
  if (telemetryMode === "named-tunnel" && process.env.BASE_URL) {
    values.BASE_URL = String(process.env.BASE_URL).replace(/\/+$/, "");
    values.FLEET_TELEMETRY_PUSH_URL = new URL(
      "/api/agent/telemetry",
      process.env.BASE_URL,
    ).href;
  }
  for (const key of [
    "STORAGE_PRIMARY_PROVIDER",
    "R2_S3_ENABLED",
    "R2_S3_ENDPOINT",
    "R2_S3_BUCKET",
    "R2_S3_PREFIX",
    "R2_S3_REGION",
    "R2_S3_ACCESS_KEY_ID",
    "R2_S3_SECRET_ACCESS_KEY",
    "OSS_S3_ENABLED",
    "OSS_S3_ENDPOINT",
    "OSS_S3_BUCKET",
    "OSS_S3_PREFIX",
    "OSS_S3_REGION",
    "OSS_S3_ACCESS_KEY_ID",
    "OSS_S3_SECRET_ACCESS_KEY",
    "FLEET_AGENT_BUNDLE_URL",
  ]) {
    if (process.env[key]) values[key] = process.env[key];
  }
  const envText =
    Object.entries(values)
      .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
      .join("\n") + "\n";
  const privilege = managed.username === "root" ? "" : "sudo -n ",
    remote = `${privilege}install -d -m 0755 /opt/gpu-fleet /var/lib/gpu-fleet; ${privilege}install -m 0755 ${remoteDir}/bootstrap.sh /opt/gpu-fleet/bootstrap.sh; ${privilege}install -m 0644 ${remoteDir}/agent.js /opt/gpu-fleet/agent.js; ${privilege}install -m 0600 ${remoteDir}/agent.env /opt/gpu-fleet/agent.env; ${privilege}bash -lc 'pkill -f "[n]ode /opt/gpu-fleet/agent.js" || true; set -a; source /opt/gpu-fleet/agent.env; set +a; nohup bash /opt/gpu-fleet/bootstrap.sh >>/var/log/gpu-fleet-bootstrap.log 2>&1 &'`;
  try {
    fs.mkdirSync(transferDir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, "agent", "bootstrap.sh"), path.join(transferDir, "bootstrap.sh"));
    fs.copyFileSync(path.join(__dirname, "agent", "agent.js"), path.join(transferDir, "agent.js"));
    fs.writeFileSync(path.join(transferDir, "agent.env"), envText, { mode: 0o600 });
    fs.writeFileSync(keyFile, openSshPrivateKey(managed.privateKey), {
      mode: 0o600,
    });
    securePrivateKeyFile(keyFile);
    const deadline = Date.now() + 120000,
      sshBaseArgs = [
        "-i",
        keyFile,
        "-p",
        String(managed.port),
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ConnectionAttempts=1",
      ];
    let keyRepaired = false;
    while (true) {
      try {
        await runCommand("ssh", [
          ...sshBaseArgs,
          `${managed.username}@${managed.host}`,
          "true",
        ]);
        break;
      } catch (error) {
        if (
          !keyRepaired &&
          /permission denied \(publickey\)/i.test(error.message)
        ) {
          await repairManagedSshKeyWithProviderPassword(
            providerId,
            id,
            managed.publicKey,
          );
          keyRepaired = true;
          continue;
        }
        const transient =
          /connection (?:closed|reset|refused|timed out)|operation timed out|no route to host|kex_exchange_identification|connection unexpectedly closed/i.test(
            error.message,
          );
        if (!transient || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    // Reaching this point means the same managed key and endpoint used by the
    // user-facing SSH tools have completed a real authenticated handshake.
    // Keep the readiness badge and provisioning copy tied to that fact.
    sshReadiness.set(updateKey, {
      ready: true,
      probing: false,
      checkedAt: Date.now(),
      error: "",
    });
    baseUrlUpdates.set(updateKey, {
      status: "updating",
      phase: "uploading_bootstrap",
      phaseLabel: "正在通过 SSH 上传初始化文件",
      updatedAt: new Date().toISOString(),
    });
    await runCommand("ssh", [
      ...sshBaseArgs,
      `${managed.username}@${managed.host}`,
      `mkdir -p ${remoteDir}`,
    ]);
    await runCommand("scp", [
      "-i", keyFile, "-P", String(managed.port),
      "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
      path.join(transferDir, "bootstrap.sh"),
      path.join(transferDir, "agent.js"),
      path.join(transferDir, "agent.env"),
      `${managed.username}@${managed.host}:${remoteDir}/`,
    ]);
    await runCommand("ssh", [
      ...sshBaseArgs,
      `${managed.username}@${managed.host}`,
      remote,
    ]);
    const key = `${providerId}:${instance.name || "gpu-fleet"}`;
    instanceTelemetryKeys.set(String(id), key);
    telemetryDiagnostics.set(key, {
      state: "waiting",
      message: "遥测凭据已重新注入，等待 Agent 首次上报",
      at: Date.now(),
    });
  } catch (error) {
    baseUrlUpdates.delete(updateKey);
    agentCredentials.revokeAgent(credential.agentId);
    throw error;
  } finally {
    removeTemporaryFile(keyFile);
    fs.rmSync(transferDir, { recursive: true, force: true });
  }
}
const telemetryRecoveryAttempts = new Map();
async function recoverDisconnectedTelemetry({
  force = false,
  includeUnregistered = false,
} = {}) {
  if (telemetryMode !== "named-tunnel" || !process.env.BASE_URL) return;
  for (const [providerId, adapter] of Object.entries(providers)) {
    let listed;
    try {
      listed = await adapter.listInstances();
    } catch {
      continue;
    }
    for (const instance of listed) {
      if (instance.status !== "running") continue;
      const id = String(instance.id),
        credential = agentCredentials.findByInstance(providerId, id);
      if (!credential && !includeUnregistered) continue;
      const key = credential
        ? `${credential.provider}:${credential.instance_name}`
        : `${providerId}:${instance.name || id}`;
      const attemptKey = `${providerId}:${id}`,
        lastPush = pushedTelemetry.get(key)?.at || 0,
        lastAttempt = telemetryRecoveryAttempts.get(attemptKey) || 0;
      if (
        !force &&
        (Date.now() - lastPush < 30000 || Date.now() - lastAttempt < 120000)
      )
        continue;
      telemetryRecoveryAttempts.set(attemptKey, Date.now());
      void reinjectTelemetryAgent(providerId, id, { recoveryOnly: true }).catch((error) => {
        telemetryDiagnostics.set(key, {
          state: "agent_error",
          message: `遥测 Agent 自动恢复失败：${error.message}`,
          component: "Agent 自愈",
          code: error.code || "agent_reinject_failed",
          at: Date.now(),
        });
      });
    }
  }
}
function scheduleBaseUrlSynchronization() {
  // BASE_URL is persisted in each runtime container. Reinject the agent
  // configuration after a switch so no running container keeps the old URL.
  setTimeout(
    () =>
      recoverDisconnectedTelemetry({ force: true, includeUnregistered: true }),
    1000,
  ).unref?.();
}
const telemetryRecoveryTimer = setInterval(() => {
  if (telemetryMode === "named-tunnel") void recoverDisconnectedTelemetry();
}, 30000);
telemetryRecoveryTimer.unref?.();
// Reconcile running instances immediately after a platform restart instead of
// waiting for the first periodic recovery tick.
if (telemetryMode === "named-tunnel")
  setTimeout(
    () => recoverDisconnectedTelemetry({ force: true }),
    1000,
  ).unref?.();
function sshString(value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, data]);
}
function openSshPrivateKey(privateKey) {
  if (String(privateKey).includes("BEGIN OPENSSH PRIVATE KEY"))
    return String(privateKey);
  const jwk = createPrivateKey(privateKey).export({ format: "jwk" });
  const decode = (value) =>
    Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const publicKey = decode(jwk.x),
    seed = decode(jwk.d),
    type = Buffer.from("ssh-ed25519");
  const publicBlob = Buffer.concat([sshString(type), sshString(publicKey)]);
  const check = randomBytes(4);
  let privateBlob = Buffer.concat([
    check,
    check,
    sshString(type),
    sshString(publicKey),
    sshString(Buffer.concat([seed, publicKey])),
    sshString("gpu-fleet-managed"),
  ]);
  const paddingLength = 8 - (privateBlob.length % 8);
  privateBlob = Buffer.concat([
    privateBlob,
    Buffer.from(Array.from({ length: paddingLength }, (_, index) => index + 1)),
  ]);
  const payload = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    sshString("none"),
    sshString("none"),
    sshString(Buffer.alloc(0)),
    Buffer.from([0, 0, 0, 1]),
    sshString(publicBlob),
    sshString(privateBlob),
  ])
    .toString("base64")
    .match(/.{1,70}/g)
    .join("\n");
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${payload}\n-----END OPENSSH PRIVATE KEY-----\n`;
}
const sshTelemetrySource = `import json, subprocess, time
while True:
    runtime={"status":"ready","phase":"ssh_telemetry","phaseLabel":"SSH 长连接遥测"}
    try:
        with open("/var/lib/gpu-fleet/profile.json", encoding="utf-8") as profile:
            runtime=json.load(profile)
    except (OSError, ValueError):
        pass
    run=subprocess.run(["nvidia-smi","--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw","--format=csv,noheader,nounits"],capture_output=True,text=True,timeout=15)
    gpus=[]
    for line in run.stdout.splitlines():
        values=[value.strip() for value in line.split(",")]
        if len(values)!=7:
            continue
        index,name,util,used,total,temperature,power=values
        def number(value):
            try: return float(value) if "." in value else int(value)
            except ValueError: return 0
        gpus.append({"index":int(index),"name":name,"util":number(util),"memoryUsed":number(used),"memoryTotal":number(total),"temperature":number(temperature),"power":number(power)})
    telemetry={"ts":int(time.time()*1000),"gpus":gpus,"runtime":runtime,"transport":"ssh"}
    if run.returncode!=0:
        telemetry["error"]={"component":"nvidia-smi","code":"gpu_telemetry_collection_failed","message":(run.stderr or run.stdout).strip()[-1000:] or "nvidia-smi failed"}
    print(json.dumps(telemetry,separators=(",",":")),flush=True)
    time.sleep(3)
`;
function stopSshTelemetry(key) {
  const session = sshTelemetrySessions.get(key);
  if (!session) return;
  sshTelemetrySessions.delete(key);
  session.stopped = true;
  try {
    session.child?.kill();
  } catch {}
  if (session.keyFile) removeTemporaryFile(session.keyFile);
}
async function startSshTelemetry(providerId, id) {
  const sessionKey = `${providerId}:${id}`;
  if (telemetryMode !== "ssh" || sshTelemetrySessions.has(sessionKey)) return;
  const session = { stopped: false, child: null, keyFile: "" };
  sshTelemetrySessions.set(sessionKey, session);
  const telemetryKey = sessionKey;
  instanceTelemetryKeys.set(String(id), telemetryKey);
  try {
    const managed = await managedSshConnection(providerId, id);
    if (!managed) throw Error("没有托管 SSH 凭据");
    const sshExecutable = executablePath("ssh");
    if (!sshExecutable) throw Error("本机未安装 OpenSSH");
    session.keyFile = path.join(
      os.tmpdir(),
      `gpu-fleet-telemetry-${randomBytes(12).toString("hex")}.pem`,
    );
    fs.writeFileSync(session.keyFile, openSshPrivateKey(managed.privateKey), {
      mode: 0o600,
    });
    securePrivateKeyFile(session.keyFile);
    const encoded = Buffer.from(sshTelemetrySource).toString("base64");
    const remote = `printf '%s' '${encoded}' | base64 -d | python3`;
    const args = [
      "-T",
      "-i",
      session.keyFile,
      "-p",
      String(managed.port),
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ConnectionAttempts=1",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      `${managed.username}@${managed.host}`,
      remote,
    ];
    const child = spawn(sshExecutable, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    session.child = child;
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          pushedTelemetry.set(telemetryKey, { at: Date.now(), data });
          persistTelemetrySeen(providerId, id);
          completeBaseUrlUpdate(providerId, id);
          publishTelemetry(telemetryKey, data);
          telemetryDiagnostics.set(
            telemetryKey,
            data.error?.message
              ? {
                  state: "agent_error",
                  message: data.error.message,
                  component: data.error.component,
                  code: data.error.code,
                  at: Date.now(),
                }
              : { state: "connected", transport: "ssh", at: Date.now() },
          );
        } catch {}
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-2000);
    });
    child.once("error", (error) => {
      stderr = error.message;
    });
    child.once("close", () => {
      if (sshTelemetrySessions.get(sessionKey) === session)
        sshTelemetrySessions.delete(sessionKey);
      if (session.keyFile) removeTemporaryFile(session.keyFile);
      if (session.stopped || telemetryMode !== "ssh") return;
      telemetryDiagnostics.set(telemetryKey, {
        state: "waiting",
        message: `SSH 遥测已断开，正在重连${stderr ? `：${stderr.trim()}` : ""}`,
        component: "SSH 遥测",
        code: "ssh_telemetry_disconnected",
        at: Date.now(),
      });
      setTimeout(() => startSshTelemetry(providerId, id), 5000).unref?.();
    });
  } catch (error) {
    if (sshTelemetrySessions.get(sessionKey) === session)
      sshTelemetrySessions.delete(sessionKey);
    if (session.keyFile) removeTemporaryFile(session.keyFile);
    telemetryDiagnostics.set(telemetryKey, {
      state: "waiting",
      message: `SSH 遥测连接失败：${error.message}`,
      component: "SSH 遥测",
      code: "ssh_telemetry_connect_failed",
      at: Date.now(),
    });
    if (!session.stopped && telemetryMode === "ssh")
      setTimeout(() => startSshTelemetry(providerId, id), 10000).unref?.();
  }
}
function reconcileSshTelemetry(instances) {
  const wanted = new Set();
  if (telemetryMode === "ssh")
    for (const instance of instances) {
      if (instance.status !== "running" && instance.status !== "provisioning")
        continue;
      const key = `${instance.provider}:${instance.id}`;
      wanted.add(key);
      void startSshTelemetry(instance.provider, String(instance.id));
      const lastPush = pushedTelemetry.get(key)?.at || 0,
        lastAttempt = telemetryRecoveryAttempts.get(key) || 0,
        previouslyConnected = Boolean(
          telemetryHistory.get(instance.provider, instance.id)?.lastSeenAt,
        ),
        startupGraceActive =
          previouslyConnected &&
          Date.now() - platformStartedAt < telemetryRecoveryStartupGraceMs;
      if (
        instance.status === "running" &&
        instance.provider !== "hyperstack" &&
        !startupGraceActive &&
        Date.now() - lastPush > 30000 &&
        Date.now() - lastAttempt > 120000
      ) {
        telemetryRecoveryAttempts.set(key, Date.now());
        void reinjectTelemetryAgent(
          instance.provider,
          String(instance.id),
          { recoveryOnly: true },
        ).catch((error) => {
          telemetryDiagnostics.set(key, {
            state: "agent_error",
            message: `SSH 初始化文件注入失败：${error.message}`,
            component: "SSH 初始化",
            code: error.code || "ssh_bootstrap_injection_failed",
            at: Date.now(),
          });
        });
      }
    }
  for (const key of sshTelemetrySessions.keys())
    if (!wanted.has(key)) stopSshTelemetry(key);
}
function provider(name) {
  const p = providers[name];
  if (!p) throw Object.assign(Error("未知供应商"), { status: 400 });
  return p;
}
async function all(method, ...args) {
  const entries = Object.entries(providers),
    result = await Promise.allSettled(
      entries.map(([, p]) => p[method](...args)),
    ),
    data = [],
    errors = [];
  result.forEach((r, i) => {
    const [providerId, p] = entries[i];
    if (r.status === "fulfilled") data.push(...r.value);
    else errors.push({ provider: p.name, providerId, error: r.reason.message });
  });
  return { data, errors };
}
function autoDLEstimatedOffers(items) {
  const usdCny = Number(process.env.USD_CNY_ESTIMATE_RATE) || 7.2,
    normalize = (value) =>
      String(value || "")
        .toLowerCase()
        .replace(/nvidia|geforce|rtx|\s|[-_()]/g, ""),
    gpuModel = (value) => {
      const normalized = normalize(value);
      const aliases = [
        ["rtxpro6000", /(?:rtx)?pro6000/],
        ["4090d", /4090d/],
        ["4080s", /4080(?:super|s)/],
        ["5090", /5090/],
        ["4090", /4090/],
        ["4080", /4080/],
        ["3090", /3090/],
        ["h800", /h800/],
        ["h200", /h200/],
        ["h100", /h100/],
        ["a100", /a100/],
        ["l40s", /l40s/],
        ["l40", /l40/],
        ["l20", /l20/],
        ["a800", /a800/],
        ["v100", /v100/],
      ];
      return aliases.find(([, pattern]) => pattern.test(normalized))?.[0] || normalized;
    },
    median = (values) => {
      const sorted = [...values].sort((a, b) => a - b),
        middle = Math.floor(sorted.length / 2);
      return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
    },
    comparable = items.filter(
      (item) =>
        item.provider !== "autodl" &&
        Number(item.price) > 0 &&
        String(item.priceUnit || "").endsWith("/hour"),
    );
  return items.map((item) => {
    if (item.provider !== "autodl" || Number(item.price) > 0) return item;
    const model = gpuModel(item.gpu || item.productId),
      gpuCount = Number(item.gpuCount) || 1,
      byProvider = new Map();
    for (const candidate of comparable) {
      const candidateModel = gpuModel(candidate.gpu || candidate.productId);
      if (
        candidateModel !== model ||
        (Number(candidate.gpuCount) || 1) !== gpuCount ||
        (item.vram != null &&
          candidate.vram != null &&
          Number(candidate.vram) !== Number(item.vram)) ||
        (item.cpu != null &&
          candidate.cpu != null &&
          Number(candidate.cpu) !== Number(item.cpu)) ||
        (item.ram != null &&
          candidate.ram != null &&
          Number(candidate.ram) !== Number(item.ram))
      )
        continue;
      const currency = String(candidate.priceUnit).split("/")[0],
        cny =
          Number(candidate.price) *
          (currency === "USD" ? usdCny : currency === "CNY" ? 1 : NaN);
      if (Number.isFinite(cny) && cny > 0) {
        const values = byProvider.get(candidate.provider) || [];
        values.push(cny);
        byProvider.set(candidate.provider, values);
      }
    }
    const samples = [...byProvider.values()].map(median);
    if (!samples.length)
      return {
        ...item,
        priceEstimated: false,
        priceEstimateUnavailable: true,
        note: "其他厂商没有同型号、同配置的可比实例，无法预估价格；创建后显示 AutoDL 真实价格",
      };
    const providersUsed = [...byProvider.keys()];
    return {
      ...item,
      price: median(samples),
      priceUnit: "CNY/hour",
      priceSource: "cross-provider-median",
      priceEstimated: true,
      estimateProviders: providersUsed,
      estimateUsdCnyRate: usdCny,
      note: `参考其他厂商同型号 GPU 的中位数估价（${providersUsed.join("、")}）；创建后以 AutoDL 实际价格为准`,
    };
  });
}
async function proxyAgent(id, path) {
  const telemetry = path === "/telemetry";
  const message = telemetry
    ? "平台尚未收到该实例的 GPU 遥测数据。请确认实例已完成初始化，且实例内的 Agent 服务正在运行。"
    : "该实例的 Agent 尚未连接平台，暂时无法执行性能测试。请等待实例初始化完成后重试。";
  throw Object.assign(Error(message), {
    status: 409,
    code: "agent_not_connected",
    instanceId: id,
  });
}
async function proxyAgentViaSsh(id, agentPath, method = "GET") {
  const record = sshStore.list().find((item) => String(item.id) === String(id));
  if (!record)
    throw Object.assign(Error("该实例没有托管 SSH 凭据"), {
      status: 409,
      code: "ssh_credentials_unavailable",
    });
  const managed = await managedSshConnection(record.provider, String(id));
  const credential = agentCredentials.findByInstance(record.provider, String(id));
  const keyFile = path.join(
    os.tmpdir(),
    `gpu-fleet-agent-proxy-${randomBytes(12).toString("hex")}.pem`,
  );
  try {
    fs.writeFileSync(keyFile, openSshPrivateKey(managed.privateKey), {
      mode: 0o600,
    });
    securePrivateKeyFile(keyFile);
    const auth = credential?.secret
      ? ` -H 'authorization: Bearer ${credential.secret}'`
      : "";
    const remote = `curl -fsS -X ${["POST", "DELETE"].includes(method) ? method : "GET"}${auth} http://127.0.0.1:3000${agentPath}`;
    const output = await runCommand(
      "ssh",
      [
        "-T",
        "-i",
        keyFile,
        "-p",
        String(managed.port),
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ConnectionAttempts=1",
        `${managed.username}@${managed.host}`,
        remote,
      ],
      { timeout: 10 * 60 * 1000, killSignal: "SIGKILL" },
    );
    return JSON.parse(output);
  } catch (cause) {
    throw Object.assign(
      Error(`SSH 执行实例 Agent 请求失败：${cause.message}`),
      { status: 502, code: "ssh_agent_request_failed", cause },
    );
  } finally {
    removeTemporaryFile(keyFile);
  }
}
async function runInstanceSshCommand(providerId, id, remote, timeout = 60000) {
  const managed = await managedSshConnection(providerId, id);
  if (!managed)
    throw Object.assign(Error("该实例没有托管 SSH 凭据"), {
      status: 409,
      code: "ssh_credentials_unavailable",
    });
  const keyFile = path.join(
    os.tmpdir(),
    `gpu-fleet-command-${randomBytes(12).toString("hex")}.pem`,
  );
  try {
    fs.writeFileSync(keyFile, openSshPrivateKey(managed.privateKey), { mode: 0o600 });
    securePrivateKeyFile(keyFile);
    return await runCommand(
      "ssh",
      [
        "-T", "-i", keyFile, "-p", String(managed.port),
        "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ConnectTimeout=10", "-o", "ConnectionAttempts=1",
        `${managed.username}@${managed.host}`, remote,
      ],
      { timeout, killSignal: "SIGKILL" },
    );
  } finally {
    removeTemporaryFile(keyFile);
  }
}
setInterval(async () => {
  const cutoff = Date.now() - 20 * 60 * 1000;
  for (const [token, pending] of hyperstackProvisioning)
    if (pending.createdAt < cutoff) {
      hyperstackProvisioning.delete(token);
      try {
        await providers.hyperstack.action(pending.id, "delete");
        instanceRuntime.set(pending.id, {
          status: "failed",
          reason: "自动装机超时，实例已删除",
        });
      } catch (error) {
        console.error(
          "Hyperstack 超时实例自动删除失败",
          pending.id,
          error.message,
        );
      }
    }
}, 60000).unref();
async function api(req, res, url) {
  if (url.pathname === "/api/auth/context" && req.method === "GET")
    return json(res, 200, {
      mode: CLIENT_MODE,
      registrationEnabled: process.env.FLEET_ALLOW_REGISTRATION !== "false",
      user: sessionUser(req),
    });
  if (url.pathname === "/api/auth/register" && req.method === "POST") {
    if (CLIENT_MODE === "local")
      throw Object.assign(Error("本地单用户版不需要注册"), { status: 409 });
    if (process.env.FLEET_ALLOW_REGISTRATION === "false")
      throw Object.assign(Error("当前部署已关闭公开注册"), { status: 403 });
    const result = authStore.register(await body(req));
    res.setHeader("set-cookie", sessionCookie(req, result.session));
    return json(res, 201, { user: result.user });
  }
  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    if (CLIENT_MODE === "local")
      throw Object.assign(Error("本地单用户版不需要登录"), { status: 409 });
    const result = authStore.login(await body(req));
    res.setHeader("set-cookie", sessionCookie(req, result.session));
    return json(res, 200, { user: result.user });
  }
  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    authStore.logout(cookies(req).fleet_session);
    res.setHeader("set-cookie", clearSessionCookie());
    return json(res, 200, { ok: true });
  }
  if (url.pathname === "/api/auth/me" && req.method === "GET")
    return json(res, 200, { user: sessionUser(req), mode: CLIENT_MODE });
  if (req.method === "GET" && url.pathname === "/api/client/capabilities") {
    const local = CLIENT_MODE === "local";
    const rsync = local
        ? resolveTool("rsync")
        : { executable: "", source: "missing" },
      ssh = local ? resolveTool("ssh") : { executable: "", source: "missing" },
      scp = local ? resolveTool("scp") : { executable: "", source: "missing" };
    return json(res, 200, {
      mode: CLIENT_MODE,
      localFilesystem: local,
      rsync: Boolean(rsync.executable),
      rsyncSource: rsync.source,
      ssh: Boolean(ssh.executable),
      sshSource: ssh.source,
      scp: Boolean(scp.executable),
      scpSource: scp.source,
      toolDirectories: {
        system: systemToolsDirectory,
        application: applicationToolsDirectory,
      },
      rclone: local && commandAvailable("rclone"),
      nativeTerminal: local,
      platform: process.platform,
      cliPath: {
        available: local && process.platform === "win32",
        registered: cliPathRegistered(),
        directory: cliDirectory,
        command: "fast-gpu",
      },
    });
  }
  if (req.method === "POST" && url.pathname === "/api/client/path/register") {
    return json(res, 200, registerCliPath());
  }
  if (req.method === "POST" && url.pathname === "/api/client/rsync/install") {
    if (CLIENT_MODE !== "local")
      throw Object.assign(Error("本地工具只能安装到 Fast GPU 本地客户端"), {
        status: 409,
      });
    const d = await body(req),
      scope = d.scope || "application",
      executable = await installTool("rsync", scope);
    return json(res, 201, { ok: true, source: scope, executable });
  }
  if (req.method === "POST" && url.pathname === "/api/client/ssh/install") {
    if (CLIENT_MODE !== "local")
      throw Object.assign(Error("本地工具只能安装到 Fast GPU 本地客户端"), {
        status: 409,
      });
    const d = await body(req),
      scope = d.scope || "application",
      executable = await installTool("ssh", scope);
    process.env.PATH = [path.dirname(executable), process.env.PATH || ""]
      .filter(Boolean)
      .join(path.delimiter);
    const scp = resolveTool("scp");
    if (!scp.executable)
      throw Object.assign(Error("OpenSSH 已安装，但未找到随附的 scp 客户端"), {
        status: 502,
      });
    return json(res, 201, {
      ok: true,
      source: scope,
      executable,
      scpExecutable: scp.executable,
    });
  }
  if (
    req.method === "GET" &&
    url.pathname === "/api/client/cloudflare/status"
  )
    return json(res, 200, cloudflareStatus());
  if (
    req.method === "POST" &&
    url.pathname === "/api/client/cloudflare/install"
  ) {
    if (CLIENT_MODE !== "local")
      throw Object.assign(Error("cloudflared 只能由本地客户端安装"), {
        status: 409,
      });
    const d = await body(req),
      scope = d.scope || "application",
      executable = await installTool("cloudflared", scope);
    return json(res, 201, {
      ok: true,
      source: scope,
      executable,
      cloudflare: cloudflareStatus(),
    });
  }
  if (
    req.method === "POST" &&
    url.pathname === "/api/client/cloudflare/login"
  ) {
    if (CLIENT_MODE !== "local")
      throw Object.assign(Error("Cloudflare 登录只能由本地客户端发起"), {
        status: 409,
      });
    return json(res, 202, startCloudflareLogin());
  }
  if (
    req.method === "POST" &&
    (url.pathname === "/api/agent/telemetry" ||
      url.pathname === "/api/agent/job-result")
  ) {
    const authorization = req.headers.authorization || "";
    const secret = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    req.agentCredential = agentCredentials.authenticate(
      req.headers["x-fleet-agent-id"],
      secret,
    );
    if (!req.agentCredential)
      throw Object.assign(Error("unauthorized"), { status: 401 });
    const d = await body(req),
      key = `${req.agentCredential.provider}:${req.agentCredential.instance_name}`;
    if (
      req.agentCredential.provider_instance_id &&
      telemetryMode === "named-tunnel"
    )
      instanceTelemetryKeys.set(
        String(req.agentCredential.provider_instance_id),
        key,
      );
    if (url.pathname === "/api/agent/telemetry") {
      if (req.agentCredential.provider_instance_id)
        completeBaseUrlUpdate(
          req.agentCredential.provider,
          req.agentCredential.provider_instance_id,
        );
      if (!Array.isArray(d.telemetry?.gpus)) {
        telemetryDiagnostics.set(key, {
          state: "invalid_payload",
          message: "Agent 上报的数据格式不正确",
          at: Date.now(),
        });
        throw Object.assign(Error("遥测数据格式错误"), { status: 400 });
      }
      if (d.telemetry.runtime?.phase === "starting")
        d.telemetry.runtime = {
          ...d.telemetry.runtime,
          status: "ready",
          phase: "telemetry_ready",
          phaseLabel: "GPU 遥测已连接",
        };
      if (d.telemetry.runtime?.status === "ready") telemetryReadyKeys.add(key);
      else if (
        d.telemetry.runtime?.status === "failed" &&
        telemetryReadyKeys.has(key)
      ) {
        const previous = pushedTelemetry.get(key)?.data?.runtime;
        d.telemetry.runtime =
          previous?.status === "ready"
            ? previous
            : {
                status: "ready",
                phase: "telemetry_ready",
                phaseLabel: "GPU 遥测已连接",
              };
      }
      if (!d.telemetry.error?.message && d.telemetry.gpus.length === 0)
        d.telemetry.error = {
          component: "GPU 采集",
          code: "no_gpu_data",
          message:
            "Agent 已连接平台，但没有采集到任何 GPU 数据。通常是 nvidia-smi 执行失败、NVIDIA 驱动未加载，或容器未挂载 GPU。",
        };
      pushedTelemetry.set(key, { at: Date.now(), data: d.telemetry });
      persistTelemetrySeen(
        req.agentCredential.provider,
        req.agentCredential.provider_instance_id,
      );
      publishTelemetry(key, d.telemetry);
      telemetryDiagnostics.set(
        key,
        d.telemetry.error?.message
          ? {
              state: "agent_error",
              message: String(d.telemetry.error.message),
              component: String(d.telemetry.error.component || "Agent"),
              code: String(d.telemetry.error.code || "agent_error"),
              at: Date.now(),
            }
          : { state: "connected", at: Date.now() },
      );
      const canRunJobs =
          Array.isArray(d.capabilities) &&
          d.capabilities.includes("agent_jobs"),
        job = canRunJobs
          ? [...benchmarkJobs.values()].find(
              (x) => x.instanceKey === key && x.status === "queued",
            )
          : null;
      if (job) {
        job.status = "running";
        job.startedAt = Date.now();
      }
      return json(res, 202, {
        ok: true,
        job: job ? { id: job.id, type: job.type, params: job.params } : null,
      });
    }
    const job = benchmarkJobs.get(String(d.jobId));
    if (!job)
      throw Object.assign(Error("agent job not found"), { status: 404 });
    if (job.instanceKey !== key)
      throw Object.assign(Error("agent job instance mismatch"), {
        status: 403,
      });
    job.status = d.status === "completed" ? "completed" : "failed";
    job.completedAt = Date.now();
    job.report = d.result || null;
    job.error = d.error || null;
    return json(res, 202, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/api/config/status") {
    const base = process.env.BASE_URL,
      baseIssue = base ? publicControlPlaneError(base) : null;
    return json(res, 200, {
      clientMode: CLIENT_MODE,
      deploymentMode: process.env.FLEET_DEPLOYMENT_MODE || "server",
      controlPlaneSource: baseUrlSource,
      telemetryMode,
      canConfigureControlPlane:
        CLIENT_MODE === "local" &&
        process.env.FLEET_DEPLOYMENT_MODE === "all-in-one" &&
        baseUrlSource !== "environment",
      controlPlaneIssue: baseIssue,
      providers: Object.entries(providers).map(([id, p]) => {
        const saved = providerKeyStore.status(id),
          tailscaleAuthKeyExpiresAt =
            id === "hyperstack"
              ? providerKeyStore.get("__tailscale_auth_key_expires_at__") || ""
              : "",
          tailscaleExpiryTime = tailscaleAuthKeyExpiresAt
            ? Date.parse(`${tailscaleAuthKeyExpiresAt}T23:59:59Z`)
            : NaN,
          tailscaleAuthKeyDaysRemaining = Number.isFinite(tailscaleExpiryTime)
            ? Math.ceil((tailscaleExpiryTime - Date.now()) / 86400000)
            : null,
          tailscaleAuthKeyStatus =
            tailscaleAuthKeyDaysRemaining == null
              ? "unknown"
              : tailscaleAuthKeyDaysRemaining < 0
                ? "expired"
                : tailscaleAuthKeyDaysRemaining <= 7
                  ? "expiring"
                  : "valid";
        return {
          id,
          name: p.name,
          configured: Boolean(p.token),
          keyCount: saved.keyCount,
          keys: saved.keys,
          keySuffix: saved.keySuffix,
          keyUrl: providerDefinitions[id]?.keyUrl,
          provisioningReady: validateProvisioning(id, process.env).length === 0,
          missing: validateProvisioning(id, process.env),
          hyperstackConfig:
            id === "hyperstack"
              ? {
                  environment: process.env.HYPERSTACK_ENVIRONMENT || "",
                  keyName: process.env.HYPERSTACK_KEY_NAME || "",
                  imageName: process.env.HYPERSTACK_IMAGE_NAME || "",
                  agentCidr: process.env.HYPERSTACK_AGENT_CIDR || "",
                  imageUser: process.env.HYPERSTACK_IMAGE_USER || "",
                  tailscaleAuthKeyConfigured: Boolean(
                    process.env.TAILSCALE_AUTH_KEY,
                  ),
                  tailscaleAuthKeyExpiresAt,
                  tailscaleAuthKeyDaysRemaining,
                  tailscaleAuthKeyStatus,
                }
              : undefined,
        };
      }),
      runtime: {
        image: resolveCuda13Image(process.env),
        os: "Ubuntu 24.04",
        cuda: "13.2",
      },
      controlPlane:
        base && !baseIssue
          ? {
              baseUrl: new URL("/", base).href,
              bootstrap: new URL("/provision/bootstrap.sh", base).href,
              telemetry: new URL("/api/agent/telemetry", base).href,
              telemetryAgent: new URL("/provision/telemetry.py", base).href,
            }
          : null,
    });
  }
  if (req.method === "GET" && url.pathname === "/api/account/context")
    return json(res, 200, {
      ...billingStore.defaults,
      providerAccounts: billingStore.listAccounts(),
    });
  if (req.method === "GET" && url.pathname === "/api/billing/ledger")
    return json(res, 200, {
      instances: billingStore.listInstances(),
      reconciliations: billingStore.listReconciliations(),
    });
  if (req.method === "POST" && url.pathname === "/api/billing/reconciliations")
    return json(res, 201, billingStore.importReconciliation(await body(req)));
  if (req.method === "PUT" && url.pathname === "/api/config/control-plane") {
    if (
      CLIENT_MODE !== "local" ||
      process.env.FLEET_DEPLOYMENT_MODE !== "all-in-one"
    )
      throw Object.assign(
        Error(
          "后端未配置 BASE_URL；当前不是一体化客户端，请在服务端环境变量中设置",
        ),
        { status: 409, code: "server_configuration_required" },
      );
    if (baseUrlSource === "environment")
      throw Object.assign(
        Error("BASE_URL 当前由环境变量管理，请在启动环境中修改并重启"),
        { status: 409, code: "environment_configuration_readonly" },
      );
    const d = await body(req),
      nextMode = d.telemetryMode === "named-tunnel" ? "named-tunnel" : "ssh",
      requestedBaseUrl = String(d.baseUrl || "")
        .trim()
        .replace(/\/+$/, ""),
      baseUrl =
        nextMode === "ssh"
          ? String(process.env.BASE_URL || requestedBaseUrl)
              .trim()
              .replace(/\/+$/, "")
          : requestedBaseUrl,
      issue = baseUrl ? publicControlPlaneError(baseUrl) : null;
    if (nextMode === "named-tunnel" && !baseUrl)
      throw Object.assign(Error("Named Tunnel 模式必须填写固定公网 URL"), {
        status: 400,
        code: "base_url_required",
      });
    if (issue)
      throw Object.assign(Error(`BASE_URL ${issue}`), {
        status: 400,
        code: "invalid_base_url",
      });
    let tunnelVerification = null;
    if (nextMode === "named-tunnel")
      tunnelVerification = await configureNamedTunnel(baseUrl);
    const previousUrl = process.env.BASE_URL || "",
      previousMode = telemetryMode;
    applyBaseUrl(baseUrl);
    telemetryMode = nextMode;
    process.env.FLEET_TELEMETRY_MODE = telemetryMode;
    baseUrlSource = "saved";
    savedControlPlaneSettings = { baseUrl, telemetryMode };
    providerKeyStore.set(
      "__control_plane_config__",
      JSON.stringify(savedControlPlaneSettings),
    );
    if (telemetryMode === "ssh") {
      for (const key of [...sshTelemetrySessions.keys()]) stopSshTelemetry(key);
    } else {
      for (const key of [...sshTelemetrySessions.keys()]) stopSshTelemetry(key);
      if (previousUrl !== baseUrl || previousMode !== telemetryMode)
        scheduleBaseUrlSynchronization();
    }
    return json(res, 200, {
      configured: true,
      telemetryMode,
      baseUrl: process.env.PUBLIC_BASE_URL || "",
      synchronizingRunningInstances:
        telemetryMode === "named-tunnel" &&
        (previousUrl !== baseUrl || previousMode !== telemetryMode),
      tunnelVerified: telemetryMode === "named-tunnel",
      tunnel: tunnelVerification,
    });
  }
  if (req.method === "GET" && url.pathname === "/api/storage/providers") {
    let persistedVerification = {};
    try {
      persistedVerification = storedStorageConfig()?.verification || {};
    } catch (error) {
      console.error("读取对象存储测试结果失败", error.message);
    }
    const providers = Object.fromEntries(
      Object.entries(STORAGE_ENV_KEYS).map(([provider, keys]) => [
        provider,
        {
          enabled: process.env[keys.enabled] === "1",
          configured: Boolean(
            process.env[keys.endpoint] &&
            process.env[keys.bucket] &&
            process.env[keys.accessKeyId] &&
            process.env[keys.secretAccessKey],
          ),
          endpoint: process.env[keys.endpoint] || "",
          bucket: process.env[keys.bucket] || "",
          prefix: process.env[keys.prefix] || "",
          region: process.env[keys.region] || "",
          accessKeyId: process.env[keys.accessKeyId] || "",
          secretAccessKey: process.env[keys.secretAccessKey] || "",
          accessKeySuffix: process.env[keys.accessKeyId]?.slice(-4) || "",
          verification: persistedVerification[provider] || null,
        },
      ]),
    );
    return json(res, 200, {
      primaryProvider: process.env.STORAGE_PRIMARY_PROVIDER || "r2",
      providers,
      configured: Object.values(providers).some((item) => item.configured),
    });
  }
  if (req.method === "PUT" && url.pathname === "/api/storage/providers") {
    const d = await body(req),
      primaryProvider = String(d.primaryProvider || "r2");
    if (!STORAGE_ENV_KEYS[primaryProvider])
      throw Object.assign(Error("主存储供应商无效"), { status: 400 });
    const providers = {};
    for (const [provider, keys] of Object.entries(STORAGE_ENV_KEYS)) {
      const input = d.providers?.[provider] || {},
        enabled = Boolean(input.enabled);
      providers[provider] = {
        enabled,
        endpoint: String(input.endpoint || "").trim(),
        bucket: String(input.bucket || "").trim(),
        prefix: String(input.prefix || "")
          .trim()
          .replace(/^\/+|\/+$/g, ""),
        region: String(input.region || "").trim(),
        accessKeyId: String(
          input.accessKeyId || process.env[keys.accessKeyId] || "",
        ).trim(),
        secretAccessKey: String(
          input.secretAccessKey || process.env[keys.secretAccessKey] || "",
        ).trim(),
      };
      const values = providers[provider];
      const hasConfiguration = Boolean(
        values.endpoint ||
          values.bucket ||
          values.accessKeyId ||
          values.secretAccessKey,
      );
      if (hasConfiguration && !/^https?:\/\//.test(values.endpoint))
        throw Object.assign(
          Error(`${provider.toUpperCase()} Endpoint 必须是 http(s) URL`),
          { status: 400 },
        );
      if (
        hasConfiguration &&
        (!values.bucket || !values.accessKeyId || !values.secretAccessKey)
      )
        throw Object.assign(
          Error(
            `${provider.toUpperCase()} 的 Bucket、Access Key 和 Secret Key 必填`,
          ),
          { status: 400 },
        );
    }
    const verification = {};
    for (const [provider, values] of Object.entries(providers)) {
      const configured = Boolean(
        values.endpoint &&
          values.bucket &&
          values.accessKeyId &&
          values.secretAccessKey,
      );
      verification[provider] = configured
        ? await objectStorage.probeAccess({ provider, ...values })
        : null;
    }
    const config = { primaryProvider, providers, verification };
    providerKeyStore.set("__object_storage_config__", JSON.stringify(config));
    applyStorageConfig(config);
    return json(res, 200, { configured: true, primaryProvider, verification });
  }
  const uploadCreate = req.method === "POST" && url.pathname === "/api/storage/uploads";
  if (uploadCreate) {
    const d = await body(req),
      providerId = String(d.provider || process.env.STORAGE_PRIMARY_PROVIDER || "r2"),
      config = storageProviderConfig(providerId);
    if (!config)
      throw Object.assign(Error("所选对象存储未启用或配置不完整"), {
        status: 409,
        code: "storage_not_configured",
      });
    const localPath = String(d.localPath || "").trim();
    if (localPath && CLIENT_MODE !== "local")
      throw Object.assign(Error("持久化本地文件上传仅支持桌面客户端"), {
        status: 409,
        code: "local_upload_requires_desktop",
      });
    let localFile = null;
    if (localPath) {
      if (!path.isAbsolute(localPath))
        throw Object.assign(Error("本地文件路径必须是绝对路径"), { status: 400 });
      try {
        localFile = fs.statSync(localPath);
      } catch {
        throw Object.assign(Error("本地文件不存在或无法读取"), {
          status: 404,
          code: "local_file_missing",
        });
      }
      if (!localFile.isFile())
        throw Object.assign(Error("所选路径不是文件"), { status: 400 });
    }
    const fileSize = localFile?.size ?? Number(d.fileSize);
    if (!Number.isFinite(fileSize) || fileSize <= 0)
      throw Object.assign(Error("文件大小无效"), { status: 400, code: "invalid_file_size" });
    const key = resolveDestinationKey(config.prefix, d.key),
      uploadId = String(d.uploadId || ""),
      partSize = objectStorage.choosePartSize(fileSize),
      partCount = Math.ceil(fileSize / partSize);
    // Resume path: reconcile against the authoritative state on the bucket.
    if (uploadId && /^[a-zA-Z0-9._-]+$/.test(uploadId)) {
      const client = objectStorage.createClient(config);
      let existing = [];
      try {
        existing = await objectStorage.listParts(client, config.bucket, key, uploadId);
      } catch (error) {
        // Upload gone (completed/aborted/expired): start a fresh one below.
        throw Object.assign(Error("该上传已失效，请重新开始"), {
          status: 410,
          code: "upload_not_found",
        });
      }
      return json(res, 200, {
        provider: providerId,
        bucket: config.bucket,
        key,
        uploadId,
        partSize,
        partCount,
        uploadedParts: existing,
      });
    }
    const client = objectStorage.createClient(config),
      newUploadId = await objectStorage.beginMultipart(
        client,
        config.bucket,
        key,
        String(d.contentType || "application/octet-stream"),
      );
    activeUploads.set(newUploadId, {
      provider: providerId,
      bucket: config.bucket,
      key,
      fileSize,
      partSize,
      localPath: localPath || "",
      fileName: localPath ? path.basename(localPath) : String(d.fileName || ""),
      createdAt: new Date().toISOString(),
    });
    persistActiveUploads();
    return json(res, 200, {
      provider: providerId,
      bucket: config.bucket,
      key,
      uploadId: newUploadId,
      partSize,
      partCount,
      uploadedParts: [],
    });
  }
  const uploadRun = url.pathname.match(
    /^\/api\/storage\/uploads\/([a-zA-Z0-9._-]+)\/run$/,
  );
  if (req.method === "POST" && uploadRun) {
    const uploadId = uploadRun[1],
      record = activeUploads.get(uploadId);
    if (!record)
      throw Object.assign(Error("上传任务不存在"), {
        status: 404,
        code: "upload_not_found",
      });
    if (!record.localPath || !fs.existsSync(record.localPath))
      throw Object.assign(Error("本地文件已不存在，刷新页面后将清理该任务"), {
        status: 410,
        code: "local_file_missing",
      });
    const config = storageProviderConfig(record.provider);
    if (!config)
      throw Object.assign(Error("所选对象存储未启用或配置不完整"), {
        status: 409,
        code: "storage_not_configured",
      });
    if (activeUploadRuns.has(uploadId))
      throw Object.assign(Error("该任务正在上传"), {
        status: 409,
        code: "upload_already_running",
      });
    const controller = new AbortController();
    activeUploadRuns.set(uploadId, controller);
    try {
    const client = objectStorage.createClient(config),
      uploaded = await objectStorage.listParts(
        client,
        config.bucket,
        record.key,
        uploadId,
      ),
      uploadedNumbers = new Set(uploaded.map((part) => part.partNumber)),
      partCount = Math.ceil(record.fileSize / record.partSize);
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      if (uploadedNumbers.has(partNumber)) continue;
      const start = (partNumber - 1) * record.partSize,
        end = Math.min(record.fileSize, start + record.partSize) - 1,
        stream = fs.createReadStream(record.localPath, { start, end });
      await objectStorage.uploadPart(
        client,
        config.bucket,
        record.key,
        uploadId,
        partNumber,
        stream,
        end - start + 1,
        controller.signal,
      );
    }
    const parts = await objectStorage.listParts(
        client,
        config.bucket,
        record.key,
        uploadId,
      ),
      location = await objectStorage.completeMultipart(
        client,
        config.bucket,
        record.key,
        uploadId,
        parts,
      );
    activeUploads.delete(uploadId);
    persistActiveUploads();
    return json(res, 200, {
      ok: true,
      provider: record.provider,
      bucket: config.bucket,
      key: record.key,
      location,
    });
    } finally {
      activeUploadRuns.delete(uploadId);
    }
  }
  const uploadPartRoute = url.pathname.match(
    /^\/api\/storage\/uploads\/([a-zA-Z0-9._-]+)\/parts\/(\d+)$/,
  );
  if (req.method === "PUT" && uploadPartRoute) {
    const uploadId = uploadPartRoute[1],
      partNumber = Number(uploadPartRoute[2]),
      record = activeUploads.get(uploadId),
      providerId = String(record?.provider || process.env.STORAGE_PRIMARY_PROVIDER || "r2"),
      key = String(url.searchParams.get("key") || record?.key || ""),
      config = storageProviderConfig(providerId);
    if (!config)
      throw Object.assign(Error("所选对象存储未启用或配置不完整"), {
        status: 409,
        code: "storage_not_configured",
      });
    if (!partNumber || partNumber < 1 || partNumber > 10000)
      throw Object.assign(Error("分片编号无效"), { status: 400 });
    const client = objectStorage.createClient(config),
      length = Number(req.headers["content-length"] || 0);
    // The request body is streamed straight into UploadPart: browser chunk ->
    // platform -> bucket, no temp file and bounded memory (~one part in flight).
    const etag = await objectStorage.uploadPart(
      client,
      config.bucket,
      key,
      uploadId,
      partNumber,
      req,
      length,
    );
    return json(res, 200, { partNumber, etag });
  }
  const uploadComplete = url.pathname.match(
    /^\/api\/storage\/uploads\/([a-zA-Z0-9._-]+)\/complete$/,
  );
  if (req.method === "POST" && uploadComplete) {
    const uploadId = uploadComplete[1],
      d = await body(req),
      record = activeUploads.get(uploadId),
      providerId = String(d.provider || record?.provider || process.env.STORAGE_PRIMARY_PROVIDER || "r2"),
      key = String(d.key || record?.key || ""),
      config = storageProviderConfig(providerId);
    if (!config)
      throw Object.assign(Error("所选对象存储未启用或配置不完整"), {
        status: 409,
        code: "storage_not_configured",
      });
    const client = objectStorage.createClient(config),
      parts = await objectStorage.listParts(client, config.bucket, key, uploadId);
    if (!parts.length)
      throw Object.assign(Error("没有已上传的分片可完成"), {
        status: 400,
        code: "no_parts",
      });
    const location = await objectStorage.completeMultipart(
      client,
      config.bucket,
      key,
      uploadId,
      parts,
    );
    activeUploads.delete(uploadId);
    persistActiveUploads();
    return json(res, 200, { ok: true, key, bucket: config.bucket, location });
  }
  const uploadAbort = url.pathname.match(
    /^\/api\/storage\/uploads\/([a-zA-Z0-9._-]+)$/,
  );
  if (req.method === "DELETE" && uploadAbort) {
    const uploadId = uploadAbort[1],
      d = await body(req).catch(() => ({})),
      record = activeUploads.get(uploadId),
      providerId = String(d.provider || record?.provider || process.env.STORAGE_PRIMARY_PROVIDER || "r2"),
      key = String(d.key || record?.key || ""),
      config = storageProviderConfig(providerId, false);
    if (!record)
      throw Object.assign(Error("上传任务不存在"), {
        status: 404,
        code: "upload_not_found",
      });
    if (!config)
      throw Object.assign(Error("缺少对应 S3 凭据，上传记录已保留"), {
        status: 409,
        code: "storage_cleanup_not_configured",
      });
    activeUploadRuns.get(uploadId)?.abort();
    try {
      await objectStorage.abortMultipart(
        objectStorage.createClient(config),
        config.bucket,
        key,
        uploadId,
      );
    } catch (error) {
      if (
        error?.$metadata?.httpStatusCode !== 404 &&
        error?.name !== "NoSuchUpload"
      )
        throw Object.assign(
          Error(`S3 分片清理失败，上传记录已保留：${error.message}`),
          { status: 502, code: "storage_abort_failed" },
        );
    }
    activeUploads.delete(uploadId);
    persistActiveUploads();
    return json(res, 200, { ok: true, aborted: uploadId });
  }
  if (req.method === "GET" && url.pathname === "/api/storage/uploads") {
    const removed = [];
    for (const [uploadId, record] of [...activeUploads]) {
      if (!record.localPath || fs.existsSync(record.localPath)) continue;
      const config = storageProviderConfig(record.provider, false);
      if (config) {
        try {
          await objectStorage.abortMultipart(
            objectStorage.createClient(config),
            config.bucket,
            record.key,
            uploadId,
          );
        } catch {}
      }
      activeUploads.delete(uploadId);
      removed.push({ uploadId, localPath: record.localPath });
    }
    if (removed.length) persistActiveUploads();
    return json(res, 200, {
      uploads: [...activeUploads.entries()].map(([uploadId, record]) => ({
        uploadId,
        ...record,
      })),
      removed,
    });
  }
  const storageApply = url.pathname.match(
    /^\/api\/instances\/([^/]+)\/object-storage$/,
  );
  if ((req.method === "GET" || req.method === "DELETE") && storageApply) {
    const id = decodeURIComponent(storageApply[1]),
      providerId = String(url.searchParams.get("instanceProvider") || ""),
      target = String(url.searchParams.get("target") || "").trim(),
      quote = (value) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;
    if (target && (!/^\/[a-zA-Z0-9._/-]+$/.test(target) || target.includes("..")))
      throw Object.assign(Error("挂载目录无效"), { status: 400 });
    if (req.method === "GET") {
      const output = await runInstanceSshCommand(
        providerId,
        id,
        "state=/opt/gpu-fleet/storage/state.json; if test -f \"$state\"; then cat \"$state\"; else printf '{}'; fi",
      );
      const state = JSON.parse(output || "{}");
      if (state.target) {
        const mounted = await runInstanceSshCommand(
          providerId,
          id,
          `mountpoint -q ${quote(state.target)} && echo yes || echo no`,
        );
        state.mounted = mounted.trim() === "yes";
      }
      return json(res, 200, state);
    }
    const stateOutput = await runInstanceSshCommand(
      providerId,
      id,
      "test -f /opt/gpu-fleet/storage/state.json && cat /opt/gpu-fleet/storage/state.json || printf '{}'",
    );
    const state = JSON.parse(stateOutput || "{}"),
      mountTarget = target || state.target;
    if (mountTarget)
      await runInstanceSshCommand(
        providerId,
        id,
        `if mountpoint -q ${quote(mountTarget)}; then (command -v fusermount3 >/dev/null && fusermount3 -u ${quote(mountTarget)}) || (command -v fusermount >/dev/null && fusermount -u ${quote(mountTarget)}) || umount ${quote(mountTarget)}; fi; rm -f /opt/gpu-fleet/storage/state.json; echo disconnected`,
      );
    return json(res, 200, { ok: true, disconnected: Boolean(mountTarget) });
  }
  if (req.method === "POST" && storageApply) {
    const id = decodeURIComponent(storageApply[1]),
      d = await body(req),
      providerId = String(d.provider || process.env.STORAGE_PRIMARY_PROVIDER || "r2"),
      keys = STORAGE_ENV_KEYS[providerId];
    if (!keys || process.env[keys.enabled] !== "1")
      throw Object.assign(Error("所选对象存储尚未启用"), { status: 409 });
    const managed = await managedSshConnection(String(d.instanceProvider || ""), id);
    if (!managed)
      throw Object.assign(Error("该实例没有托管 SSH 凭据，无法应用对象存储"), {
        status: 409,
        code: "ssh_credentials_unavailable",
      });
    const values = Object.fromEntries(
        Object.entries(keys).map(([field, key]) => [field, process.env[key] || ""]),
      ),
      prefix = String(d.prefix ?? values.prefix).trim().replace(/^\/+|\/+$/g, ""),
      target = String(d.target || (d.mode === "mount" ? `/data/object-storage/${providerId}` : "/data/datasets")).trim(),
      mode = d.mode === "mount" ? "mount" : "copy";
    if (!values.endpoint || !values.bucket || !values.accessKeyId || !values.secretAccessKey)
      throw Object.assign(Error("所选对象存储配置不完整"), { status: 409 });
    if (!/^\/[a-zA-Z0-9._/-]+$/.test(target) || target.includes(".."))
      throw Object.assign(Error("目标目录必须是安全的绝对路径"), { status: 400 });
    if (!/^[a-zA-Z0-9!_.*'()/-]*$/.test(prefix) || prefix.includes(".."))
      throw Object.assign(Error("Prefix 包含不支持的字符"), { status: 400 });
    for (const value of Object.values(values))
      if (/[\r\n]/.test(String(value)))
        throw Object.assign(Error("对象存储配置包含非法换行"), { status: 400 });
    const config = [
        `[${providerId}]`,
        "type = s3",
        `provider = ${providerId === "r2" ? "Cloudflare" : "Alibaba"}`,
        `access_key_id = ${values.accessKeyId}`,
        `secret_access_key = ${values.secretAccessKey}`,
        `endpoint = ${values.endpoint}`,
        `region = ${values.region || (providerId === "r2" ? "auto" : "")}`,
        "no_check_bucket = true",
        "",
      ].join("\n"),
      encodedConfig = Buffer.from(config).toString("base64"),
      quote = (value) => `'${String(value).replaceAll("'", "'\"'\"'")}'`,
      source = `${providerId}:${values.bucket}${prefix ? `/${prefix}` : ""}`,
      configPath = "/opt/gpu-fleet/storage/rclone.conf",
      state = Buffer.from(JSON.stringify({ mode, provider: providerId, source, target, updatedAt: new Date().toISOString() })).toString("base64"),
      prepare = `set -Eeuo pipefail; command -v rclone >/dev/null || { echo '实例未安装 rclone'; exit 12; }; mkdir -p ${quote(path.posix.dirname(configPath))} ${quote(target)}; printf %s ${quote(encodedConfig)} | base64 -d > ${quote(configPath)}; chmod 600 ${quote(configPath)}; `;
    const remote =
      mode === "mount"
        ? prepare +
          `test -e /dev/fuse || { echo '该实例未开放 /dev/fuse，不能进行 FUSE 挂载，请使用选择性同步'; exit 13; }; ` +
          `mountpoint -q ${quote(target)} || { nohup rclone mount --config ${quote(configPath)} --read-only --vfs-cache-mode minimal ${quote(source)} ${quote(target)} > /opt/gpu-fleet/storage/mount.log 2>&1 & sleep 2; mountpoint -q ${quote(target)} || { cat /opt/gpu-fleet/storage/mount.log; exit 14; }; }; printf %s ${quote(state)} | base64 -d > /opt/gpu-fleet/storage/state.json; echo ${quote(`已只读挂载到 ${target}`)}`
        : prepare +
          `rclone copy --config ${quote(configPath)} --checksum --transfers 16 --stats-one-line ${quote(source)} ${quote(target)}; printf %s ${quote(state)} | base64 -d > /opt/gpu-fleet/storage/state.json; echo ${quote(`已同步到 ${target}`)}`;
    const token = randomBytes(12).toString("hex"),
      keyFile = path.join(os.tmpdir(), `gpu-fleet-storage-${token}.pem`);
    try {
      fs.writeFileSync(keyFile, openSshPrivateKey(managed.privateKey), { mode: 0o600 });
      securePrivateKeyFile(keyFile);
      const output = await runCommand(
        "ssh",
        [
          "-T", "-i", keyFile, "-p", String(managed.port),
          "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
          "-o", "ConnectTimeout=10", "-o", "ConnectionAttempts=1",
          `${managed.username}@${managed.host}`, remote,
        ],
        { timeout: mode === "mount" ? 60000 : 30 * 60 * 1000, killSignal: "SIGKILL" },
      );
      return json(res, 200, { ok: true, mode, provider: providerId, source, target, output: output.trim() });
    } finally {
      removeTemporaryFile(keyFile);
    }
  }
  const keyMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/api-key$/);
  if (keyMatch && req.method === "PUT") {
    const id = keyMatch[1],
      definition = providerDefinitions[id],
      adapter = providers[id];
    if (!definition || !adapter)
      throw Object.assign(Error("未知供应商"), { status: 404 });
    const d = await body(req),
      status = providerKeyStore.add(id, d.apiKey, d.label);
    billingStore.bindProviderCredential(id, status.id);
    process.env[definition.env] = String(d.apiKey).trim();
    adapter.token = process.env[definition.env];
    adapter.env[definition.env] = process.env[definition.env];
    return json(res, 200, { ...status, name: adapter.name });
  }
  const balanceMatch = url.pathname.match(
    /^\/api\/providers\/([^/]+)\/balance$/,
  );
  if (balanceMatch && req.method === "GET") {
    const id = decodeURIComponent(balanceMatch[1]),
      adapter = providers[id];
    if (!adapter) throw Object.assign(Error("未知供应商"), { status: 404 });
    if (!adapter.token)
      throw Object.assign(Error("请先配置 API Key"), {
        status: 409,
        code: "provider_not_configured",
      });
    if (typeof adapter.accountBalance !== "function")
      return json(res, 200, {
        supported: false,
        message: "供应商未开放可供 API Key 调用的余额接口",
      });
    return json(res, 200, {
      supported: true,
      ...(await adapter.accountBalance()),
    });
  }
  const keyDeleteMatch = url.pathname.match(
    /^\/api\/providers\/([^/]+)\/api-keys\/([^/]+)$/,
  );
  if (keyDeleteMatch && req.method === "DELETE") {
    const id = decodeURIComponent(keyDeleteMatch[1]),
      keyId = decodeURIComponent(keyDeleteMatch[2]),
      definition = providerDefinitions[id],
      adapter = providers[id];
    if (!definition || !adapter)
      throw Object.assign(Error("未知供应商"), { status: 404 });
    if (!providerKeyStore.removeKey(id, keyId))
      throw Object.assign(Error("API Key 不存在"), { status: 404 });
    const active = providerKeyStore.get(id);
    if (active) process.env[definition.env] = active;
    else delete process.env[definition.env];
    adapter.token = active || "";
    if (active) adapter.env[definition.env] = active;
    else delete adapter.env[definition.env];
    return json(res, 200, { removed: true, ...providerKeyStore.status(id) });
  }
  const providerKeyExport = url.pathname.match(
    /^\/api\/providers\/([^/]+)\/api-keys\/([^/]+)\/export$/,
  );
  if (providerKeyExport && req.method === "POST") {
    const providerId = decodeURIComponent(providerKeyExport[1]),
      keyId = decodeURIComponent(providerKeyExport[2]),
      d = await body(req),
      secret = providerKeyStore.getKey(providerId, keyId);
    if (!secret)
      throw Object.assign(Error("API Key 不存在或无权下载"), { status: 404 });
    return json(
      res,
      200,
      encryptedDownload(
        secret,
        d.publicKey,
        `${providerId}-api-key.txt`,
        "text/plain",
      ),
    );
  }
  const keyActivateMatch = url.pathname.match(
    /^\/api\/providers\/([^/]+)\/api-keys\/([^/]+)\/activate$/,
  );
  if (keyActivateMatch && req.method === "POST") {
    const id = decodeURIComponent(keyActivateMatch[1]),
      keyId = decodeURIComponent(keyActivateMatch[2]),
      definition = providerDefinitions[id],
      adapter = providers[id];
    if (!definition || !adapter)
      throw Object.assign(Error("未知供应商"), { status: 404 });
    if (!providerKeyStore.activateKey(id, keyId))
      throw Object.assign(Error("API Key 不存在"), { status: 404 });
    billingStore.bindProviderCredential(id, keyId);
    const active = providerKeyStore.get(id);
    process.env[definition.env] = active;
    adapter.token = active;
    adapter.env[definition.env] = active;
    return json(res, 200, { activated: true, ...providerKeyStore.status(id) });
  }
  const keyRenameMatch = url.pathname.match(
    /^\/api\/providers\/([^/]+)\/api-keys\/([^/]+)\/rename$/,
  );
  if (keyRenameMatch && req.method === "POST") {
    const id = decodeURIComponent(keyRenameMatch[1]),
      keyId = decodeURIComponent(keyRenameMatch[2]),
      definition = providerDefinitions[id];
    if (!definition)
      throw Object.assign(Error("未知供应商"), { status: 404 });
    const d = await body(req);
    if (!providerKeyStore.renameKey(id, keyId, d.label))
      throw Object.assign(Error("API Key 不存在"), { status: 404 });
    return json(res, 200, { renamed: true, ...providerKeyStore.status(id) });
  }
  if (
    req.method === "GET" &&
    url.pathname === "/api/providers/hyperstack/resources"
  )
    return json(res, 200, await providers.hyperstack.configurationResources());
  if (
    req.method === "POST" &&
    url.pathname === "/api/providers/hyperstack/keypairs"
  ) {
    const d = await body(req),
      environmentName = String(d.environment || "").trim();
    if (!environmentName)
      throw Object.assign(Error("请先选择 Environment"), { status: 400 });
    const name = `gpu-fleet-managed-${Date.now().toString(36)}`,
      managed = sshStore.createKey();
    const created = await providers.hyperstack.importKeypair({
      name,
      environmentName,
      publicKey: managed.publicKey,
    });
    const keypairId = String(created.id || name);
    try {
      sshStore.save(`keypair:${keypairId}`, {
        provider: "hyperstack",
        privateKey: managed.privateKey,
        publicKey: managed.publicKey,
        internalPort: sshStore.port,
        username: "ubuntu",
      });
    } catch (error) {
      console.error("保存 Hyperstack Keypair 私钥失败", error.message);
      throw Object.assign(
        Error(
          "Keypair 已在 Hyperstack 创建，但平台未能安全保存私钥；请删除该 Keypair 后重试",
        ),
        { status: 500 },
      );
    }
    return json(res, 201, {
      id: created.id,
      name: created.name || name,
      environmentName: created.environment?.name || environmentName,
      fingerprint: created.fingerprint,
    });
  }
  if (
    req.method === "GET" &&
    url.pathname === "/api/providers/autodl/image-import/options"
  ) {
    const discovery = await providers.autodl.discover(),
      mode = url.searchParams.get("mode") || "manual";
    if (mode !== "auto")
      return json(res, 200, {
        products: discovery.products,
        experimental: false,
      });
    try {
      return json(res, 200, {
        products: discovery.products,
        offers: await providers.autodl.listExperimentalWebOffers(),
        experimental: true,
        warning:
          "报价来自未公开网页接口，可能随时失效；创建后还会用实例详情复核实际价格。",
      });
    } catch (error) {
      return json(res, 200, {
        products: discovery.products,
        offers: [],
        experimental: true,
        unavailable: true,
        warning: error.message,
        code: error.code,
      });
    }
  }
  if (
    req.method === "GET" &&
    url.pathname === "/api/providers/autodl/image-imports"
  )
    return json(res, 200, { jobs: autodlImageImports.list() });
  const autodlImageImport = url.pathname.match(
    /^\/api\/providers\/autodl\/image-imports\/([^/]+)$/,
  );
  if (req.method === "GET" && autodlImageImport) {
    const job = autodlImageImports.get(
      decodeURIComponent(autodlImageImport[1]),
    );
    if (!job) throw Object.assign(Error("镜像转存任务不存在"), { status: 404 });
    return json(res, 200, job);
  }
  if (
    req.method === "POST" &&
    url.pathname === "/api/providers/autodl/image-imports"
  ) {
    const d = await body(req),
      sourceImageUuid = String(d.sourceImageUuid || "").trim(),
      imageName = String(d.imageName || "").trim(),
      selectionMode = d.selectionMode === "auto" ? "auto" : "manual";
    if (d.confirmCost !== true)
      throw Object.assign(
        Error("必须明确确认实例运行费和可能产生的镜像存储费"),
        { status: 400, code: "cost_confirmation_required" },
      );
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{5,127}$/.test(sourceImageUuid))
      throw Object.assign(Error("社区镜像 UUID 格式无效"), { status: 400 });
    if (!imageName || imageName.length > 80)
      throw Object.assign(Error("个人镜像名称长度必须为 1–80 个字符"), {
        status: 400,
      });
    if (selectionMode === "manual" && !String(d.productId || "").trim())
      throw Object.assign(Error("手动模式必须选择 GPU"), { status: 400 });
    if (
      selectionMode === "auto" &&
      (!Number.isFinite(Number(d.maxPrice)) || Number(d.maxPrice) <= 0)
    )
      throw Object.assign(Error("自动模式必须设置大于 0 的最高时价"), {
        status: 400,
      });
    return json(
      res,
      202,
      autodlImageImports.start({
        sourceImageUuid,
        imageName,
        selectionMode,
        productId: String(d.productId || "").trim(),
        maxPrice: Number(d.maxPrice),
        confirmCost: true,
      }),
    );
  }
  if (
    req.method === "PUT" &&
    url.pathname === "/api/providers/hyperstack/config"
  ) {
    const d = await body(req),
      values = {
        HYPERSTACK_ENVIRONMENT: String(d.environment || "").trim(),
        HYPERSTACK_KEY_NAME: String(d.keyName || "").trim(),
        HYPERSTACK_IMAGE_NAME: String(d.imageName || "").trim(),
        HYPERSTACK_IMAGE_USER: String(d.imageUser || "ubuntu").trim(),
      };
    if (
      !values.HYPERSTACK_ENVIRONMENT ||
      !values.HYPERSTACK_KEY_NAME ||
      !values.HYPERSTACK_IMAGE_NAME ||
      !values.HYPERSTACK_IMAGE_USER
    )
      throw Object.assign(
        Error("Environment、SSH Keypair、Image 和访问 CIDR 均为必填项"),
        { status: 400 },
      );
    if (
      values.HYPERSTACK_AGENT_CIDR &&
      !/^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$/.test(
        values.HYPERSTACK_AGENT_CIDR,
      )
    )
      throw Object.assign(Error("访问 CIDR 格式无效，例如 203.0.113.10/32"), {
        status: 400,
      });
    const tailscaleAuthKey = String(d.tailscaleAuthKey || "").trim();
    const tailscaleAuthKeyExpiresAt = String(
      d.tailscaleAuthKeyExpiresAt || "",
    ).trim();
    if (
      tailscaleAuthKeyExpiresAt &&
      !/^\d{4}-\d{2}-\d{2}$/.test(tailscaleAuthKeyExpiresAt)
    )
      throw Object.assign(Error("Tailscale Auth Key 到期日期格式无效"), {
        status: 400,
      });
    if (tailscaleAuthKey && !d.tailscaleReusableConfirmed)
      throw Object.assign(
        Error("请确认已在 Tailscale 为该 Auth Key 开启 Reusable"),
        { status: 400, code: "tailscale_auth_key_not_reusable" },
      );
    if (!tailscaleAuthKeyExpiresAt && tailscaleAuthKey)
      throw Object.assign(Error("请填写 Tailscale Auth Key 的到期日期"), {
        status: 400,
        code: "tailscale_auth_key_expiry_missing",
      });
    if (
      tailscaleAuthKey &&
      Date.parse(`${tailscaleAuthKeyExpiresAt}T23:59:59Z`) < Date.now()
    )
      throw Object.assign(Error("Tailscale Auth Key 的到期日期不能早于今天"), {
        status: 400,
        code: "tailscale_auth_key_expired",
      });
    if (tailscaleAuthKey) {
      providerKeyStore.set("__tailscale_auth_key__", tailscaleAuthKey);
      process.env.TAILSCALE_AUTH_KEY = tailscaleAuthKey;
      providers.hyperstack.env.TAILSCALE_AUTH_KEY = tailscaleAuthKey;
    }
    if (tailscaleAuthKeyExpiresAt)
      providerKeyStore.set(
        "__tailscale_auth_key_expires_at__",
        tailscaleAuthKeyExpiresAt,
      );
    if (!process.env.TAILSCALE_AUTH_KEY)
      throw Object.assign(Error("Tailscale Auth Key 为必填项"), {
        status: 400,
        code: "tailscale_auth_key_missing",
      });
    providerKeyStore.set("__hyperstack_config__", JSON.stringify(values));
    Object.assign(process.env, values);
    Object.assign(providers.hyperstack.env, values);
    return json(res, 200, {
      configured: true,
      environment: values.HYPERSTACK_ENVIRONMENT,
      keyName: values.HYPERSTACK_KEY_NAME,
      imageName: values.HYPERSTACK_IMAGE_NAME,
      imageUser: values.HYPERSTACK_IMAGE_USER,
      tailscaleAuthKeyConfigured: true,
      tailscaleAuthKeyExpiresAt,
    });
  }
  if (req.method === "GET" && url.pathname === "/api/runtime-images")
    return json(res, 200, {
      images: runtimeImages(process.env, url.searchParams.get("provider")).map(
        ({ image, prebuiltImage, onDemandImage, ...item }) => item,
      ),
    });
  if (
    req.method === "POST" &&
    url.pathname === "/api/provision/hyperstack-status"
  ) {
    const d = await body(req),
      pending = hyperstackProvisioning.get(d.token);
    if (!pending)
      throw Object.assign(Error("provision token 无效或已过期"), {
        status: 404,
      });
    const phases = {
      checking_registry: "正在检查 NGC 镜像仓库",
      pulling_image: "正在下载容器镜像",
      image_pulled: "镜像下载完成",
      validating_cuda: "正在验证 CUDA 与 PyTorch",
      starting_runtime: "正在启动运行环境",
      installing_dependencies: "正在安装实例工具",
      starting_agent: "正在启动监控 Agent",
    };
    if (phases[d.status]) {
      const runtime = {
        status: "provisioning",
        phase: d.status,
        phaseLabel: phases[d.status],
        message: d.message || "",
        updatedAt: new Date().toISOString(),
        containerImage: d.containerImage,
      };
      instanceRuntime.set(pending.id, runtime);
      return json(res, 200, { ok: true, runtime });
    }
    if (d.status === "failed") {
      const reason = d.message || "自动装机失败，实例已自动删除";
      instanceRuntime.set(pending.id, {
        status: "failed",
        phase: "failed",
        phaseLabel: "装机失败",
        reason,
        updatedAt: new Date().toISOString(),
      });
      await providers.hyperstack.action(pending.id, "delete");
      hyperstackProvisioning.delete(d.token);
      return json(res, 200, { ok: true, deleted: true });
    }
    if (d.status === "ready") {
      const runtime = {
        status: "ready",
        phase: "ready",
        phaseLabel: "运行环境已就绪",
        cudaLabel: d.cudaLabel,
        driver: d.driver,
        containerImage: d.containerImage,
        requirementMet: String(d.cudaLabel || "").includes("13."),
        updatedAt: new Date().toISOString(),
      };
      instanceRuntime.set(pending.id, runtime);
      hyperstackProvisioning.delete(d.token);
      return json(res, 200, { ok: true, runtime });
    }
    throw Object.assign(Error("未知 provision 状态"), { status: 400 });
  }
  if (req.method === "GET" && url.pathname === "/api/offers") {
    const r = await all(
      "listOffers",
      url.searchParams.get("refresh") === "1",
    );
    return json(res, 200, {
      offers: autoDLEstimatedOffers(r.data),
      errors: r.errors,
      updatedAt: new Date().toISOString(),
      live: true,
      regionalInventoryPreloaded: false,
    });
  }
  if (
    req.method === "GET" &&
    url.pathname === "/api/providers/ppio/regional-inventory"
  )
    return json(res, 200, {
      offers: await providers.ppio.listOffersWithRegions(
        url.searchParams.get("refresh") === "1",
      ),
      updatedAt: new Date().toISOString(),
    });
  if (req.method === "GET" && url.pathname === "/api/instances") {
    const r = await all("listInstances"),
      { failedProviders, seenByProvider } = reconcileProviderInventory(r);
    if (!failedProviders.has("hyperstack"))
      for (const [token, pending] of hyperstackProvisioning) {
        const absent = !seenByProvider
            .get("hyperstack")
            .has(String(pending.id)),
          deleteConfirmed =
            lifecycleActions.get(String(pending.id))?.action === "delete";
        if (
          absent &&
          (deleteConfirmed || Date.now() - pending.createdAt > 20 * 60 * 1000)
        )
          hyperstackProvisioning.delete(token);
      }
    const pendingIds = new Set(
        [...hyperstackProvisioning.values()].map((x) => String(x.id)),
      ),
      seen = new Set(r.data.map((x) => String(x.id)));
    for (const id of instanceFirstSeen.keys())
      if (!seen.has(id)) instanceFirstSeen.delete(id);
    for (const key of sshReadiness.keys())
      if (!seen.has(key.slice(key.indexOf(":") + 1))) sshReadiness.delete(key);
    for (const [id, pending] of lifecycleActions) {
      const current = r.data.find((x) => String(x.id) === id),
        done =
          (!current && pending.action === "delete") ||
          (current &&
            pending.action === "stop" &&
            current.status === "stopped") ||
          (current &&
            pending.action === "start" &&
            current.status === "running");
      if (done || Date.now() - pending.at > 120000) lifecycleActions.delete(id);
    }
    for (const [id, pending] of lifecycleActions)
      if (pending.action === "delete" && !seen.has(id))
        lifecycleActions.delete(id);
    for (const x of r.data) {
      const id = String(x.id),
        credential = agentCredentials.findByInstance(x.provider, id);
      if (x.agentUrl) agentTargets.set(id, x.agentUrl);
      if (telemetryMode === "ssh")
        instanceTelemetryKeys.set(id, `${x.provider}:${id}`);
      else if (credential)
        instanceTelemetryKeys.set(
          id,
          `${credential.provider}:${credential.instance_name}`,
        );
      else if (!instanceTelemetryKeys.has(id))
        instanceTelemetryKeys.set(id, `${x.provider}:${x.name}`);
    }
    reconcileSshTelemetry(r.data);
    return json(res, 200, {
      instances: r.data.map((x) => {
        const id = String(x.id),
          storedRuntime = instanceRuntime.get(id) || instanceRuntime.get(x.id),
          pending = pendingIds.has(id),
          key = instanceTelemetryKeys.get(id),
          diagnostic = telemetryDiagnostics.get(key),
          pushed = pushedTelemetry.get(key),
          telemetryConnected = Boolean(
            pushed && Date.now() - pushed.at < 15000,
          ),
          telemetryRuntime = pushed?.data?.runtime,
          runtime =
            baseUrlUpdates.get(`${x.provider}:${id}`) ||
            storedRuntime ||
            telemetryRuntime,
          action = lifecycleActions.get(id),
          savedSsh = sshStore.get(x.provider, id),
          recentlyCreated =
            !runtime &&
            x.status === "running" &&
            savedSsh &&
            Date.now() - Date.parse(savedSsh.createdAt) < 20 * 60 * 1000,
          initializing = runtime?.status === "provisioning" || recentlyCreated,
          status =
            action?.action === "stop"
              ? "stopping"
              : action?.action === "start"
                ? "provisioning"
                : action?.action === "delete"
                  ? "terminating"
                  : pending || initializing
                    ? "provisioning"
                    : runtime?.status === "failed"
                      ? "failed"
                      : x.status,
          sshKey = `${x.provider}:${id}`,
          billing = billingStore.estimate(x.provider, id);
        // SSH 是供应商运行后的平台初始化步骤。供应商仍在 pending、
        // pulling 或 starting 时不要提前探测，否则会把正常镜像准备过程
        // 错误地显示成“SSH 尚未就绪”。
        if (
          x.status === "running" &&
          ["running", "provisioning", "failed"].includes(status)
        )
          scheduleSshReadinessProbe(x.provider, id, runtime);
        else sshReadiness.delete(sshKey);
        const sshReady =
          Boolean(sshReadiness.get(sshKey)?.ready) &&
          ["running", "provisioning"].includes(status);
        const sshDiagnostic = sshReadiness.get(sshKey);
        const benchmarkReady =
          telemetryMode === "ssh"
            ? Boolean(savedSsh && sshReady)
            : telemetryConnected || agentTargets.has(id);
        if (status === "running" && !instanceFirstSeen.has(id))
          instanceFirstSeen.set(id, Date.now());
        const telemetryGraceUntil =
          (instanceFirstSeen.get(id) || Date.now()) + telemetryGraceMs;
        return {
          ...x,
          sshCommand:
            x.accessType === "tailscale"
              ? `ssh -i <private-key> ${x.sshUser || "<image-user>"}@<tailscale-ip>`
              : x.sshCommand,
          accessMessage:
            x.accessType === "tailscale"
              ? "无公网 IP；请在 Tailscale 管理后台获取 100.x.x.x 地址"
              : x.accessMessage,
          price:
            Number(x.price) > 0
              ? Number(x.price)
              : Number(billing?.hourlyPrice) > 0
                ? Number(billing.hourlyPrice)
                : undefined,
          priceUnit: x.priceUnit || billing?.priceUnit,
          priceSource: x.priceSource || billing?.priceSource,
          providerState: x.status,
          status,
          runtime,
          lifecycleAction: action?.action,
          platformManaged: Boolean(savedSsh),
          platformAttachable:
            !savedSsh && x.status === "running",
          sshReady,
          sshDiagnostic: sshDiagnostic
            ? {
                state: sshDiagnostic.ready
                  ? "ready"
                  : sshDiagnostic.probing
                    ? "probing"
                    : "failed",
                message: sshDiagnostic.error || undefined,
                checkedAt: sshDiagnostic.checkedAt
                  ? new Date(sshDiagnostic.checkedAt).toISOString()
                  : undefined,
              }
            : undefined,
          billing,
          cudaProfile: runtime?.cudaLabel || x.cudaProfile,
          telemetryStatus:
            diagnostic?.state === "agent_error"
              ? "agent_error"
              : telemetryConnected
                ? "connected"
                : diagnostic?.state || "waiting",
          telemetryError: diagnostic?.message
            ? {
                message: diagnostic.message,
                component: diagnostic.component,
                code: diagnostic.code,
              }
            : undefined,
          telemetryLastSeen: pushed?.at
            ? new Date(pushed.at).toISOString()
            : undefined,
          telemetryGraceUntil: new Date(telemetryGraceUntil).toISOString(),
          benchmarkReady,
          benchmarkMessage: benchmarkReady
            ? telemetryMode === "ssh"
              ? "SSH 测试通道已就绪"
              : telemetryConnected
                ? "Agent 反向测试通道已就绪"
                : "Agent 直连测试通道已就绪"
            : telemetryMode === "ssh"
              ? "等待 SSH 上线后即可测试"
              : "等待 Agent 上线后即可测试",
          raw: undefined,
        };
      }),
      errors: r.errors,
    });
  }
  const discovery = url.pathname.match(
    /^\/api\/providers\/([^/]+)\/discovery$/,
  );
  if (req.method === "GET" && discovery)
    return json(res, 200, await provider(discovery[1]).discover());
  const regional = url.pathname.match(
    /^\/api\/providers\/ppio\/products\/([^/]+)\/regions$/,
  );
  if (req.method === "GET" && regional)
    return json(res, 200, {
      regions: await providers.ppio.listRegionalOffers(
        decodeURIComponent(regional[1]),
      ),
      updatedAt: new Date().toISOString(),
    });
  if (req.method === "POST" && url.pathname === "/api/instances") {
    const d = await body(req);
    if (d.offerId && (!d.provider || !d.productId)) {
      const [p, ...parts] = d.offerId.split(":");
      d.provider = p;
      d.productId = parts.join(":");
    }
    if (!d.provider || !d.productId)
      throw Object.assign(Error("provider 与 productId 必填"), { status: 400 });
    if (d.provider !== "autodl") {
      const selectedImage = resolveRuntimeImage(
        d.imageVersion,
        process.env,
        d.imageBuildMode,
        d.provider,
      );
      d.imageVersion = selectedImage.id;
      d.imageBuildMode = selectedImage.buildMode;
      d.imageUrl = selectedImage.image;
      d.expectedCudaMajor = selectedImage.cudaMajor;
      d.allowCuda128Fallback = Boolean(selectedImage.allowCuda128Fallback);
    }
    if (d.provider === "hyperstack")
      d.provisionToken = randomBytes(24).toString("hex");
    const managed = ["ppio", "autodl", "hyperstack", "runpod"].includes(
      d.provider,
    )
      ? sshStore.createKey()
      : null;
    if (managed) d.sshPublicKey = managed.publicKey;
    let item;
    try {
      item = await provider(d.provider).create(d);
    } catch (error) {
      if (isStaleInventoryError(error)) {
        if (d.provider === "autodl")
          throw Object.assign(
            Error(
              "AutoDL 当前没有满足该 GPU 规格与镜像条件的宿主机，未创建实例，也不会产生实例卡片",
            ),
            {
              status: 409,
              code: "autodl_no_compatible_host",
              provider: d.provider,
              productId: d.productId,
            },
          );
        throw Object.assign(
          Error(
            "当前页面的库存信息已过期，该 GPU 可能已被其他用户抢先创建，请刷新后重试",
          ),
          { status: 409, code: "stale_inventory", provider: d.provider },
        );
      }
      throw error;
    }
    const createdAt = new Date().toISOString(),
      price =
        Number(item.price) > 0
          ? Number(item.price)
          : Number(d.price) > 0
            ? Number(d.price)
            : undefined;
    billingStore.observe(
      {
        ...item,
        provider: d.provider,
        productId: d.productId,
        status: item.status || "provisioning",
        price,
        priceUnit: item.priceUnit || d.priceUnit,
        priceSource:
          item.priceSource || d.priceSource || "launch-price-snapshot",
      },
      { createdAt },
    );
    if (managed)
      sshStore.save(item.id, {
        provider: d.provider,
        privateKey: managed.privateKey,
        publicKey: managed.publicKey,
        internalPort: sshStore.port,
        username: item.sshUser || "root",
      });
    if (d.provisionToken)
      hyperstackProvisioning.set(d.provisionToken, {
        id: item.id,
        createdAt: Date.now(),
      });
    return json(res, 202, {
      ...item,
      billing: billingStore.estimate(d.provider, item.id),
    });
  }
  const adoptionPrepare = url.pathname.match(
    /^\/api\/instances\/([^/]+)\/adoption\/prepare$/,
  );
  if (req.method === "POST" && adoptionPrepare) {
    const id = decodeURIComponent(adoptionPrepare[1]),
      d = await body(req),
      providerId = String(d.provider || ""),
      listed = await provider(providerId).listInstances(),
      instance = listed.find((item) => String(item.id) === String(id));
    if (!instance)
      throw Object.assign(Error("供应商实例不存在"), { status: 404 });
    if (instance.status !== "running")
      throw Object.assign(Error("实例运行后才能接入平台"), {
        status: 409,
        code: "instance_not_running",
      });
    const pair = sshStore.createKey(),
      token = randomBytes(24).toString("hex"),
      username = providerId === "hyperstack" ? "ubuntu" : "root",
      adapter = provider(providerId);
    let host = instance.sshHost || instance.ip || "",
      port = Number(instance.sshPort) || 22,
      detectedUsername = username;
    if (typeof adapter.getSshConnection === "function")
      try {
        const connection = await adapter.getSshConnection(id);
        host = connection.host || host;
        port = Number(connection.port) || port;
        detectedUsername = connection.username || detectedUsername;
      } catch {}
    pendingInstanceAdoptions.set(token, {
      token, id, providerId, pair, createdAt: Date.now(),
    });
    for (const [key, pending] of pendingInstanceAdoptions)
      if (Date.now() - pending.createdAt > 15 * 60 * 1000)
        pendingInstanceAdoptions.delete(key);
    return json(res, 200, {
      token,
      id,
      provider: providerId,
      host,
      port,
      username: detectedUsername,
      publicKey: pair.publicKey,
      installCommand: adoptionInstallCommand(pair.publicKey),
      automaticAvailable:
        typeof provider(providerId).getSshConnection === "function",
      savedCredentialAvailable: Boolean(instanceAccessStore.get(providerId, id)),
      expiresInSeconds: 900,
    });
  }
  const adoptionVerify = url.pathname.match(
    /^\/api\/instances\/([^/]+)\/adoption\/verify$/,
  );
  if (req.method === "POST" && adoptionVerify) {
    const id = decodeURIComponent(adoptionVerify[1]),
      d = await body(req),
      pending = pendingInstanceAdoptions.get(String(d.token || ""));
    if (!pending || pending.id !== id)
      throw Object.assign(Error("接入凭据已过期，请重新生成"), {
        status: 410,
        code: "adoption_expired",
      });
    const providerId = pending.providerId,
      requestedUsername = String(d.username || "root").trim(),
      requestedHost = String(d.host || "").trim(),
      requestedPort = Number(d.port),
      install = adoptionInstallCommand(pending.pair.publicKey);
    let username = requestedUsername,
      host = requestedHost,
      port = requestedPort;
    if (d.method === "automatic") {
      const legacy = await waitForProviderSsh(provider(providerId), id);
      username = legacy.username;
      host = legacy.host;
      port = legacy.port;
      await sshWithPassword({ ...legacy, remote: install });
    } else if (d.method === "saved") {
      const saved = instanceAccessStore.get(providerId, id);
      if (!saved)
        throw Object.assign(Error("该实例没有已保存的备用 SSH 凭据"), {
          status: 404,
          code: "saved_credential_missing",
        });
      username = saved.username;
      if (saved.type === "privateKey")
        await sshWithPrivateKey({
          host, port, username, privateKey: saved.secret, remote: install,
        });
      else
        await sshWithPassword({
          host, port, username, password: saved.secret, remote: install,
        });
    } else if (d.method === "privateKey") {
      if (!d.privateKey)
        throw Object.assign(Error("请输入现有 SSH 私钥"), { status: 400 });
      await sshWithPrivateKey({
        host, port, username, privateKey: d.privateKey, remote: install,
      });
    } else if (d.method === "password") {
      if (!d.password)
        throw Object.assign(Error("请输入 SSH 密码"), { status: 400 });
      await sshWithPassword({
        host, port, username, password: d.password, remote: install,
      });
    } else if (d.method !== "manual") {
      throw Object.assign(Error("未知接入方式"), { status: 400 });
    }
    if (!host || !port || !username)
      throw Object.assign(Error("SSH 地址、端口和用户名必填"), { status: 400 });
    await sshWithPrivateKey({
      host,
      port,
      username,
      privateKey: pending.pair.privateKey,
      remote: "true",
    });
    sshStore.save(id, {
      provider: providerId,
      privateKey: pending.pair.privateKey,
      publicKey: pending.pair.publicKey,
      internalPort: 22,
      username,
    });
    sshStore.update(providerId, id, { host, externalPort: port });
    if (d.method === "privateKey")
      instanceAccessStore.save(providerId, id, {
        type: "privateKey",
        username,
        secret: d.privateKey,
      });
    else if (d.method === "password")
      instanceAccessStore.save(providerId, id, {
        type: "password",
        username,
        secret: d.password,
      });
    pendingInstanceAdoptions.delete(pending.token);
    await reinjectTelemetryAgent(providerId, id);
    return json(res, 202, {
      ok: true,
      id,
      provider: providerId,
      message: "SSH 已验证，实例专属密钥已加密保存，正在安装遥测 Agent",
    });
  }
  const renameInstance = url.pathname.match(
    /^\/api\/instances\/([^/]+)\/name$/,
  );
  if (req.method === "PATCH" && renameInstance) {
    const id = decodeURIComponent(renameInstance[1]),
      d = await body(req),
      providerId = String(d.provider || ""),
      record = billingStore.renameInstance(providerId, id, d.name);
    if (!record) throw Object.assign(Error("实例不存在"), { status: 404 });
    return json(res, 200, {
      ok: true,
      id,
      provider: providerId,
      name: record.display_name,
    });
  }
  const renameProviderInstance = url.pathname.match(
    /^\/api\/instances\/([^/]+)\/provider-name$/,
  );
  if (req.method === "PATCH" && renameProviderInstance) {
    const id = decodeURIComponent(renameProviderInstance[1]),
      d = await body(req),
      providerId = String(d.provider || ""),
      name = String(d.name || "").trim(),
      adapter = provider(providerId);
    if (!name || name.length > 80 || /[\0\r\n]/.test(name))
      throw Object.assign(Error("供应商实例名称长度必须为 1–80 个字符"), {
        status: 400,
      });
    if (typeof adapter.renameInstance !== "function")
      throw Object.assign(Error("该供应商没有公开的实例改名 API"), {
        status: 409,
        code: "provider_rename_unsupported",
      });
    await adapter.renameInstance(id, name);
    return json(res, 200, { ok: true, id, provider: providerId, name });
  }
  const sshConnection = url.pathname.match(/^\/api\/instances\/([^/]+)\/ssh$/);
  if (req.method === "GET" && sshConnection) {
    const id = decodeURIComponent(sshConnection[1]),
      providerId = url.searchParams.get("provider"),
      adapter = provider(providerId),
      managed = await managedSshConnection(providerId, id);
    if (!managed) {
      if (typeof adapter.getSshConnection === "function") {
        const legacy = await waitForProviderSsh(adapter, id);
        return json(res, 200, {
          ...legacy,
          credentialType: "password",
          managed: false,
          terminalAvailable: true,
        });
      }
      throw Object.assign(Error("该实例没有托管 SSH 凭证"), {
        status: 409,
        code: "ssh_provider_error",
      });
    }
    return json(res, 200, {
      provider: providerId,
      command: managed.command,
      username: managed.username,
      host: managed.host,
      port: managed.port,
      identityFile: managed.identityFile,
      credentialType: "private-key",
      managed: true,
      keyDownloadUrl: `/api/instances/${encodeURIComponent(id)}/ssh/key?provider=${encodeURIComponent(providerId)}`,
      terminalAvailable: true,
      source: "encrypted-sqlite",
    });
  }
  const sshKey = url.pathname.match(/^\/api\/instances\/([^/]+)\/ssh\/key$/);
  if (req.method === "POST" && sshKey) {
    const id = decodeURIComponent(sshKey[1]),
      providerId = url.searchParams.get("provider"),
      d = await body(req),
      managed = sshStore.get(providerId, id);
    if (!managed)
      throw Object.assign(Error("该实例没有可下载的托管私钥"), { status: 404 });
    const identityFile =
      `gpu-fleet-${providerId}-${id}`.replace(/[^a-z0-9._-]/gi, "_") + ".pem";
    return json(
      res,
      200,
      encryptedDownload(
        openSshPrivateKey(managed.privateKey),
        d.publicKey,
        identityFile,
        "application/x-pem-file",
      ),
    );
  }
  const sshCheck = url.pathname.match(
    /^\/api\/instances\/([^/]+)\/ssh\/check$/,
  );
  if (req.method === "POST" && sshCheck) {
    const id = decodeURIComponent(sshCheck[1]),
      d = await body(req),
      managed = await managedSshConnection(String(d.provider || ""), id);
    if (!managed)
      throw Object.assign(Error("该实例没有可用于文件传输的托管 SSH 凭据"), {
        status: 409,
      });
    const token = randomBytes(12).toString("hex"),
      keyFile = path.join(os.tmpdir(), `gpu-fleet-check-${token}.pem`);
    try {
      fs.writeFileSync(keyFile, openSshPrivateKey(managed.privateKey), {
        mode: 0o600,
      });
      securePrivateKeyFile(keyFile);
      await verifyManagedSsh({ ...managed, keyFile });
      return json(res, 200, { ok: true });
    } finally {
      removeTemporaryFile(keyFile);
    }
  }
  const scpUpload = url.pathname.match(/^\/api\/instances\/([^/]+)\/files$/);
  if (req.method === "POST" && scpUpload) {
    const id = decodeURIComponent(scpUpload[1]),
      providerId = String(url.searchParams.get("provider") || ""),
      managed = await managedSshConnection(providerId, id);
    if (!managed)
      throw Object.assign(Error("浏览器 SCP 只支持托管私钥实例"), {
        status: 409,
        code: "ssh_credentials_unavailable",
      });
    const remoteDir = String(
        req.headers["x-remote-directory"] || "/data/uploads",
      ).trim(),
      originalName = decodeURIComponent(
        String(req.headers["x-file-name"] || "upload.bin"),
      ),
      relativeHeader = decodeURIComponent(
        String(req.headers["x-relative-path"] || originalName),
      ).replaceAll("\\", "/"),
      segments = relativeHeader.split("/");
    if (!/^\/[a-zA-Z0-9._/-]+$/.test(remoteDir) || remoteDir.includes(".."))
      throw Object.assign(Error("远端目录必须是安全的绝对路径"), {
        status: 400,
        code: "invalid_upload_path",
      });
    if (
      !segments.length ||
      segments.some(
        (segment) =>
          !segment ||
          segment === "." ||
          segment === ".." ||
          /[\0\r\n]/.test(segment),
      )
    )
      throw Object.assign(Error("文件相对路径无效"), {
        status: 400,
        code: "invalid_upload_path",
      });
    const relativePath = segments.join("/"),
      remotePath = `${remoteDir}/${relativePath}`,
      remoteParent = path.posix.dirname(remotePath),
      filename = path.posix.basename(relativePath),
      token = randomBytes(12).toString("hex"),
      keyFile = path.join(os.tmpdir(), `gpu-fleet-upload-${token}.pem`),
      localFile = path.join(
        os.tmpdir(),
        `gpu-fleet-upload-${token}-${path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_") || "upload.bin"}`,
      ),
      common = [
        "-i",
        keyFile,
        "-p",
        String(managed.port),
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "ConnectionAttempts=1",
      ],
      quote = (value) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;
    try {
      const size = await receiveUpload(req, localFile);
      fs.writeFileSync(keyFile, openSshPrivateKey(managed.privateKey), {
        mode: 0o600,
      });
      securePrivateKeyFile(keyFile);
      if (req.headers["x-extract-archive"] === "1") {
        // Bundled upload: a single .tar.gz produced by the browser.
        const archiveName = `${token}.tar.gz`,
          remoteArchive = `/tmp/gpu-fleet-upload-${archiveName}`;
        try {
          await runCommand(
            "ssh",
            [...common, `${managed.username}@${managed.host}`, `mkdir -p -- ${quote(remoteDir)}`],
            { timeout: 30000, killSignal: "SIGKILL" },
          );
          await runCommand(
            "scp",
            [
              "-i",
              keyFile,
              "-P",
              String(managed.port),
              "-o",
              "BatchMode=yes",
              "-o",
              "StrictHostKeyChecking=accept-new",
              "-o",
              "ConnectTimeout=8",
              "-o",
              "ConnectionAttempts=1",
              localFile,
              `${managed.username}@${managed.host}:${quote(remoteArchive)}`,
            ],
            { timeout: 30 * 60 * 1000, killSignal: "SIGKILL" },
          );
          await runCommand(
            "ssh",
            [...common, `${managed.username}@${managed.host}`, `tar -xzf ${quote(remoteArchive)} -C ${quote(remoteDir)} && rm -f ${quote(remoteArchive)}`],
            { timeout: 10 * 60 * 1000, killSignal: "SIGKILL" },
          );
        } catch (cause) {
          throw Object.assign(Error(`压缩包解压失败：${cause.message}`), {
            status: 502,
            code: "ssh_transfer_failed",
            cause,
          });
        }
        return json(res, 201, {
          ok: true,
          name: archiveName,
          size,
          relativePath: ".",
          remotePath: remoteDir,
          extracted: true,
        });
      }
      try {
        await runCommand(
          "ssh",
          [
            ...common,
            `${managed.username}@${managed.host}`,
            `mkdir -p -- ${quote(remoteParent)}`,
          ],
          { timeout: 30000, killSignal: "SIGKILL" },
        );
        await runCommand(
          "scp",
          [
            "-i",
            keyFile,
            "-P",
            String(managed.port),
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "ConnectTimeout=8",
            "-o",
            "ConnectionAttempts=1",
            localFile,
            `${managed.username}@${managed.host}:${quote(remotePath)}`,
          ],
          { timeout: 30 * 60 * 1000, killSignal: "SIGKILL" },
        );
      } catch (cause) {
        throw Object.assign(Error(`远端文件传输失败：${cause.message}`), {
          status: 502,
          code: "ssh_transfer_failed",
          cause,
        });
      }
      return json(res, 201, {
        ok: true,
        name: filename,
        size,
        relativePath,
        remotePath,
      });
    } finally {
      removeTemporaryFile(keyFile);
      removeTemporaryFile(localFile);
    }
  }
  const localSync = url.pathname.match(
    /^\/api\/instances\/([^/]+)\/local-sync$/,
  );
  if (req.method === "POST" && localSync) {
    if (CLIENT_MODE !== "local")
      throw Object.assign(Error("增量同步需要 Fast GPU 本地客户端"), {
        status: 409,
        code: "local_client_required",
      });
    const rsyncCommand = resolveRsyncCommand();
    if (!rsyncCommand)
      throw Object.assign(
        Error("本机和应用内都未找到 rsync；请先选择一种下载方式"),
        { status: 409, code: "rsync_unavailable" },
      );
    const id = decodeURIComponent(localSync[1]),
      d = await body(req),
      providerId = String(d.provider || ""),
      managed = await managedSshConnection(providerId, id);
    if (!managed)
      throw Object.assign(Error("本地 rsync 只支持托管私钥实例"), {
        status: 409,
      });
    const requestedLocalPath = String(d.localPath || "").trim();
    if (!path.isAbsolute(requestedLocalPath))
      throw Object.assign(Error("本地路径必须是绝对路径"), {
        status: 400,
        code: "local_path_must_be_absolute",
      });
    const localPath = path.normalize(requestedLocalPath),
      remoteDir = String(d.remoteDir || "/data/sync").trim(),
      direction = d.direction === "download" ? "download" : "upload";
    if (!fs.existsSync(localPath) || !fs.statSync(localPath).isDirectory())
      throw Object.assign(Error("本地目录不存在或不是文件夹"), { status: 400 });
    if (!/^\/[a-zA-Z0-9._/-]+$/.test(remoteDir) || remoteDir.includes(".."))
      throw Object.assign(Error("远端目录必须是安全的绝对路径"), {
        status: 400,
      });
    const token = randomBytes(12).toString("hex"),
      keyFile = path.join(os.tmpdir(), `gpu-fleet-rsync-${token}.pem`);
    try {
      fs.writeFileSync(keyFile, openSshPrivateKey(managed.privateKey), {
        mode: 0o600,
      });
      securePrivateKeyFile(keyFile);
      const windowsLocalPath = localPath.replace(/[\\/]+$/, ""),
        localRsyncPath =
          process.platform === "win32"
            ? /^[a-zA-Z]:[\\/]/.test(windowsLocalPath)
              ? `/cygdrive/${windowsLocalPath[0].toLowerCase()}${windowsLocalPath.slice(2).replace(/\\/g, "/")}/`
              : windowsLocalPath.replace(/\\/g, "/") + "/"
            : windowsLocalPath + path.sep,
        remoteRsyncPath = `${managed.username}@${managed.host}:${remoteDir}/`,
        sshCommand = executablePath("ssh") || "ssh",
        ssh = `"${sshCommand}" -i "${keyFile}" -p ${managed.port} -o BatchMode=yes -o StrictHostKeyChecking=accept-new`;
      const remoteRsyncSetup =
        "command -v rsync >/dev/null 2>&1 || { " +
        "if command -v apt-get >/dev/null 2>&1; then " +
        "if [ \"$(id -u)\" = 0 ]; then apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends rsync; " +
        "elif command -v sudo >/dev/null 2>&1; then sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends rsync; else exit 126; fi; " +
        "elif command -v apk >/dev/null 2>&1; then if [ \"$(id -u)\" = 0 ]; then apk add --no-cache rsync; else sudo apk add --no-cache rsync; fi; " +
        "elif command -v dnf >/dev/null 2>&1; then if [ \"$(id -u)\" = 0 ]; then dnf install -y rsync; else sudo dnf install -y rsync; fi; " +
        "elif command -v yum >/dev/null 2>&1; then if [ \"$(id -u)\" = 0 ]; then yum install -y rsync; else sudo yum install -y rsync; fi; " +
        "else exit 127; fi; }; command -v rsync >/dev/null 2>&1";
      try {
        await runCommand(
          sshCommand,
          [
            "-i",
            keyFile,
            "-p",
            String(managed.port),
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=accept-new",
            `${managed.username}@${managed.host}`,
            remoteRsyncSetup,
          ],
          { timeout: 10 * 60 * 1000, killSignal: "SIGKILL" },
        );
      } catch (cause) {
        throw Object.assign(
          Error(
            "云端实例缺少 rsync，自动安装失败。请用平台终端安装 rsync 后重试。",
          ),
          { status: 502, code: "remote_rsync_unavailable", cause },
        );
      }
      if (d.compress) {
        const tarCommand = resolveTool("tar").executable;
        if (!tarCommand)
          throw Object.assign(Error("本机未找到 tar，无法启用压缩传输"), {
            status: 409,
            code: "tar_unavailable",
          });
        const localArchive = path.join(os.tmpdir(), `gpu-fleet-sync-${token}.tar.gz`),
          remoteArchive = `/tmp/gpu-fleet-sync-${token}.tar.gz`,
          baseName = path.basename(localPath) || "data",
          parentName = path.dirname(localPath) || ".",
          sshBase = [
            "-i",
            keyFile,
            "-p",
            String(managed.port),
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "ConnectTimeout=8",
            "-o",
            "ConnectionAttempts=1",
          ],
          sshHost = `${managed.username}@${managed.host}`;
        try {
          if (direction === "upload") {
            await runCommand(tarCommand, ["-czf", localArchive, "-C", parentName, baseName], {
              timeout: 60 * 60 * 1000,
              killSignal: "SIGKILL",
            });
            await runCommand(rsyncCommand, ["-z", "--partial", "--info=progress2", "-e", ssh, localArchive, `${sshHost}:${quote(remoteArchive)}`], {
              timeout: 60 * 60 * 1000,
              killSignal: "SIGKILL",
            });
            await runCommand("ssh", [...sshBase, sshHost, `mkdir -p -- ${quote(remoteDir)} && tar -xzf ${quote(remoteArchive)} -C ${quote(remoteDir)} && rm -f ${quote(remoteArchive)}`], {
              timeout: 60 * 60 * 1000,
              killSignal: "SIGKILL",
            });
          } else {
            await runCommand("ssh", [...sshBase, sshHost, `cd ${quote(remoteDir)} && tar -czf ${quote(remoteArchive)} .`], {
              timeout: 60 * 60 * 1000,
              killSignal: "SIGKILL",
            });
            await runCommand(rsyncCommand, ["-z", "--partial", "--info=progress2", "-e", ssh, `${sshHost}:${quote(remoteArchive)}`, localArchive], {
              timeout: 60 * 60 * 1000,
              killSignal: "SIGKILL",
            });
            await runCommand("ssh", [...sshBase, sshHost, `rm -f ${quote(remoteArchive)}`], {
              timeout: 30000,
              killSignal: "SIGKILL",
            });
            await runCommand(tarCommand, ["-xzf", localArchive, "-C", localPath], {
              timeout: 60 * 60 * 1000,
              killSignal: "SIGKILL",
            });
          }
          return json(res, 200, {
            ok: true,
            localPath,
            remoteDir,
            direction,
            compressed: true,
            output: "压缩传输完成",
          });
        } finally {
          // Always remove both temp archives, even on failure.
          try {
            await runCommand(
              "ssh",
              [...sshBase, sshHost, `rm -f ${quote(remoteArchive)}`],
              { timeout: 30000, killSignal: "SIGKILL" },
            );
          } catch {}
          removeTemporaryFile(localArchive);
        }
      }
      const output = await runCommand(rsyncCommand, [
        "-avz",
        "--partial",
        "--append-verify",
        "--info=progress2",
        "-e",
        ssh,
        ...(direction === "upload"
          ? [localRsyncPath, remoteRsyncPath]
          : [remoteRsyncPath, localRsyncPath]),
      ]);
      return json(res, 200, {
        ok: true,
        localPath,
        remoteDir,
        direction,
        output,
      });
    } finally {
      removeTemporaryFile(keyFile);
    }
  }
  const passwordSshTerminal = url.pathname.match(
    /^\/api\/instances\/([^/]+)\/ssh\/terminal$/,
  );
  if (req.method === "POST" && passwordSshTerminal) {
    const id = decodeURIComponent(passwordSshTerminal[1]),
      d = await body(req),
      providerId = String(d.provider || "");
    const savedSsh = sshStore.get(providerId, id);
    let useProviderPassword = providerId === "autodl" && !savedSsh;
    if (providerId === "ppio" && savedSsh) {
      const managed = await managedSshConnection(providerId, id),
        probeKey = path.join(
          os.tmpdir(),
          `gpu-fleet-probe-${randomBytes(12).toString("hex")}.pem`,
        );
      try {
        fs.writeFileSync(probeKey, openSshPrivateKey(managed.privateKey), {
          mode: 0o600,
        });
        securePrivateKeyFile(probeKey);
        await verifyManagedSsh({ ...managed, keyFile: probeKey });
      } catch (error) {
        if (/permission denied \(publickey\)/i.test(error.message))
          useProviderPassword = true;
        else throw error;
      } finally {
        removeTemporaryFile(probeKey);
      }
    }
    if (useProviderPassword) {
      const legacy = await waitForProviderSsh(provider(providerId), id),
        sshExecutable = executablePath("ssh");
      if (!sshExecutable)
        throw Object.assign(
          Error("本机未找到 OpenSSH 客户端，无法打开平台终端"),
          { status: 503, code: "ssh_client_unavailable" },
        );
      const publicKey = String(savedSsh?.publicKey || ""),
        encodedKey = Buffer.from(publicKey).toString("base64"),
        repairCommand = publicKey
          ? `mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"; touch "$HOME/.ssh/authorized_keys"; key="$(printf '%s' '${encodedKey}' | base64 -d)"; grep -qxF "$key" "$HOME/.ssh/authorized_keys" || printf '%s\\n' "$key" >> "$HOME/.ssh/authorized_keys"; chmod 600 "$HOME/.ssh/authorized_keys"; unset key\r`
          : "";
      const sessionId = randomBytes(18).toString("hex"),
        child = pty.spawn(
          sshExecutable,
          [
            "-tt",
            "-p",
            String(legacy.port),
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "PreferredAuthentications=password,keyboard-interactive",
            "-o",
            "PubkeyAuthentication=no",
            "-o",
            "ServerAliveInterval=20",
            `${legacy.username}@${legacy.host}`,
          ],
          {
            name: "xterm-256color",
            cols: Math.max(20, Number(d.cols) || 100),
            rows: Math.max(5, Number(d.rows) || 30),
            cwd: process.cwd(),
            env: { ...process.env, TERM: "xterm-256color" },
          },
        ),
        session = {
          process: child,
          keyFile: null,
          output: [],
          listeners: new Set(),
          closed: false,
          passwordSent: false,
          repairSent: false,
        };
      sshSessions.set(sessionId, session);
      const publish = (chunk) => {
        const text = String(chunk);
        if (!session.passwordSent && /(?:password|密码)\s*:/i.test(text)) {
          session.passwordSent = true;
          child.write(String(legacy.password) + "\r");
          return;
        }
        if (
          session.passwordSent &&
          !session.repairSent &&
          repairCommand &&
          !/permission denied|authentication failed/i.test(text)
        ) {
          session.repairSent = true;
          setTimeout(() => child.write(repairCommand), 100);
        }
        session.output.push(text);
        if (session.output.length > 200) session.output.shift();
        for (const listener of session.listeners) listener(text);
      };
      child.onData(publish);
      child.onExit(({ exitCode }) => {
        session.closed = true;
        publish(`\r\n[连接已关闭，退出码 ${exitCode}]\r\n`);
        setTimeout(() => sshSessions.delete(sessionId), 60000).unref();
      });
      return json(res, 201, {
        sessionId,
        streamUrl: `/api/ssh/sessions/${sessionId}/events`,
        authentication: publicKey
          ? "provider-password-repair"
          : "provider-password-auto-fill",
      });
    }
  }
  const sshTerminal = url.pathname.match(
    /^\/api\/instances\/([^/]+)\/ssh\/terminal$/,
  );
  if (req.method === "POST" && sshTerminal) {
    const id = decodeURIComponent(sshTerminal[1]),
      d = await body(req),
      providerId = String(d.provider || ""),
      managed = await managedSshConnection(providerId, id);
    if (!managed)
      throw Object.assign(Error("平台终端只支持托管私钥实例"), { status: 409 });
    const sshExecutable = executablePath("ssh");
    if (!sshExecutable)
      throw Object.assign(
        Error("本机未找到 OpenSSH 客户端，无法打开平台终端"),
        { status: 503, code: "ssh_client_unavailable" },
      );
    const sessionId = randomBytes(18).toString("hex"),
      keyFile = path.join(os.tmpdir(), `gpu-fleet-${sessionId}.pem`);
    try {
      fs.writeFileSync(keyFile, openSshPrivateKey(managed.privateKey), {
        mode: 0o600,
      });
      securePrivateKeyFile(keyFile);
    } catch (error) {
      removeTemporaryFile(keyFile);
      throw error;
    }
    let child;
    try {
      child = pty.spawn(
        sshExecutable,
        [
          "-tt",
          "-i",
          keyFile,
          "-p",
          String(managed.port),
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=accept-new",
          "-o",
          "ServerAliveInterval=20",
          `${managed.username}@${managed.host}`,
        ],
        {
          name: "xterm-256color",
          cols: Math.max(20, Number(d.cols) || 100),
          rows: Math.max(5, Number(d.rows) || 30),
          cwd: process.cwd(),
          env: { ...process.env, TERM: "xterm-256color" },
        },
      );
    } catch (cause) {
      removeTemporaryFile(keyFile);
      throw Object.assign(Error(`无法启动本机 SSH 客户端：${cause.message}`), {
        status: 500,
        code: "ssh_client_start_failed",
        cause,
      });
    }
    const session = {
      process: child,
      keyFile,
      output: [],
      listeners: new Set(),
      closed: false,
    };
    sshSessions.set(sessionId, session);
    const publish = (chunk) => {
      const text = String(chunk);
      session.output.push(text);
      if (session.output.length > 200) session.output.shift();
      for (const listener of session.listeners) listener(text);
    };
    child.onData(publish);
    child.onExit(({ exitCode }) => {
      session.closed = true;
      publish(`\r\n[连接已关闭，退出码 ${exitCode}]\r\n`);
      fs.rm(keyFile, { force: true }, () => {});
      setTimeout(() => sshSessions.delete(sessionId), 60000).unref();
    });
    return json(res, 201, {
      sessionId,
      streamUrl: `/api/ssh/sessions/${sessionId}/events`,
    });
  }
  const sshSession = url.pathname.match(
    /^\/api\/ssh\/sessions\/([^/]+)(?:\/(events|input|resize|close))?$/,
  );
  if (sshSession) {
    const sessionId = sshSession[1],
      operation = sshSession[2],
      session = sshSessions.get(sessionId);
    if (!session)
      throw Object.assign(Error("SSH 终端会话不存在或已结束"), { status: 404 });
    if (req.method === "GET" && operation === "events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      for (const chunk of session.output)
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      const listener = (chunk) =>
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      session.listeners.add(listener);
      req.on("close", () => session.listeners.delete(listener));
      return;
    }
    if (req.method === "POST" && operation === "input") {
      const d = await body(req);
      if (!session.closed) session.process.write(String(d.input || ""));
      return json(res, 202, { ok: true });
    }
    if (req.method === "POST" && operation === "resize") {
      const d = await body(req),
        cols = Math.max(20, Number(d.cols) || 80),
        rows = Math.max(5, Number(d.rows) || 24);
      if (!session.closed) session.process.resize(cols, rows);
      return json(res, 202, { ok: true });
    }
    if (
      (req.method === "DELETE" && !operation) ||
      (req.method === "POST" && operation === "close")
    ) {
      closeSshSession(sessionId);
      return json(res, 200, { ok: true });
    }
  }
  const action = url.pathname.match(
    /^\/api\/instances\/([^/]+)\/(start|stop|delete)$/,
  );
  if (req.method === "POST" && action) {
    const d = await body(req),
      id = decodeURIComponent(action[1]),
      operation = action[2];
    try {
      if (operation === "delete") {
        try {
          await runInstanceSshCommand(
            d.provider,
            id,
            "state=/opt/gpu-fleet/storage/state.json; target=''; if test -f \"$state\"; then target=$(node -e \"try{process.stdout.write(require(process.argv[1]).target||'')}catch{}\" \"$state\" 2>/dev/null || true); fi; if test -n \"$target\" && mountpoint -q \"$target\"; then (command -v fusermount3 >/dev/null && fusermount3 -u \"$target\") || (command -v fusermount >/dev/null && fusermount -u \"$target\") || umount \"$target\"; fi; rm -f \"$state\"",
            30000,
          );
        } catch (error) {
          console.warn(`实例 ${id} 删除前断开对象存储失败，将继续释放实例：`, error.message);
        }
      }
      const adapter = provider(d.provider);
      if (operation === "delete" && typeof adapter.deleteInstance === "function")
        await adapter.deleteInstance(id);
      else await adapter.action(id, operation);
    } catch (error) {
      const text = `${error.message || ""} ${JSON.stringify(error.details || {})}`;
      if (
        operation === "start" &&
        /capacity|insufficient|out.?of.?stock|no.?stock|unavailable|not.?available|sold.?out|inventory|resource.*(?:exhaust|short)|容量不足|库存不足|无库存|资源不足/i.test(
          text,
        )
      )
        throw Object.assign(
          Error("原资源池暂时没有可用容量，请稍后重试或自行选择其他资源"),
          { status: 409, code: "capacity_unavailable", provider: d.provider },
        );
      throw error;
    }
    billingStore.recordRequestedAction(d.provider, id, operation);
    lifecycleActions.set(String(id), { action: operation, at: Date.now() });
    if (operation === "delete")
      purgeRemovedInstanceArtifacts(d.provider, id);
    return json(res, 202, {
      ok: true,
      status:
        operation === "stop"
          ? "stopping"
          : operation === "start"
            ? "provisioning"
            : "terminating",
    });
  }
  const register = url.pathname.match(/^\/api\/instances\/([^/]+)\/agent$/);
  if (req.method === "POST" && register) {
    const d = await body(req);
    if (!/^https?:\/\//.test(d.url || ""))
      throw Object.assign(Error("agent url 无效"), { status: 400 });
    agentTargets.set(decodeURIComponent(register[1]), d.url);
    return json(res, 200, { ok: true });
  }
  const telemetry = url.pathname.match(
    /^\/api\/instances\/([^/]+)\/telemetry$/,
  );
  if (req.method === "GET" && telemetry) {
    const id = decodeURIComponent(telemetry[1]),
      key = instanceTelemetryKeys.get(String(id));
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`),
      pushed = pushedTelemetry.get(key);
    if (pushed && Date.now() - pushed.at < 15000) send(pushed.data);
    else
      res.write(
        `event: error\ndata: ${JSON.stringify({ error: "平台尚未收到该实例的 GPU 遥测数据" })}\n\n`,
      );
    if (!telemetryListeners.has(key)) telemetryListeners.set(key, new Set());
    telemetryListeners.get(key).add(send);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
    req.on("close", () => {
      clearInterval(heartbeat);
      const listeners = telemetryListeners.get(key);
      listeners?.delete(send);
      if (!listeners?.size) telemetryListeners.delete(key);
    });
    return;
  }
  const benchStatus = url.pathname.match(
    /^\/api\/instances\/([^/]+)\/benchmark\/jobs\/([^/]+)$/,
  );
  if (req.method === "GET" && benchStatus) {
    const id = decodeURIComponent(benchStatus[1]),
      job = benchmarkJobs.get(decodeURIComponent(benchStatus[2]));
    if (!job || job.instanceId !== id)
      throw Object.assign(Error("benchmark job not found"), { status: 404 });
    if (
      job.status === "running" &&
      Date.now() - job.startedAt > 10 * 60 * 1000
    ) {
      job.status = "failed";
      job.error = "测试超过 10 分钟，已标记失败";
    }
    return json(res, 200, {
      id: job.id,
      status: job.status,
      mode: job.mode,
      report: job.report,
      error: job.error,
    });
  }
  const bench = url.pathname.match(/^\/api\/instances\/([^/]+)\/benchmark$/);
  if (bench) {
    const id = decodeURIComponent(bench[1]);
    if (req.method === "DELETE") {
      if (telemetryMode !== "ssh")
        throw Object.assign(Error("当前测试通道暂不支持中止"), { status: 409 });
      const result = await proxyAgentViaSsh(id, "/benchmark", "DELETE");
      sshBenchmarkRuns.delete(id);
      return json(res, 200, { ...result, status: "cancelled" });
    }
    if (req.method === "POST") {
      if (telemetryMode === "ssh") {
        const d = await body(req),
          mode = d.mode === "full" ? "full" : "quick";
        if (sshBenchmarkRuns.has(id))
          throw Object.assign(Error("该实例已有性能测试正在运行"), {
            status: 409,
          });
        sshBenchmarkRuns.set(id, { status: "running", mode, startedAt: Date.now() });
        try {
          const report = await proxyAgentViaSsh(
            id,
            `/benchmark?mode=${mode}`,
            "POST",
          );
          return json(res, 200, { report });
        } finally {
          sshBenchmarkRuns.delete(id);
        }
      }
      const d = await body(req),
        key = instanceTelemetryKeys.get(String(id)),
        pushed = pushedTelemetry.get(key),
        connected = Boolean(pushed && Date.now() - pushed.at < 15000);
      if (connected) {
        const active = [...benchmarkJobs.values()].find(
          (x) =>
            x.instanceId === id && ["queued", "running"].includes(x.status),
        );
        if (active)
          throw Object.assign(Error("该实例已有测试正在运行"), { status: 409 });
        const mode = d.mode === "full" ? "full" : "quick",
          job = {
            id: randomBytes(12).toString("hex"),
            type: "benchmark",
            params: { mode },
            instanceId: id,
            instanceKey: key,
            mode,
            status: "queued",
            createdAt: Date.now(),
          };
        benchmarkJobs.set(job.id, job);
        return json(res, 202, {
          queued: true,
          jobId: job.id,
          status: job.status,
          mode: job.mode,
        });
      }
      const report = await proxyAgent(id, "/benchmark", "POST");
      return json(res, 200, { report });
    }
    const report =
      telemetryMode === "ssh"
        ? await proxyAgentViaSsh(id, "/benchmark")
        : await proxyAgent(id, "/benchmark");
    return json(res, 200, report);
  }
  const benchPreflight = url.pathname.match(
    /^\/api\/instances\/([^/]+)\/benchmark-preflight$/,
  );
  if (req.method === "GET" && benchPreflight) {
    const id = decodeURIComponent(benchPreflight[1]),
      key = instanceTelemetryKeys.get(id),
      cached = pushedTelemetry.get(key),
      telemetry =
        cached && Date.now() - cached.at < 15000
          ? cached.data
          : await proxyAgentViaSsh(id, "/telemetry");
    const utilizations = (telemetry.gpus || [])
        .map((gpu) => Number(gpu.util))
        .filter(Number.isFinite),
      maxUtilization = utilizations.length ? Math.max(...utilizations) : null;
    return json(res, 200, {
      maxUtilization,
      highUtilization: maxUtilization !== null && maxUtilization >= 50,
      gpus: telemetry.gpus || [],
      benchmark: sshBenchmarkRuns.get(id) || { status: "idle" },
    });
  }
  const reachability = url.pathname.match(
    /^\/api\/instances\/([^/]+)\/reachability$/,
  );
  if (reachability) {
    const id = decodeURIComponent(reachability[1]),
      listed = await all("listInstances"),
      instance = listed.data.find((x) => String(x.id) === id);
    if (!instance)
      throw Object.assign(Error("实例不存在或供应商 API 暂未返回实例"), {
        status: 404,
      });
    return json(
      res,
      200,
      await probeOutboundReachabilityViaSsh(instance.provider, id),
    );
  }
  return json(res, 404, { error: "Not found" });
}
http
  .createServer(async (req, res) => {
    res.on("error", (error) =>
      console.warn("HTTP response closed:", error.message),
    );
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`),
        vendorFiles = {
          "/vendor/xterm.js": ["@xterm", "xterm", "lib", "xterm.js"],
          "/vendor/xterm.css": ["@xterm", "xterm", "css", "xterm.css"],
          "/vendor/xterm-addon-fit.js": [
            "@xterm",
            "addon-fit",
            "lib",
            "addon-fit.js",
          ],
        };
      if (req.method === "GET" && vendorFiles[url.pathname]) {
        const file = path.join(
          __dirname,
          "node_modules",
          ...vendorFiles[url.pathname],
        );
        res.writeHead(200, {
          "content-type": url.pathname.endsWith(".css")
            ? "text/css; charset=utf-8"
            : "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=86400",
        });
        return fs.createReadStream(file).pipe(res);
      }
      if (req.method === "GET" && url.pathname === "/provision/hyperstack.sh") {
        res.writeHead(200, {
          "content-type": "text/x-shellscript; charset=utf-8",
          "cache-control": "no-store",
        });
        return fs
          .createReadStream(path.join(__dirname, "agent", "hyperstack.sh"))
          .pipe(res);
      }
      if (req.method === "GET" && url.pathname === "/provision/bootstrap.sh") {
        res.writeHead(200, {
          "content-type": "text/x-shellscript; charset=utf-8",
          "cache-control": "no-store",
        });
        return fs
          .createReadStream(path.join(__dirname, "agent", "bootstrap.sh"))
          .pipe(res);
      }
      if (req.method === "GET" && url.pathname === "/provision/agent.js") {
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
        });
        return fs
          .createReadStream(path.join(__dirname, "agent", "agent.js"))
          .pipe(res);
      }
      if (req.method === "GET" && url.pathname === "/provision/telemetry.py") {
        res.writeHead(200, {
          "content-type": "text/x-python; charset=utf-8",
          "cache-control": "no-store",
        });
        return fs
          .createReadStream(path.join(__dirname, "agent", "telemetry.py"))
          .pipe(res);
      }
      if (req.method === "GET" && url.pathname === "/api/tunnel/health")
        return json(res, 200, {
          ok: true,
          service: "gpu-fleet",
          token: controlPlaneProbeToken,
        });
      const user = sessionUser(req),
        publicApi =
          /^\/api\/(?:auth\/|agent\/|provision\/|client\/capabilities$)/.test(
            url.pathname,
          );
      if (url.pathname.startsWith("/api/")) {
        if (CLIENT_MODE === "web" && !publicApi && !user)
          return json(res, 401, {
            error: "请先登录",
            code: "authentication_required",
          });
        req.user = user;
        return await api(req, res, url);
      }
      if (
        CLIENT_MODE === "web" &&
        (url.pathname === "/" || url.pathname === "/index.html") &&
        !user
      ) {
        res.writeHead(302, {
          location: `/auth.html?next=${encodeURIComponent(url.pathname + url.search)}`,
          "cache-control": "no-store",
        });
        return res.end();
      }
      if (CLIENT_MODE === "web" && url.pathname === "/auth.html" && user) {
        const next = url.searchParams.get("next"),
          target =
            next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
        res.writeHead(302, { location: target, "cache-control": "no-store" });
        return res.end();
      }
      const requested =
        url.pathname === "/"
          ? "index.html"
          : decodeURIComponent(url.pathname.slice(1));
      const file = path.resolve(root, requested);
      if (
        !file.startsWith(path.resolve(root) + path.sep) &&
        file !== path.join(root, "index.html")
      )
        return json(res, 403, { error: "Forbidden" });
      const stat = await fs.promises.stat(file).catch(() => null);
      if (!stat?.isFile()) return json(res, 404, { error: "Not found" });
      const type =
        {
          ".html": "text/html; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
        }[path.extname(file)] || "application/octet-stream";
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      const status = e.status || (e instanceof ProviderError ? e.status : 500);
      if (!res.destroyed && !res.writableEnded)
        json(res, status, {
          error: e.message,
          code: e.code,
          provider: e.provider,
          details:
            process.env.NODE_ENV === "development" ? e.details : undefined,
        });
    }
  })
  .listen(PORT, HOST, () => {
    console.log(`Fast GPU Console (${CLIENT_MODE}): http://${HOST}:${PORT}`);
    if (telemetryMode === "named-tunnel" && process.env.BASE_URL)
      void configureNamedTunnel(process.env.BASE_URL).catch((error) => {
        namedTunnelState = {
          ...namedTunnelState,
          state: "failed",
          error: error.message,
        };
        console.error("Named Tunnel 自动恢复失败：", error.message);
      });
    setTimeout(() => {
      void all("listInstances")
        .then((result) => reconcileProviderInventory(result))
        .catch((error) =>
          console.error("启动后实例与凭据对账失败：", error.message),
        );
    }, 1000).unref?.();
  });
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    for (const key of [...sshTelemetrySessions.keys()]) stopSshTelemetry(key);
    try {
      cloudflareLoginProcess?.kill();
      namedTunnelProcess?.kill();
    } catch {}
    process.exit(0);
  });
