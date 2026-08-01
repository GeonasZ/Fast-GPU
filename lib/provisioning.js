function repositoryImage(env, tag) {
  const repository=String(env.FLEET_RUNTIME_IMAGE_REPOSITORY||'').trim().replace(/\/+$/,'');
  return repository ? `${repository}:${tag}` : null;
}
function resolveCuda13Image(env=process.env) {
  return env.FLEET_CONTAINER_IMAGE_CUDA13 || env.FLEET_CONTAINER_IMAGE || repositoryImage(env,'stable-cuda13') || 'nvcr.io/nvidia/pytorch:26.03-py3';
}
function resolveCuda128Image(env=process.env) {
  return env.FLEET_CONTAINER_IMAGE_CUDA128 || repositoryImage(env,'stable-cuda12') || 'nvcr.io/nvidia/pytorch:25.03-py3';
}
const NGC_IMAGE = resolveCuda13Image();
const {
  entries: s3ProviderEntries,
  provisioningEnvironment: storageProvisioningEnvironment,
} = require('./s3/registry');
const STORAGE_CONFIG_KEYS = s3ProviderEntries().flatMap((entry) =>
  entry.config.fields.map((field) => field.storageKey),
);
const CONFIG_KEYS = ['BASE_URL','STORAGE_PRIMARY_PROVIDER',...STORAGE_CONFIG_KEYS,'FLEET_AGENT_BUNDLE_URL','FLEET_AGENT_ID','FLEET_AGENT_SECRET','FLEET_PROVIDER','FLEET_INSTANCE_NAME','FLEET_TELEMETRY_PUSH_URL','FLEET_SSH_PORT','FLEET_SSH_PUBLIC_KEY','FLEET_SSH_USER'];

function shellQuote(value) { return `'${String(value).replaceAll("'", `'"'"'`)}'`; }
function config(env) {
  return {
    ...Object.fromEntries(CONFIG_KEYS.filter(k => env[k]).map(k => [k, env[k]])),
    ...storageProvisioningEnvironment(env),
  };
}
function exportsFor(values) { return Object.entries(values).map(([k,v]) => `export ${k}=${shellQuote(v)}`).join('; '); }
function providerEnvironmentVariables(env) { return Object.entries(config(env)).map(([key,value]) => ({key,value})); }
function serviceUrl(env, pathname) { if(!env.BASE_URL)throw Object.assign(new Error('缺少 BASE_URL，无法访问平台服务'),{status:503});return new URL(pathname,String(env.BASE_URL).trim()).href; }

function bootstrapCommand(env, { keepAlive=false, extra={} }={}) {
  const prefix=exportsFor({...config(env),...extra});
  const keepAliveCommand='if [ "$(ps -p 1 -o comm= | tr -d \' \')" = tini ]; then exec sleep infinity; elif command -v tini >/dev/null 2>&1; then exec tini -g -- sleep infinity; else exec sleep infinity; fi';
  return `${prefix ? `${prefix}; ` : ''}curl -fsSL --retry 5 ${shellQuote(serviceUrl(env,'/provision/bootstrap.sh'))} -o /tmp/fast-gpu-bootstrap.sh && bash /tmp/fast-gpu-bootstrap.sh${keepAlive?` && ${keepAliveCommand}`:''}`;
}

function publicControlPlaneError(value) {
  if (!value) return '未配置';
  let url; try { url=new URL(value); } catch { return 'URL 格式无效'; }
  const host=url.hostname.toLowerCase();
  if(url.protocol!=='https:')return '必须使用 HTTPS';
  if(host==='localhost'||host==='127.0.0.1'||host==='::1'||host.endsWith('.local')||host.endsWith('.example.com')||host.endsWith('.example'))return '不是云实例可访问的公网域名';
  if(/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host))return '不能使用内网地址';
  return null;
}

function validateProvisioning(provider, env) {
  return require('./provider-validation').validateProviderConfiguration(
    provider, env, publicControlPlaneError,
  );
}
module.exports={NGC_IMAGE,repositoryImage,resolveCuda13Image,resolveCuda128Image,bootstrapCommand,providerEnvironmentVariables,validateProvisioning,shellQuote,publicControlPlaneError,serviceUrl};
