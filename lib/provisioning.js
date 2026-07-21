const NGC_IMAGE = process.env.FLEET_CONTAINER_IMAGE || 'nvcr.io/nvidia/pytorch:26.03-py3';
const CONFIG_KEYS = ['BASE_URL','S3_ENDPOINT','S3_BUCKET','S3_PREFIX','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY','FLEET_AGENT_BUNDLE_URL','FLEET_AGENT_TOKEN'];

function shellQuote(value) { return `'${String(value).replaceAll("'", `'"'"'`)}'`; }
function config(env) { return Object.fromEntries(CONFIG_KEYS.filter(k => env[k]).map(k => [k, env[k]])); }
function exportsFor(values) { return Object.entries(values).map(([k,v]) => `export ${k}=${shellQuote(v)}`).join('; '); }
function ppioEnvs(env) { return Object.entries(config(env)).map(([key,value]) => ({key,value})); }
function serviceUrl(env, pathname) { if(!env.BASE_URL)throw Object.assign(new Error('缺少 BASE_URL，无法访问平台服务'),{status:503});return new URL(pathname,String(env.BASE_URL).trim()).href; }

function bootstrapCommand(env, { keepAlive=false, extra={} }={}) {
  const prefix=exportsFor({...config(env),...extra});
  return `${prefix ? `${prefix}; ` : ''}curl -fsSL --retry 5 ${shellQuote(serviceUrl(env,'/provision/bootstrap.sh'))} -o /tmp/gpu-fleet-bootstrap.sh && bash /tmp/gpu-fleet-bootstrap.sh${keepAlive?' && exec sleep infinity':''}`;
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
  const errors=[]; if(!env.BASE_URL)errors.push('BASE_URL');else{const issue=publicControlPlaneError(env.BASE_URL);if(issue)errors.push(`公网 HTTPS BASE_URL（${issue}）`)}
  if(env.S3_BUCKET && (!env.S3_ENDPOINT||!env.S3_ACCESS_KEY_ID||!env.S3_SECRET_ACCESS_KEY))errors.push('完整 S3 配置');
  if(provider==='hyperstack'){
    if(!env.HYPERSTACK_ENVIRONMENT&&!env.HYPERSTACK_ENVIRONMENTS)errors.push('HYPERSTACK_ENVIRONMENT(S)');
    if(!env.HYPERSTACK_KEY_NAME)errors.push('HYPERSTACK_KEY_NAME');
    if(!env.HYPERSTACK_IMAGE_NAME)errors.push('HYPERSTACK_IMAGE_NAME');
    if(!env.HYPERSTACK_AGENT_CIDR)errors.push('HYPERSTACK_AGENT_CIDR');
  }
  return errors;
}
module.exports={NGC_IMAGE,bootstrapCommand,ppioEnvs,validateProvisioning,shellQuote,publicControlPlaneError,serviceUrl};
