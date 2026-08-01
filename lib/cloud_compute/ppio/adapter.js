const { NGC_IMAGE, providerEnvironmentVariables, serviceUrl } = require('../../provisioning');
const { ppioStartupCommand } = require('./startup');
const { ProviderError, call, normalizeStatus, providerProvisionProgress, authRequired, mapLimit } = require('../common/http');

const ppioPriceToCny = value => Number(value || 0) / 100000;

class PpioAdapter {
  constructor(env) { this.env=env;this.name='PPIO 派欧云'; this.base=env.PPIO_API_BASE || 'https://api.ppio.com'; this.token=env.PPIO_API_KEY;this.offerCache=null;this.offerLoading=null; }
  headers() { return { authorization:`Bearer ${authRequired(this.name,this.token,'PPIO_API_KEY')}`, 'content-type':'application/json' }; }
  async listBaseOffers() { const r=await call(this.name,this.base,'/gpu-instance/openapi/v1/products',{headers:this.headers()}); return (r.data||[]).map(p=>{const regions=Array.isArray(p.regions)?p.regions:[];return{id:`ppio:${p.id}`,provider:'ppio',providerName:this.name,productId:p.id,gpu:p.name,gpuCount:1,cpu:p.cpuPerGpu,ram:p.memoryPerGpu,diskMin:p.minRootFS,diskMax:p.maxRootFS,regions,region:regions.length?`${regions.length} 个可用地区`:'全部可用地区',price:ppioPriceToCny(p.price),priceRaw:p.price,priceUnit:'CNY/hour',billingMethods:p.billingMethods,source:'live'}}); }
  async listClusters(){const r=await call(this.name,this.base,'/gpu-instance/openapi/v1/clusters',{headers:this.headers()});return r.data||[];}
  async listOffers(){return this.listBaseOffers();}
  async listOffersWithRegions(force=false){if(!force&&this.offerCache&&Date.now()-this.offerCache.at<30000)return this.offerCache.data;if(this.offerLoading)return this.offerLoading;this.offerLoading=(async()=>{const [products,clusters]=await Promise.all([this.listBaseOffers(),this.listClusters()]);const clusterResults=await mapLimit(clusters,5,async cluster=>{try{const r=await call(this.name,this.base,'/gpu-instance/openapi/v1/products',{headers:this.headers(),query:{clusterId:cluster.id,gpuNum:1}});return{cluster,products:r.data||[]}}catch(error){return{cluster,products:[],error:error.message}}});for(const product of products){product.regionalOffers=clusterResults.map(({cluster,products:items,error})=>{const p=items.find(x=>x.id===product.productId);return{clusterId:cluster.id,region:cluster.name,supported:Boolean(p),inventory:error?'unknown':p?.inventoryState||'none',deployable:Boolean(p?.availableDeploy),available:Boolean(p)&&p.inventoryState!=='none',price:ppioPriceToCny(p?.price),priceRaw:p?.price,error}}).filter(x=>x.supported||x.error);product.regions=product.regionalOffers.map(x=>x.region);product.region=`${product.regionalOffers.length} 个可用地区`;}this.offerCache={at:Date.now(),data:products};return products;})();try{return await this.offerLoading}finally{this.offerLoading=null}}
  async listRegionalOffers(productId){const product=(await this.listOffersWithRegions()).find(x=>x.productId===productId);if(!product)throw new ProviderError(this.name,'GPU 产品不存在',404);return product.regionalOffers;}
  async discover(){const [products,baseImages,privateImages]=await Promise.all([this.listOffers(),call(this.name,this.base,'/gpu-instance/openapi/v1/images',{headers:this.headers(),query:{type:'base',pageSize:100,pageNum:1}}),call(this.name,this.base,'/gpu-instance/openapi/v1/images',{headers:this.headers(),query:{type:'private',pageSize:100,pageNum:1}})]);return{provider:'ppio',products,images:[...(baseImages.data||[]).map(x=>({...x,type:'base'})),...(privateImages.data||[]).map(x=>({...x,type:'private'}))],selectionRequired:['productId'],defaults:{imageUrl:'nvcr.io/nvidia/pytorch:26.03-py3'}}}
  async listInstances(){const r=await call(this.name,this.base,'/gpu-instance/openapi/v1/gpu/instances',{headers:this.headers(),query:{pageSize:100,pageNum:1}}),offers=this.offerCache?.data||[],normalize=value=>String(value||'').toLowerCase().replace(/nvidia|geforce|\s|-/g,'');return (r.instances||[]).map(x=>{const productId=x.productId||x.productID||x.product?.id,clusterId=x.clusterId||x.clusterID||x.cluster?.id,exact=offers.find(p=>String(p.productId)===String(productId)),byGpuAndRegion=offers.find(p=>normalize(p.gpu)===normalize(x.productName)&&(p.regionalOffers||[]).some(o=>String(o.clusterId)===String(clusterId)||o.region===x.clusterName)),product=exact||byGpuAndRegion,regional=product?.regionalOffers?.find(o=>String(o.clusterId)===String(clusterId)||o.region===x.clusterName),regionalPrice=Number(regional?.price),basePrice=Number(product?.price),price=Number.isFinite(regionalPrice)&&regionalPrice>0?regionalPrice:Number.isFinite(basePrice)&&basePrice>0?basePrice:undefined;return{id:x.id,provider:'ppio',providerName:this.name,name:x.name,status:normalizeStatus(x.status),providerStatus:x.status,provisionProgress:providerProvisionProgress(x),productId:productId||product?.productId,clusterId:clusterId||regional?.clusterId,gpu:x.productName,gpuCount:Number(x.gpuNum),image:x.imageUrl,region:x.clusterName,price,priceUnit:'CNY/hour',priceSource:regionalPrice>0?'regional-inventory':basePrice>0?'product-fallback':'unavailable',statusError:x.statusError?.message||x.statusError?.state?{state:x.statusError?.state,message:x.statusError?.message}:undefined,raw:x}});}
  async getSshConnection(id){
    const detail=await call(this.name,this.base,'/gpu-instance/openapi/v1/gpu/instance',{headers:this.headers(),query:{instanceId:id}});
    if(!detail?.id)throw Object.assign(new ProviderError(this.name,'PPIO 实例详情响应缺少实例 ID，无法确认 SSH 请求是否命中了目标实例',502),{code:'ssh_invalid_response'});
    if(String(detail.id)!==String(id))throw Object.assign(new ProviderError(this.name,`PPIO SSH 请求返回了其他实例：期望 ${id}，实际 ${detail.id}`,502),{code:'ssh_instance_mismatch'});
    const command=String(detail.sshCommand||'').trim();
    const providerError=detail.statusError?.message||detail.statusError?.state;
    if(!command||!detail.password){
      if(providerError)throw Object.assign(new ProviderError(this.name,`PPIO SSH 准备失败：${providerError}`,409,detail.statusError),{code:'ssh_provider_error'});
      throw Object.assign(new ProviderError(this.name,'实例已运行，但厂商尚未返回公网 SSH 凭据',409),{code:'ssh_pending'});
    }
    const portMatch=command.match(/(?:^|\s)-p\s*(\d+)(?:\s|$)/i);
    const targetMatch=command.match(/(?:^|\s)(?:ssh\s+)?(?:-[^\s]+\s+)*(?:([^@\s]+)@)?(\[[^\]]+\]|[a-z0-9._-]+)(?=\s|$)/i);
    const fallbackTarget=command.match(/([^@\s]+)@(\[[^\]]+\]|[a-z0-9._-]+)/i);
    const username=fallbackTarget?.[1]||targetMatch?.[1]||'root';
    const host=(fallbackTarget?.[2]||targetMatch?.[2]||'').replace(/^\[|\]$/g,'');
    const port=Number(portMatch?.[1]||22);
    if(!host)throw new ProviderError(this.name,'厂商返回的 SSH 命令格式无法识别',502,{sshCommand:command});
    if(port===22)throw new ProviderError(this.name,'厂商仍返回默认 SSH 端口，已拒绝展示；请等待非默认端口分配完成',409);
    return{provider:'ppio',command,username,host,port,password:String(detail.password),source:'provider-api'};
  }
  async resolveSshEndpoint(id,internalPort){
    const detail=await call(this.name,this.base,'/gpu-instance/openapi/v1/gpu/instance',{headers:this.headers(),query:{instanceId:id}});
    if(!detail?.id||String(detail.id)!==String(id))throw Object.assign(new ProviderError(this.name,'PPIO 返回的实例详情与 SSH 目标不匹配',502),{code:'ssh_invalid_response'});
    const mapping=(detail.portMappings||[]).find(item=>Number(item.port||item.privatePort||item.containerPort||item.internalPort)===Number(internalPort));
    if(!mapping)throw Object.assign(new ProviderError(this.name,`PPIO 尚未返回容器端口 ${internalPort} 的公网映射`,409),{code:'ssh_pending'});
    let host=String(mapping.host||mapping.address||mapping.ip||'').trim(),port=Number(mapping.publicPort||mapping.externalPort||mapping.hostPort);
    const endpoint=String(mapping.endpoint||'').trim();
    if(endpoint){try{const url=new URL(endpoint.includes('://')?endpoint:`tcp://${endpoint}`);host=host||url.hostname;port=port||Number(url.port)}catch{}}
    if(!host||!port)throw Object.assign(new ProviderError(this.name,`PPIO 返回了端口 ${internalPort} 的映射，但缺少公网地址或端口`,502,mapping),{code:'ssh_invalid_response'});
    return{host,port};
  }
  async create(o){const rootfsSize=Math.max(10,Number(o.rootfsSize)||100),sshPort=Number(this.env.FLEET_SSH_PORT||22022),envs=[...providerEnvironmentVariables(this.env).map(x=>x.key==='BASE_URL'?{...x,value:String(x.value).trim().replace(/\/+$/,'')}:x),{key:'FLEET_PROVIDER',value:'ppio'},{key:'FLEET_INSTANCE_NAME',value:o.name},{key:'FLEET_SSH_PORT',value:String(sshPort)},{key:'FLEET_SSH_PUBLIC_KEY',value:o.sshPublicKey},{key:'FLEET_SSH_USER',value:'root'},{key:'FLEET_EXPECTED_CUDA_MAJOR',value:String(o.expectedCudaMajor||13)}],command=ppioStartupCommand(this.env,{sshPublicKey:o.sshPublicKey});if(o.startupScript)envs.push({key:'FLEET_STARTUP_SCRIPT_B64',value:Buffer.from(o.startupScript,'utf8').toString('base64')});if(this.env.BASE_URL)envs.push({key:'FLEET_TELEMETRY_PUSH_URL',value:serviceUrl(this.env,'/api/agent/telemetry')});const body={name:o.name,productId:o.productId,gpuNum:o.gpuCount||1,rootfsSize,imageUrl:o.imageUrl||NGC_IMAGE,ports:`3000/http,${sshPort}/tcp`,envs,command,clusterId:o.clusterId||'',networkId:'',kind:'gpu',month:0,billingMode:o.billingMode||'onDemand',autoRenew:false,minCudaVersion:this.env.PPIO_MIN_CUDA_VERSION||`${o.expectedCudaMajor||13}.0`};const r=await call(this.name,this.base,'/gpu-instance/openapi/v1/gpu/instance/create',{method:'POST',headers:this.headers(),body});if(!r.id)throw new ProviderError(this.name,'PPIO 创建响应缺少实例 ID',502,r);return {id:r.id,provider:'ppio',name:o.name,status:'provisioning',image:body.imageUrl,provisioning:'automatic'};}
  action(id,action){const map={start:'start',stop:'stop',delete:'delete'};return call(this.name,this.base,`/gpu-instance/openapi/v1/gpu/instance/${map[action]}`,{method:'POST',headers:this.headers(),body:{instanceId:id}});}
}


module.exports = { PpioAdapter, ppioPriceToCny };
