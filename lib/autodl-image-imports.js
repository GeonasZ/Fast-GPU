const {randomUUID}=require('node:crypto');

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const imageId=image=>String(image.image_uuid||image.uuid||image.id||'');
const imageState=image=>String(image.status||image.image_status||image.state||'').toLowerCase();

function createAutoDLImageImportManager(adapter,{pollMs=5000,startTimeoutMs=15*60*1000,stopTimeoutMs=5*60*1000,imageTimeoutMs=45*60*1000}={}){
  const jobs=new Map();
  const publicJob=job=>({...job,internal:undefined});
  function update(job,phase,message,extra={}){Object.assign(job,{phase,message,updatedAt:new Date().toISOString(),...extra})}
  async function waitFor(label,timeoutMs,read,accept){
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){const value=await read();if(accept(value))return value;await wait(pollMs)}
    throw Object.assign(Error(`${label}超时`),{code:'autodl_import_timeout'});
  }
  async function stopWithoutRelease(job){
    if(!job.instanceId)return;
    try{const status=await adapter.instanceStatus(job.instanceId);if(!['stopped','terminated'].includes(status))await adapter.action(job.instanceId,'stop')}catch(error){job.stopError=error.message}
  }
  async function run(job,input){
    try{
      update(job,'selecting_offer','正在确定临时实例 GPU');
      const offer=input.selectionMode==='auto'?await adapter.selectExperimentalOffer(input.maxPrice):{productId:input.productId,gpu:input.productId,price:null,priceUnit:'CNY/hour',source:'manual'};
      job.offer=offer;
      update(job,'creating','正在创建临时实例；实例开机后会产生费用');
      const instance=await adapter.createImageImportInstance({productId:offer.productId,regions:offer.regions,imageUuid:input.sourceImageUuid,name:`image-import-${Date.now()}`});
      job.instanceId=instance.id;
      update(job,'starting','临时实例正在启动',{startedAt:new Date().toISOString()});
      await waitFor('等待临时实例启动',startTimeoutMs,()=>adapter.instanceStatus(job.instanceId),status=>status==='running');
      try{
        const snapshot=await adapter.instanceSnapshot(job.instanceId);
        const rawPrice=Number(snapshot.payg_price);
        job.actualPrice=Number.isFinite(rawPrice)?rawPrice/1000:undefined;
        if(input.selectionMode==='auto'&&Number.isFinite(job.actualPrice)&&job.actualPrice>Number(input.maxPrice)){
          throw Object.assign(Error(`实例实际价格 ¥${job.actualPrice.toFixed(3)}/小时超过上限 ¥${Number(input.maxPrice).toFixed(2)}/小时`),{code:'autodl_actual_price_over_limit'});
        }
      }catch(error){if(error.code==='autodl_actual_price_over_limit')throw error;job.priceCheckWarning=error.message}
      update(job,'stopping','实例已启动，正在关机以保存镜像');
      await adapter.action(job.instanceId,'stop');
      await waitFor('等待临时实例关机',stopTimeoutMs,()=>adapter.instanceStatus(job.instanceId),status=>status==='stopped');
      update(job,'saving','正在保存个人镜像；此时不会释放临时实例');
      job.savedImageUuid=await adapter.saveInstanceImage(job.instanceId,input.imageName);
      update(job,'waiting_image','正在等待个人镜像可用');
      await waitFor('等待镜像保存完成',imageTimeoutMs,()=>adapter.listPrivateImages(),images=>images.some(image=>imageId(image)===job.savedImageUuid&&['finished','success','available','ready','normal'].some(state=>imageState(image).includes(state))));
      update(job,'releasing','个人镜像已确认可用，正在释放临时实例');
      try{await adapter.action(job.instanceId,'delete')}
      catch(error){update(job,'cleanup_required','镜像已保存，但自动释放临时实例失败，请到 AutoDL 控制台手动释放',{status:'attention',error:error.message,completedAt:new Date().toISOString()});return}
      update(job,'completed','个人镜像已保存，临时实例已释放',{status:'completed',completedAt:new Date().toISOString()});
    }catch(error){
      await stopWithoutRelease(job);
      update(job,'failed','转存失败；临时实例不会自动释放，请检查后在 AutoDL 控制台处理',{status:'failed',error:error.message,errorCode:error.code,completedAt:new Date().toISOString()});
    }
  }
  return{
    start(input){
      const id=randomUUID(),now=new Date().toISOString(),job={id,status:'running',phase:'queued',message:'任务已排队',createdAt:now,updatedAt:now,sourceImageUuid:input.sourceImageUuid,imageName:input.imageName};
      jobs.set(id,job);run(job,input);return publicJob(job);
    },
    get(id){const job=jobs.get(id);return job?publicJob(job):null},
    list(){return [...jobs.values()].map(publicJob).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))}
  };
}

module.exports={createAutoDLImageImportManager};
