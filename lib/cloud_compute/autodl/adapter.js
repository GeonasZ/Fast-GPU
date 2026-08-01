const { NGC_IMAGE } = require('../../provisioning');
const { autodlStartupCommand } = require('./startup');
const { ProviderError, call, normalizeStatus, authRequired } = require('../common/http');

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


module.exports = { AutoDLAdapter, AUTODL_PUBLIC_IMAGES };
