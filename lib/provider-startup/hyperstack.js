const {ppioEnvs,resolveCuda13Image,resolveCuda128Image,shellQuote}=require('../provisioning');

function hyperstackStartup(env,options) {
  const values=Object.fromEntries(ppioEnvs(env).map(({key,value})=>[key,value]));
  values.FLEET_SSH_PORT='22';
  values.FLEET_SSH_PUBLIC_KEY=options.sshPublicKey;
  values.FLEET_SSH_USER=env.HYPERSTACK_IMAGE_USER;
  values.FLEET_ALLOW_CUDA128_FALLBACK=options.allowCuda128Fallback?'1':'0';
  values.FLEET_EXPECTED_CUDA_MAJOR=String(options.expectedCudaMajor||13);
  if(options.startupScript)values.FLEET_STARTUP_SCRIPT_B64=Buffer.from(options.startupScript,'utf8').toString('base64');
  if(options.startupDownloads?.length)values.FLEET_STARTUP_DOWNLOADS_B64=Buffer.from(JSON.stringify(options.startupDownloads),'utf8').toString('base64');
  if(options.provisionToken)values.FLEET_PROVISION_TOKEN=options.provisionToken;
  values.FLEET_PROVISION_STATUS_URL=new URL('/api/provision/hyperstack-status',env.FLEET_BOOTSTRAP_URL).href;
  values.FLEET_CONTAINER_IMAGE_CUDA13=resolveCuda13Image(env);
  values.FLEET_CONTAINER_IMAGE_CUDA128=resolveCuda128Image(env);
  if(options.imageUrl)values[options.expectedCudaMajor===12?'FLEET_CONTAINER_IMAGE_CUDA128':'FLEET_CONTAINER_IMAGE_CUDA13']=options.imageUrl;
  const exports=Object.entries(values).filter(([,value])=>value!==undefined&&value!==null).map(([key,value])=>`export ${key}=${shellQuote(value)}`).join('; ');
  const installer=new URL('/provision/hyperstack.sh',env.FLEET_BOOTSTRAP_URL).href;
  return{
    sshPort:Number(values.FLEET_SSH_PORT),
    userData:`#!/bin/bash\nset -Eeuo pipefail\nexec > >(tee -a /var/log/fast-gpu-cloud-init.log) 2>&1\n${exports}\ncurl -fsSL --retry 5 ${shellQuote(installer)} -o /tmp/fast-gpu-hyperstack.sh || { echo "Unable to download provisioning script; verify outbound Internet access" >&2; exit 20; }\nbash /tmp/fast-gpu-hyperstack.sh\n`
  };
}

module.exports={hyperstackStartup};
