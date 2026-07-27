const DEFAULT_TIMEOUT = 30000;
const {NGC_IMAGE,resolveCuda13Image,resolveCuda128Image,ppioEnvs,shellQuote,serviceUrl}=require('./provisioning');
const {ppioStartupCommand}=require('./provider-startup/ppio');
const {autodlStartupCommand}=require('./provider-startup/autodl');
const {runpodStartupCommand}=require('./provider-startup/runpod');
const {hyperstackStartup}=require('./provider-startup/hyperstack');

class ProviderError extends Error {
  constructor(provider, message, status = 502, details) {
    super(message); this.name = 'ProviderError'; this.provider = provider; this.status = status; this.details = details;
  }
}

async function call(provider, base, pathname, { method = 'GET', headers = {}, body, query } = {}) {
  const url = new URL(pathname, base);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  try {
    const response = await fetch(url, { method, headers: { accept: 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
    const text = await response.text(); let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 1000) }; }
    if (!response.ok) {const reason=data?.reason||data?.data?.message||data?.data?.reason||data?.error?.message||data?.message||data?.msg||data?.error;console.error(`${provider} API 请求失败`,response.status,JSON.stringify(data));throw new ProviderError(provider, `${provider} API ${response.status}${reason?`: ${typeof reason==='string'?reason:JSON.stringify(reason)}`:''}`, response.status, data);}
    if (data?.code && !['Success', 0, 200].includes(data.code)) throw new ProviderError(provider, data.message || data.msg || `${provider} API error`, 502, data);
    return data;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(provider, error.name === 'AbortError' ? `${provider} API timeout` : error.message, 502);
  } finally { clearTimeout(timer); }
}

const normalizeStatus = value => ({ Running:'running', Stopped:'stopped', Starting:'provisioning', Initializing:'provisioning', PullingImage:'provisioning', Pending:'provisioning', RUNNING:'running', ACTIVE:'running', EXITED:'stopped', SHUTOFF:'stopped', SHUTDOWN:'stopped', HIBERNATED:'stopped', CREATING:'provisioning', BUILD:'provisioning', PENDING:'provisioning', TERMINATED:'terminated', running:'running', exited:'stopped', stopped:'stopped', shutdown:'stopped', pending:'provisioning', toCreate:'provisioning', creating:'provisioning', pulling:'provisioning', toStart:'provisioning', starting:'provisioning', toRestart:'provisioning', restarting:'provisioning', toReset:'provisioning', resetting:'provisioning', migrating:'provisioning', toStop:'stopping', stopping:'stopping', toRemove:'terminating', removing:'terminating', removed:'terminated' }[value] || String(value || 'unknown').toLowerCase());
function providerProvisionProgress(instance){
  const source=instance.imagePullProgress||instance.pullProgress||instance.progress||instance.statusProgress||{};
  const loaded=Number(source.loadedBytes??source.currentBytes??source.downloadedBytes??instance.downloadedBytes);
  const total=Number(source.totalBytes??source.sizeBytes??instance.totalBytes);
  let percent=Number(source.percent??source.percentage??instance.progressPercent);
  if(!Number.isFinite(percent)&&Number.isFinite(loaded)&&Number.isFinite(total)&&total>0)percent=loaded/total*100;
  const state=String(source.state||source.phase||instance.status||'');
  const message=String(source.message||instance.statusMessage||instance.statusDetail||instance.message||'');
  const pulling=/pull|download|image/i.test(`${state} ${message}`);
  if(!pulling&&!Number.isFinite(percent)&&!Number.isFinite(loaded))return undefined;
  return{phase:pulling?'pulling_image':state||'provisioning',label:pulling?'正在拉取容器镜像':'正在初始化',percent:Number.isFinite(percent)?Math.max(0,Math.min(100,percent)):undefined,loadedBytes:Number.isFinite(loaded)?loaded:undefined,totalBytes:Number.isFinite(total)?total:undefined,message:message||undefined};
}
const authRequired = (name, value, envName) => { if (!value) throw new ProviderError(name, `缺少服务端环境变量 ${envName}`, 503); return value; };
const ppioPriceToCny = value => Number(value || 0) / 100000;
async function mapLimit(items,limit,fn){const out=new Array(items.length);let next=0;await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const i=next++;out[i]=await fn(items[i],i)}}));return out;}

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
  async create(o){const rootfsSize=Math.max(10,Number(o.rootfsSize)||100),sshPort=Number(this.env.FLEET_SSH_PORT||22022),envs=[...ppioEnvs(this.env).map(x=>x.key==='BASE_URL'?{...x,value:String(x.value).trim().replace(/\/+$/,'')}:x),{key:'FLEET_PROVIDER',value:'ppio'},{key:'FLEET_INSTANCE_NAME',value:o.name},{key:'FLEET_SSH_PORT',value:String(sshPort)},{key:'FLEET_SSH_PUBLIC_KEY',value:o.sshPublicKey},{key:'FLEET_SSH_USER',value:'root'},{key:'FLEET_EXPECTED_CUDA_MAJOR',value:String(o.expectedCudaMajor||13)}],command=ppioStartupCommand(this.env,{sshPublicKey:o.sshPublicKey});if(o.startupScript)envs.push({key:'FLEET_STARTUP_SCRIPT_B64',value:Buffer.from(o.startupScript,'utf8').toString('base64')});if(o.startupDownloads?.length)envs.push({key:'FLEET_STARTUP_DOWNLOADS_B64',value:Buffer.from(JSON.stringify(o.startupDownloads),'utf8').toString('base64')});if(this.env.BASE_URL)envs.push({key:'FLEET_TELEMETRY_PUSH_URL',value:serviceUrl(this.env,'/api/agent/telemetry')});const body={name:o.name,productId:o.productId,gpuNum:o.gpuCount||1,rootfsSize,imageUrl:o.imageUrl||NGC_IMAGE,ports:`3000/http,${sshPort}/tcp`,envs,command,clusterId:o.clusterId||'',networkId:'',kind:'gpu',month:0,billingMode:o.billingMode||'onDemand',autoRenew:false,minCudaVersion:this.env.PPIO_MIN_CUDA_VERSION||`${o.expectedCudaMajor||13}.0`};const r=await call(this.name,this.base,'/gpu-instance/openapi/v1/gpu/instance/create',{method:'POST',headers:this.headers(),body});if(!r.id)throw new ProviderError(this.name,'PPIO 创建响应缺少实例 ID',502,r);return {id:r.id,provider:'ppio',name:o.name,status:'provisioning',image:body.imageUrl,provisioning:'automatic'};}
  action(id,action){const map={start:'start',stop:'stop',delete:'delete'};return call(this.name,this.base,`/gpu-instance/openapi/v1/gpu/instance/${map[action]}`,{method:'POST',headers:this.headers(),body:{instanceId:id}});}
}

function autoDLCudaMin(image){
  const values=[image?.cudaMin,image?.cuda_v_from,image?.cuda_version,image?.cudaVersion,image?.cuda];
  for(const value of values){
    const number=Number(value);
    if(Number.isFinite(number)&&number>=100&&number<1000)return Math.trunc(number);
    if(Number.isFinite(number)&&number>=10&&number<100){
      const major=Math.trunc(number),minor=Math.round((number-major)*10);
      return major*10+minor;
    }
  }
  const text=[image?.image_name,image?.name,image?.imageName].filter(Boolean).join(' ');
  const match=text.match(/cuda(?:\s*gl)?\s*(\d{2})[._](\d{1,2})/i);
  return match?Number(match[1])*10+Number(match[2]):undefined;
}
const AUTODL_PUBLIC_IMAGES=[
  ['base-image-12be412037','PyTorch','CUDA 11.1 · Ubuntu 18.04 · Python 3.8 · Torch 1.9.0'],
  ['base-image-u9r24vthlk','PyTorch','CUDA 11.3 · Ubuntu 20.04 · Python 3.8 · Torch 1.10.0'],
  ['base-image-l374uiucui','PyTorch','CUDA 11.3 · Ubuntu 20.04 · Python 3.8 · Torch 1.11.0'],
  ['base-image-l2t43iu6uk','PyTorch','CUDA 11.8 · Ubuntu 20.04 · Python 3.8 · Torch 2.0.0'],
  ['base-image-0gxqmciyth','TensorFlow','CUDA 11.2 · Ubuntu 18.04 · Python 3.8 · TensorFlow 2.5.0'],
  ['base-image-uxeklgirir','TensorFlow','CUDA 11.2 · Ubuntu 20.04 · Python 3.8 · TensorFlow 2.9.0'],
  ['base-image-4bpg0tt88l','TensorFlow','CUDA 11.4 · Python 3.8 · TensorFlow 1.15.5'],
  ['base-image-mbr2n4urrc','Miniconda','CUDA 11.6 · Ubuntu 20.04 · Python 3.8'],
  ['base-image-qkkhitpik5','Miniconda','CUDA 10.2 · Ubuntu 18.04 · Python 3.8'],
  ['base-image-h041hn36yt','Miniconda','CUDA 11.1 · Ubuntu 18.04 · Python 3.8'],
  ['base-image-7bn8iqhkb5','Miniconda','CUDA GL 11.3 · Ubuntu 20.04 · Python 3.8'],
  ['base-image-l2843iu23k','TensorRT','CUDA 11.8 · Ubuntu 20.04 · Python 3.8 · TensorRT 8.5.1'],
].map(([id,framework,name])=>{const image={id,image_uuid:id,name,framework,source:'official'};return{...image,cudaMin:autoDLCudaMin(image)}});
const AUTODL_PRODUCTS=[
  ['h800','H800 80G 通用型',['H800']],
  ['v-48g','4090 48G 通用型',['RTX 4090','4090']],
  ['pro6000-p','RTX PRO 6000 96G 性能型',['RTX PRO 6000','PRO 6000']],
  ['v-32g-p','4080(S) 32G 性能型',['RTX 4080','4080','4080S']],
  ['v-48g-350w','3090 48G 通用型',['RTX 3090','3090']],
  ['5090-p','5090 32G 性能型',['RTX 5090','5090']],
  ['4090D','4090D 通用型',['RTX 4090 D','RTX 4090D','4090D']],
].map(([id,name,stockNames])=>({id,name,stockNames}));
const AUTODL_REGIONS=[
  ['westDC2','西北企业区'],['westDC3','西北B区'],
  ['beijingDC1','北京A区'],['beijingDC2','北京B区'],
  ['beijingDC4','L20专区'],['beijingDC3','V100专区'],
  ['neimengDC1','内蒙A区'],['foshanDC1','佛山区'],
  ['chongqingDC1','重庆A区'],['yangzhouDC1','3090专区'],
  ['neimengDC3','内蒙B区'],
];

class AutoDLAdapter {
  constructor(env){this.env=env;this.name='AutoDL';this.base=env.AUTODL_API_BASE||'https://api.autodl.com';this.webMarketBase=env.AUTODL_WEB_MARKET_BASE||'https://www.autodl.com';this.webMarketPath=String(env.AUTODL_WEB_MARKET_PATH||'').trim();this.token=env.AUTODL_TOKEN;this.image=env.AUTODL_IMAGE_UUID;this.bootstrap=env.BASE_URL;this.stockCache=null;}
  headers(){return {authorization:authRequired(this.name,this.token,'AUTODL_TOKEN'),'content-type':'application/json'};}
  async listGpuStock(force=false){
    if(!force&&this.stockCache&&Date.now()-this.stockCache.at<30000)return this.stockCache.data;
    const results=await Promise.allSettled(AUTODL_REGIONS.map(async([regionSign,region])=>{
      const response=await call(this.name,this.base,'/api/v1/dev/machine/region/gpu_stock',{method:'POST',headers:this.headers(),body:{region_sign:regionSign}});
      return{regionSign,region,rows:response.data||[]};
    }));
    const data=[];
    for(const result of results)if(result.status==='fulfilled')for(const row of result.value.rows)for(const[gpu,stock]of Object.entries(row||{}))data.push({gpu,region:result.value.region,regionSign:result.value.regionSign,idle:Number(stock?.idle_gpu_num)||0,total:Number(stock?.total_gpu_num)||0});
    if(!data.length)throw new ProviderError(this.name,'AutoDL 库存接口没有返回可用地区数据',502);
    this.stockCache={at:Date.now(),data};
    return data;
  }
  async listOffers(force=false){
    authRequired(this.name,this.token,'AUTODL_TOKEN');
    let live=[],stock=[];
    if(this.webMarketPath)try{live=await this.listExperimentalWebOffers()}catch{}
    try{stock=await this.listGpuStock(force)}catch{}
    const byProduct=new Map();
    for(const offer of live){
      const key=String(offer.productId);
      if(!byProduct.has(key)||byProduct.get(key).price>offer.price)byProduct.set(key,offer);
    }
    const catalog=AUTODL_PRODUCTS.map(product=>{
      const current=byProduct.get(product.id);
      const normalize=value=>String(value||'').toLowerCase().replace(/nvidia|geforce|rtx|\s|[-_()]/g,'');
      const matches=stock.filter(item=>product.stockNames.some(name=>{const expected=normalize(name),actual=normalize(item.gpu);return actual===expected||actual.includes(expected)||expected.includes(actual)}));
      const idle=matches.reduce((sum,item)=>sum+item.idle,0),total=matches.reduce((sum,item)=>sum+item.total,0),regions=[...new Set(matches.filter(item=>item.idle>0).map(item=>item.regionSign))];
      const stockKnown=matches.length>0,available=stockKnown?idle>0:true;
      return{id:`autodl:${product.id}`,provider:'autodl',providerName:this.name,productId:product.id,gpu:current?.gpu||product.name,gpuCount:1,region:current?.region||(regions.length?`${regions.length} 个有库存地区`:'由 AutoDL 调度'),regions:regions.length?regions:undefined,price:current?.price??null,priceUnit:'CNY/hour',available,deployable:available,inventory:stockKnown?(available?'normal':'none'):'unknown',stockIdle:stockKnown?idle:undefined,stockTotal:stockKnown?total:undefined,stockSource:stockKnown?'autodl-gpu-stock':undefined,source:current?'live':'official-catalog',note:stockKnown?`AutoDL 库存接口：空闲 ${idle} / 总计 ${total}`:'AutoDL 库存接口未返回该型号；创建时再次确认'};
    });
    const known=new Set(catalog.map(offer=>offer.productId));
    return [...catalog,...live.filter(offer=>!known.has(String(offer.productId))).map(offer=>({...offer,id:`autodl:${offer.productId}:${offer.region}`,provider:'autodl',providerName:this.name,gpuCount:1,available:true}))];
  }
  async discover(){const r=await call(this.name,this.base,'/api/v1/dev/instance/pro/image/private/list',{method:'POST',headers:this.headers(),body:{page_index:1,page_size:100}}),accountImages=(r.data?.list||[]).map(image=>({...image,source:'account',cudaMin:autoDLCudaMin(image)}));return{provider:'autodl',products:AUTODL_PRODUCTS,images:[...accountImages,...AUTODL_PUBLIC_IMAGES],accountImages,officialImages:AUTODL_PUBLIC_IMAGES,selectionRequired:['productId','imageUuid','cudaMin'],note:'账号镜像由 API 实时返回；官方基础镜像来自 Pro API 附录。社区镜像需先在 AutoDL 控制台共享或保存到当前账号。'}}
  async listPrivateImages(){const r=await call(this.name,this.base,'/api/v1/dev/instance/pro/image/private/list',{method:'POST',headers:this.headers(),body:{page_index:1,page_size:100}});return r.data?.list||[];}
  async resolveImageUuid(requested){if(requested)return requested;if(this.image)return this.image;const images=await this.listPrivateImages();const wanted=(this.env.AUTODL_IMAGE_NAME||'fast-gpu-cuda13').toLowerCase();const text=x=>String(x.image_name||x.name||x.imageName||'').toLowerCase();const state=x=>String(x.status||x.image_status||x.state||'').toLowerCase();const usable=x=>!state(x)||['finished','success','available','ready','normal'].some(s=>state(x).includes(s));const match=images.find(x=>text(x)===wanted&&usable(x))||images.find(x=>text(x).includes(wanted)&&usable(x));if(!match){const names=images.map(text).filter(Boolean).slice(0,8).join(', ');throw new ProviderError(this.name,`AutoDL 找不到可用私有镜像“${this.env.AUTODL_IMAGE_NAME||'fast-gpu-cuda13'}”。请先按 README 制作并保存一次，或配置 AUTODL_IMAGE_UUID。${names?` 当前镜像：${names}`:''}`,503)}return match.image_uuid||match.uuid||match.id;}
  async listInstances(){const r=await call(this.name,this.base,'/api/v1/dev/instance/pro/list',{method:'POST',headers:this.headers(),body:{page_index:1,page_size:100}});return (r.data?.list||[]).map(x=>({id:x.uuid,provider:'autodl',providerName:this.name,name:x.name,status:normalizeStatus(x.status),providerStatus:x.status,providerSubStatus:x.sub_status||'',gpu:x.gpu_spec_uuid,gpuCount:x.req_gpu_amount,region:x.region_name,sshHost:x.proxy_host,sshPort:Number(x.ssh_port)||undefined,sshUser:'root',raw:x}));}
  async resolveSshEndpoint(id){
    const snapshot=await this.instanceSnapshot(id),host=snapshot.proxy_host,port=Number(snapshot.ssh_port);
    return{host,port:Number.isInteger(port)&&port>0?port:undefined};
  }
  async confirmHostAssignment(id){
    const timeout=Math.max(1,Number(this.env.AUTODL_CREATE_CONFIRM_TIMEOUT_MS)||60000),poll=Math.max(10,Number(this.env.AUTODL_CREATE_CONFIRM_POLL_MS)||2000),deadline=Date.now()+timeout;
    let last;
    while(Date.now()<deadline){
      last=(await this.listInstances()).find(instance=>String(instance.id)===String(id));
      const rawStatus=String(last?.providerStatus||'').toLowerCase();
      if(last?.status==='running')return last;
      if(last&&['failed','error','removed','removing','terminated'].some(state=>rawStatus.includes(state)))throw Object.assign(new ProviderError(this.name,`AutoDL 创建失败：${last.providerSubStatus||last.providerStatus}`,409,last.raw),{code:'autodl_create_failed'});
      await new Promise(resolve=>setTimeout(resolve,poll));
    }
    const final=(await this.listInstances()).find(instance=>String(instance.id)===String(id));
    if(final?.status==='running')return final;
    try{await this.action(id,'stop')}catch{}
    try{await this.action(id,'delete')}catch{}
    throw Object.assign(new ProviderError(this.name,`AutoDL 在限定时间内未进入运行状态，创建已取消并释放${final?.providerStatus?`（状态：${final.providerStatus}${final.providerSubStatus?` / ${final.providerSubStatus}`:''}）`:''}`,409,{instanceId:id,status:final?.providerStatus,subStatus:final?.providerSubStatus}),{code:'autodl_no_compatible_host'});
  }
  async cancelPendingInstance(id){try{await this.action(id,'stop')}catch{}try{await this.action(id,'delete')}catch{}}
  async create(o){const image=await this.resolveImageUuid(o.imageUuid),cudaMin=Number(o.cudaMin);if(!Number.isInteger(cudaMin)||cudaMin<100||cudaMin>=1000)throw new ProviderError(this.name,'所选 AutoDL 镜像缺少有效的最低 CUDA 版本，已停止创建以避免发送错误版本',400);const body={data_center_list:o.regions,req_gpu_amount:o.gpuCount||1,expand_system_disk_by_gb:o.expandDisk||100,gpu_spec_uuid:o.productId,image_uuid:image,cuda_v_from:cudaMin,instance_name:o.name,start_command:autodlStartupCommand(this.env,{sshPublicKey:o.sshPublicKey})};const r=await call(this.name,this.base,'/api/v1/dev/instance/pro/create',{method:'POST',headers:this.headers(),body});if(!r.data)throw new ProviderError(this.name,'AutoDL 创建响应缺少实例 ID',502,r);const id=String(r.data),assigned=await this.confirmHostAssignment(id);let snapshot;try{snapshot=await this.instanceSnapshot(id)}catch(error){await this.cancelPendingInstance(id);throw Object.assign(new ProviderError(this.name,`AutoDL 无法核验实例实际价格：${error.message}`,502),{code:'autodl_price_unavailable'})}const actualPrice=Number(snapshot.payg_price)/1000;if(!Number.isFinite(actualPrice)||actualPrice<=0){await this.cancelPendingInstance(id);throw Object.assign(new ProviderError(this.name,'AutoDL 未返回可验证的实际时价，创建已自动取消',409),{code:'autodl_price_unavailable'})}return{id,provider:'autodl',name:o.name,status:assigned.status,image,region:assigned.region,price:actualPrice,priceUnit:'CNY/hour',priceSource:'provider-snapshot',provisioning:'automatic-native'};}
  async getSshConnection(id){const instance=(await this.listInstances()).find(item=>String(item.id)===String(id));if(!instance)throw Object.assign(new ProviderError(this.name,'AutoDL 实例不存在或 API 暂未返回实例',404),{code:'ssh_provider_error'});if(instance.status!=='running')throw Object.assign(new ProviderError(this.name,`AutoDL 实例尚未运行（${instance.providerStatus||'unknown'}${instance.providerSubStatus?` / ${instance.providerSubStatus}`:''}）`,409),{code:'ssh_pending'});const snapshot=await this.instanceSnapshot(id),password=snapshot.root_password,host=snapshot.proxy_host,port=Number(snapshot.ssh_port);if(!host||!port||!password)throw Object.assign(new ProviderError(this.name,'AutoDL 实例已运行，但详情接口尚未返回完整的 SSH 地址、端口和密码',409,{status:instance.providerStatus,subStatus:instance.providerSubStatus,hasHost:Boolean(host),hasPort:Boolean(port),hasPassword:Boolean(password)}),{code:'ssh_pending'});return{provider:'autodl',command:snapshot.ssh_command||`ssh -p ${port} root@${host}`,username:'root',host,port,password:String(password),source:'provider-snapshot'};}
  async listExperimentalWebOffers(){
    if(!this.webMarketPath)throw Object.assign(new ProviderError(this.name,'AutoDL 没有提供可验证的创建前报价接口',503),{code:'autodl_preflight_quote_unavailable'});
    const headers=this.headers(),body={page_index:1,page_size:100,charge_type:'payg',gpu_num:1};
    let response;
    try{response=await call(this.name,this.webMarketBase,this.webMarketPath,{method:'POST',headers,body})}
    catch(error){throw Object.assign(new ProviderError(this.name,`AutoDL 网页报价接口不可用：${error.message}`,503,error.details),{code:'autodl_web_market_unavailable'})}
    const roots=[response?.data?.list,response?.data?.result,response?.data?.machines,response?.data,response?.result,response?.machines].filter(Array.isArray);
    const rows=roots[0]||[];
    const number=value=>{const parsed=Number(String(value??'').replace(/[^\d.]/g,''));return Number.isFinite(parsed)?parsed:NaN};
    const offers=[];
    for(const row of rows){
      const skus=Array.isArray(row.sku)?row.sku:Array.isArray(row.sku_list)?row.sku_list:[row];
      for(const sku of skus){
        const price=number(sku.price??sku.payg_price??row.payg_price??row.price??row.gpu_low_price);
        const available=Number(row.gpu_idle_num??row.gpu_idle??row.idle_gpu_num??row.available_gpu??1)>0&&![0,false,'0','unavailable','sold_out'].includes(sku.enable??sku.available??true);
        const productId=String(row.gpu_spec_uuid??row.gpu_spec_id??row.spec_uuid??row.product_id??row.gpu_type??'').trim();
        if(!productId||!Number.isFinite(price)||price<=0||!available)continue;
        offers.push({productId,gpu:String(row.gpu_alias_name??row.gpu_name??row.gpu_type??productId),region:String(row.region_name??row.data_center_name??row.region??'自动调度'),regions:row.region_sign?[String(row.region_sign)]:undefined,price,priceUnit:'CNY/hour',source:'experimental-web',machineId:row.machine_id?String(row.machine_id):undefined});
      }
    }
    const unique=new Map();
    for(const offer of offers){const key=`${offer.productId}:${offer.region}`;if(!unique.has(key)||unique.get(key).price>offer.price)unique.set(key,offer)}
    if(!unique.size)throw Object.assign(new ProviderError(this.name,'AutoDL 网页报价响应中没有可验证的按量价格和库存；请改为手动选择 GPU',503,{path:this.webMarketPath}),{code:'autodl_web_market_shape_changed'});
    return [...unique.values()].sort((a,b)=>a.price-b.price);
  }
  async selectExperimentalOffer(maxPrice){
    const limit=Number(maxPrice);
    if(!Number.isFinite(limit)||limit<=0)throw new ProviderError(this.name,'最高时价必须大于 0',400);
    const offers=await this.listExperimentalWebOffers(),selected=offers.find(offer=>offer.price<=limit);
    if(!selected)throw Object.assign(new ProviderError(this.name,`当前网页报价中没有不超过 ¥${limit.toFixed(2)}/小时的可用 GPU`,409,{offers:offers.slice(0,8)}),{code:'autodl_no_offer_under_limit'});
    return selected;
  }
  async createImageImportInstance(o){
    const body={data_center_list:o.regions,req_gpu_amount:1,expand_system_disk_by_gb:0,gpu_spec_uuid:o.productId,image_uuid:o.imageUuid,cuda_v_from:Number(o.cudaMin||113),instance_name:o.name||`镜像转存-${Date.now()}`,start_command:'true'};
    const r=await call(this.name,this.base,'/api/v1/dev/instance/pro/create',{method:'POST',headers:this.headers(),body});
    if(!r.data)throw new ProviderError(this.name,'AutoDL 创建临时实例响应缺少实例 ID',502,r);
    return{id:String(r.data),provider:'autodl',name:body.instance_name,status:'provisioning',image:o.imageUuid};
  }
  async instanceStatus(id){const r=await call(this.name,this.base,'/api/v1/dev/instance/pro/status',{headers:this.headers(),query:{instance_uuid:id}});return normalizeStatus(r.data);}
  async instanceSnapshot(id){const r=await call(this.name,this.base,'/api/v1/dev/instance/pro/snapshot',{headers:this.headers(),query:{instance_uuid:id}});return r.data||{};}
  async saveInstanceImage(id,imageName){const r=await call(this.name,this.base,'/api/v1/dev/instance/pro/image/save',{method:'POST',headers:this.headers(),body:{instance_uuid:id,image_name:imageName}}),imageUuid=r.data?.image_uuid;if(!imageUuid)throw new ProviderError(this.name,'AutoDL 保存镜像响应缺少镜像 UUID',502,r);return String(imageUuid);}
  async deleteInstance(id){
    const pollMs=Math.max(10,Number(this.env.AUTODL_DELETE_POLL_MS)||2000);
    const timeoutMs=Math.max(pollMs,Number(this.env.AUTODL_DELETE_STOP_TIMEOUT_MS)||2*60*1000);
    let status;
    try{status=await this.instanceStatus(id)}catch{}
    if(!['stopped','terminated'].includes(status)){
      await this.action(id,'stop');
      const deadline=Date.now()+timeoutMs;
      while(Date.now()<deadline){
        await new Promise(resolve=>setTimeout(resolve,pollMs));
        status=await this.instanceStatus(id);
        if(['stopped','terminated'].includes(status))break;
      }
      if(!['stopped','terminated'].includes(status))throw Object.assign(new ProviderError(this.name,'AutoDL 容器关闭超时，尚未执行删除；请稍后重试',409,{instanceId:id,status}),{code:'autodl_stop_timeout'});
    }
    return this.action(id,'delete');
  }
  action(id,action){const path={start:'power_on',stop:'power_off',delete:'release'}[action];const body={instance_uuid:id};if(action==='start')body.payload='gpu';return call(this.name,this.base,`/api/v1/dev/instance/pro/${path}`,{method:'POST',headers:this.headers(),body});}
}

class RunPodAdapter {
  constructor(env){this.env=env;this.name='RunPod';this.base=env.RUNPOD_API_BASE||'https://rest.runpod.io/v1/';this.graphql=env.RUNPOD_GRAPHQL_BASE||'https://api.runpod.io/';this.token=env.RUNPOD_API_KEY;}
  headers(){return{authorization:`Bearer ${authRequired(this.name,this.token,'RUNPOD_API_KEY')}`,'content-type':'application/json'};}
  async accountBalance(){const query=`query FleetAccountBalance { myself { clientBalance } }`;const r=await call(this.name,this.graphql,'/graphql',{method:'POST',headers:this.headers(),body:{query}});if(r.errors?.length)throw new ProviderError(this.name,r.errors[0].message,502,r.errors);const amount=Number(r.data?.myself?.clientBalance);if(!Number.isFinite(amount))throw new ProviderError(this.name,'RunPod 账户响应缺少余额',502,r);return{amount,currency:'USD',source:'api'};}
  async listOffers(){const query=`query FleetGpuTypes { gpuTypes { id displayName memoryInGb lowestPrice(input: { gpuCount: 1, secureCloud: true }) { stockStatus uninterruptablePrice availableGpuCounts } } }`;const r=await call(this.name,this.graphql,'/graphql',{method:'POST',headers:this.headers(),body:{query}});if(r.errors?.length)throw new ProviderError(this.name,r.errors[0].message,502,r.errors);return(r.data?.gpuTypes||[]).filter(x=>x.id.startsWith('NVIDIA ')).map(x=>({id:`runpod:${x.id}`,provider:'runpod',providerName:this.name,productId:x.id,gpu:x.displayName||x.id,gpuCount:1,vram:x.memoryInGb,region:'Secure Cloud 自动调度',price:Number(x.lowestPrice?.uninterruptablePrice||0),priceUnit:'USD/hour',available:x.lowestPrice?.stockStatus==='High'||(x.lowestPrice?.availableGpuCounts||[]).length>0,inventory:x.lowestPrice?.stockStatus,source:'live'}));}
  async discover(){return{provider:'runpod',products:await this.listOffers(),selectionRequired:['productId'],defaults:{cloudType:'SECURE',imageName:NGC_IMAGE,cuda:'13.0',ports:['3000/http']}}}
  async listInstances(){const pods=await call(this.name,this.base,'pods',{headers:this.headers(),query:{computeType:'GPU',includeMachine:true}});return(pods||[]).filter(x=>x.desiredStatus!=='TERMINATED').map(x=>{const mappings=x.portMappings||x.runtime?.ports||{},wanted=Number(this.env.FLEET_SSH_PORT||22022),mapping=Array.isArray(mappings)?mappings.find(p=>Number(p.privatePort||p.containerPort||p.internalPort||p.port)===wanted):undefined,externalPort=Array.isArray(mappings)?Number(mapping?.publicPort||mapping?.externalPort||mapping?.hostPort):Number(mappings[String(wanted)]);return{id:x.id,provider:'runpod',providerName:this.name,name:x.name,providerRenameSupported:true,providerRenameWarning:'修改运行中的 RunPod 可能触发 Pod 重置，请先保存非持久化数据。',status:normalizeStatus(x.desiredStatus),gpu:x.gpu?.displayName||x.machine?.gpuDisplayName,gpuCount:x.gpu?.count||x.machine?.minPodGpuCount||1,region:x.machine?.dataCenterId||x.machine?.location,image:x.image,price:Number(x.adjustedCostPerHr||x.costPerHr||0),priceUnit:'USD/hour',agentUrl:`https://${x.id}-3000.proxy.runpod.net`,sshHost:x.publicIp||x.publicIP||x.machine?.publicIp,sshPort:externalPort||undefined,sshUser:'root',raw:x}});}
  async create(o){const env=Object.fromEntries(ppioEnvs(this.env).map(({key,value})=>[key,value])),sshPort=Number(this.env.FLEET_SSH_PORT||22022);env.FLEET_SSH_PORT=String(sshPort);env.FLEET_SSH_PUBLIC_KEY=o.sshPublicKey;env.FLEET_SSH_USER='root';env.FLEET_EXPECTED_CUDA_MAJOR=String(o.expectedCudaMajor||13);if(o.startupScript)env.FLEET_STARTUP_SCRIPT_B64=Buffer.from(o.startupScript,'utf8').toString('base64');if(o.startupDownloads?.length)env.FLEET_STARTUP_DOWNLOADS_B64=Buffer.from(JSON.stringify(o.startupDownloads),'utf8').toString('base64');const provisionEnv={...this.env,...env},body={name:o.name||'fast-gpu',cloudType:o.cloudType||'SECURE',computeType:'GPU',containerDiskInGb:o.rootfsSize||100,volumeInGb:o.volumeSize||100,volumeMountPath:'/workspace',imageName:o.imageUrl||NGC_IMAGE,allowedCudaVersions:[`${o.expectedCudaMajor||13}.0`],gpuCount:o.gpuCount||1,gpuTypeIds:[o.productId],gpuTypePriority:'custom',interruptible:Boolean(o.spot),globalNetworking:false,supportPublicIp:true,ports:['3000/http',`${sshPort}/tcp`],env,dockerEntrypoint:['bash','-lc'],dockerStartCmd:[runpodStartupCommand(provisionEnv,{sshPublicKey:o.sshPublicKey})],minDiskBandwidthMBps:o.minDiskBandwidthMBps||500,minDownloadMbps:o.minDownloadMbps||100};const r=await call(this.name,this.base,'pods',{method:'POST',headers:this.headers(),body});return{id:r.id,provider:'runpod',name:r.name||body.name,status:normalizeStatus(r.desiredStatus||'RUNNING'),image:r.image||body.imageName,price:Number(r.adjustedCostPerHr||r.costPerHr||0),provisioning:'automatic-container',agentUrl:`https://${r.id}-3000.proxy.runpod.net`};}
  renameInstance(id,name){return call(this.name,this.base,`pods/${encodeURIComponent(id)}/update`,{method:'POST',headers:this.headers(),body:{name}});}
  action(id,action){if(action==='delete')return call(this.name,this.base,`pods/${encodeURIComponent(id)}`,{method:'DELETE',headers:this.headers()});return call(this.name,this.base,`pods/${encodeURIComponent(id)}/${action}`,{method:'POST',headers:this.headers()});}
}

class HyperstackAdapter {
  constructor(env){this.env=env;this.name='Hyperstack';this.base=env.HYPERSTACK_API_BASE||'https://infrahub-api.nexgencloud.com/v1/';this.token=env.HYPERSTACK_API_KEY;}
  headers(){return{api_key:authRequired(this.name,this.token,'HYPERSTACK_API_KEY'),'content-type':'application/json'};}
  async configurationResources(){const [environmentResponse,keypairResponse,imageResponse]=await Promise.all([call(this.name,this.base,'core/environments',{headers:this.headers(),query:{pageSize:100}}),call(this.name,this.base,'core/keypairs',{headers:this.headers(),query:{pageSize:100}}),call(this.name,this.base,'core/images',{headers:this.headers(),query:{pageSize:100}})]);const environments=environmentResponse.environments||environmentResponse.data||[],environmentRegions=new Map(environments.map(x=>[x.name,x.region])),keypairs=keypairResponse.keypairs||keypairResponse.data||[],imageGroups=imageResponse.images||imageResponse.data||[],rawImages=imageGroups.flatMap(group=>Array.isArray(group.images)?group.images.map(image=>({...image,region_name:image.region_name||group.region_name})):group),imagesByName=new Map();for(const x of rawImages){const name=x.name||x.image_name;if(!name)continue;const regions=x.regions||x.region_names||(x.region_name?[x.region_name]:[]),existing=imagesByName.get(name);if(existing)existing.regions=[...new Set([...existing.regions,...regions])];else imagesByName.set(name,{id:x.id,name,regions:[...regions],labels:x.labels||[]})}return{environments:environments.map(x=>({id:x.id,name:x.name,region:x.region})),keypairs:keypairs.map(x=>{const environmentName=x.environment?.name||x.environment_name;return{id:x.id,name:x.name,environmentName,region:x.environment?.region||x.region||environmentRegions.get(environmentName),fingerprint:x.fingerprint}}),images:[...imagesByName.values()]};}
  async importKeypair({name,environmentName,publicKey}){const r=await call(this.name,this.base,'core/keypairs',{method:'POST',headers:this.headers(),body:{name,environment_name:environmentName,public_key:publicKey}});if(r.status===false)throw new ProviderError(this.name,r.message||'创建 SSH Keypair 失败',502,r);return r.keypair||r.keypairs?.[0]||r.data||{name,environment:{name:environmentName}};}
  async listOffers(){const [flavorResponse,priceResponse]=await Promise.all([call(this.name,this.base,'core/flavors',{headers:this.headers()}),call(this.name,this.base,'pricebook',{headers:this.headers()})]);if(flavorResponse.status===false)throw new ProviderError(this.name,flavorResponse.message||'获取 GPU flavors 失败',502,flavorResponse);const normalize=value=>String(value||'').toLowerCase().replace(/[^a-z0-9]/g,'');let configuredRegions=[];try{configuredRegions=JSON.parse(this.env.HYPERSTACK_REGIONS||'[]')}catch{}if(!configuredRegions.length&&this.env.HYPERSTACK_REGION)configuredRegions=[this.env.HYPERSTACK_REGION];const pricebook=Array.isArray(priceResponse)?priceResponse:[];const prices=new Map(pricebook.map(x=>[normalize(x.name),Number(x.value||0)]));return(flavorResponse.data||[]).flatMap(group=>(group.flavors||[]).filter(x=>x.gpu&&(!configuredRegions.length||configuredRegions.includes(x.region_name||group.region_name))).map(x=>{const region=x.region_name||group.region_name;const gpuCount=Number(x.gpu_count||1);const unitPrice=prices.get(normalize(x.gpu))||prices.get(normalize(x.name))||0;return{id:`hyperstack:${x.name}:${region}`,provider:'hyperstack',providerName:this.name,productId:x.name,gpu:x.gpu,gpuCount,cpu:Number(x.cpu||0),ram:Number(x.ram||0),disk:Number(x.disk||0),region,price:unitPrice*gpuCount,priceUnit:'USD/hour',priceSource:'pricebook',available:Boolean(x.stock_available),inventory:x.stock_available?'high':'none',deployable:Boolean(x.stock_available),supportsHibernation:!x.features?.no_hibernation,source:'live',note:'启动后自动验证 CUDA 13.2；用户允许时可降级到 CUDA 12.8'}}));}
  async discover(){return{provider:'hyperstack',products:await this.listOffers(),selectionRequired:['productId','region'],defaults:{containerImage:NGC_IMAGE},note:'cloud-init 根据宿主驱动自动选择 NGC 26.03/CUDA 13.2 或获准的 25.03/CUDA 12.8。'};}
  environmentFor(region){if(this.env.HYPERSTACK_ENVIRONMENTS){let map;try{map=JSON.parse(this.env.HYPERSTACK_ENVIRONMENTS)}catch{throw new ProviderError(this.name,'HYPERSTACK_ENVIRONMENTS 必须是 region 到 environment 的 JSON 对象',503)}if(map[region])return map[region]}return this.env.HYPERSTACK_ENVIRONMENT;}
  async listInstances(){const r=await call(this.name,this.base,'core/virtual-machines',{headers:this.headers()});if(r.status===false)throw new ProviderError(this.name,r.message||'获取实例失败',502,r);return(r.instances||[]).map(x=>{const ip=x.floating_ip||x.floatingIp||x.public_ip||x.publicIp||null,user=this.env.HYPERSTACK_IMAGE_USER;return{id:String(x.id),provider:'hyperstack',providerName:this.name,name:x.name,status:normalizeStatus(x.status),gpu:x.flavor?.gpu,gpuCount:Number(x.flavor?.gpu_count||1),region:x.environment?.region,image:x.image?.name,price:null,priceUnit:'USD/hour',ip,publicIp:Boolean(ip),accessType:'ssh',sshHost:ip||undefined,sshPort:22,sshUser:user,sshCommand:ip?`ssh -i <private-key> ${user}@${ip}`:undefined,accessMessage:ip?'Floating IP 可直接通过 SSH 访问':'正在等待 Hyperstack 分配 Floating IP',cudaProfile:'自动检测中',raw:x}});}
  async create(o){const environment=o.environmentName||this.environmentFor(o.region),keyName=o.keyName||this.env.HYPERSTACK_KEY_NAME,imageName=this.env.HYPERSTACK_IMAGE_NAME,imageUser=this.env.HYPERSTACK_IMAGE_USER;if(!environment||!keyName||!imageName||!imageUser)throw new ProviderError(this.name,'运行商配置未完成',503);if(!this.env.FLEET_BOOTSTRAP_URL)throw new ProviderError(this.name,'缺少 FLEET_BOOTSTRAP_URL，无法自动装机',503);const startup=hyperstackStartup(this.env,o),sshCidr=this.env.HYPERSTACK_AGENT_CIDR||'0.0.0.0/0';const body={count:1,environment_name:environment,flavor_name:o.productId,key_name:keyName,name:o.name||'fast-gpu',image_name:imageName,assign_floating_ip:true,security_rules:[{direction:'ingress',protocol:'tcp',port_range_min:22,port_range_max:22,ethertype:'IPv4',remote_ip_prefix:sshCidr}],user_data:startup.userData};const r=await call(this.name,this.base,'core/virtual-machines',{method:'POST',headers:this.headers(),body});if(r.status===false)throw new ProviderError(this.name,r.message||'创建 VM 失败',502);const instance=r.instances?.[0];return{id:String(instance?.id),provider:'hyperstack',name:instance?.name||body.name,status:'provisioning',image:body.image_name,publicIp:false,accessType:'ssh',sshPort:22,sshUser:imageUser,accessMessage:'正在等待 Hyperstack 分配 Floating IP',cudaProfile:o.expectedCudaMajor===12?'CUDA 12.8':o.allowCuda128Fallback?'优先 CUDA 13.2，允许降级 12.8':'必须 CUDA 13.2',provisioning:'cloud-init-container'};}
  action(id,action){if(action==='delete')return call(this.name,this.base,`core/virtual-machines/${encodeURIComponent(id)}`,{method:'DELETE',headers:this.headers()});const operation=action==='start'?'restore':'hibernate';return call(this.name,this.base,`core/virtual-machines/${encodeURIComponent(id)}/${operation}`,{headers:this.headers()});}
}
const hyperstackListInstances=HyperstackAdapter.prototype.listInstances;
HyperstackAdapter.prototype.listInstances=async function(){return hyperstackListInstances.call(this)};
const hyperstackCreate=HyperstackAdapter.prototype.create;
HyperstackAdapter.prototype.create=async function(options){this.env.FLEET_PROVIDER='hyperstack';this.env.FLEET_INSTANCE_NAME=options.name||'fast-gpu';if(this.env.BASE_URL)this.env.FLEET_TELEMETRY_PUSH_URL=serviceUrl(this.env,'/api/agent/telemetry');return hyperstackCreate.call(this,options)};
function adapters(env=process.env){return {ppio:new PpioAdapter(env),autodl:new AutoDLAdapter(env),hyperstack:new HyperstackAdapter(env),runpod:new RunPodAdapter(env)};}
module.exports={adapters,ProviderError,normalizeStatus,ppioPriceToCny,AUTODL_PUBLIC_IMAGES};
