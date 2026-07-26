const {ppioEnvs,resolveCuda13Image,resolveCuda128Image,shellQuote}=require('../provisioning');

function hyperstackStartup(env,options) {
  const values=Object.fromEntries(ppioEnvs(env).map(({key,value})=>[key,value]));
  values.FLEET_SSH_PORT='22';
  values.FLEET_SSH_PUBLIC_KEY=options.sshPublicKey;
  values.FLEET_SSH_USER=env.HYPERSTACK_IMAGE_USER;
  values.TAILSCALE_AUTH_KEY=env.TAILSCALE_AUTH_KEY;
  values.FLEET_TAILSCALE_HOSTNAME=`${options.name||'gpu-fleet'}-${String(options.provisionToken||Date.now()).slice(-8)}`
    .toLowerCase().replace(/[^a-z0-9-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,63);
  values.FLEET_ALLOW_CUDA128_FALLBACK=options.allowCuda128Fallback?'1':'0';
  values.FLEET_EXPECTED_CUDA_MAJOR=String(options.expectedCudaMajor||13);
  if(options.provisionToken)values.FLEET_PROVISION_TOKEN=options.provisionToken;
  values.FLEET_PROVISION_STATUS_URL=new URL('/api/provision/hyperstack-status',env.FLEET_BOOTSTRAP_URL).href;
  values.FLEET_CONTAINER_IMAGE_CUDA13=resolveCuda13Image(env);
  values.FLEET_CONTAINER_IMAGE_CUDA128=resolveCuda128Image(env);
  if(options.imageUrl)values[options.expectedCudaMajor===12?'FLEET_CONTAINER_IMAGE_CUDA128':'FLEET_CONTAINER_IMAGE_CUDA13']=options.imageUrl;
  const exports=Object.entries(values).filter(([,value])=>value!==undefined&&value!==null).map(([key,value])=>`export ${key}=${shellQuote(value)}`).join('; ');
  const installer=new URL('/provision/hyperstack.sh',env.FLEET_BOOTSTRAP_URL).href;
  return{
    sshPort:Number(values.FLEET_SSH_PORT),
    userData:`#!/bin/bash\nset -Eeuo pipefail\nexec > >(tee -a /var/log/gpu-fleet-cloud-init.log) 2>&1\n${exports}\ncurl -fsSL --retry 5 ${shellQuote(installer)} -o /tmp/gpu-fleet-hyperstack.sh || { echo "Unable to download provisioning script; verify outbound Internet access" >&2; exit 20; }\nbash /tmp/gpu-fleet-hyperstack.sh\n`
  };
}

module.exports={hyperstackStartup};
