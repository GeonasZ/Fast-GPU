reachabilityMarkup=function(report){
  if(!report)return '<div class="reachability-empty">尚未测试实例访问外部网站的能力</div>';
  const targets=Object.entries(report.targets||{});
  const allReachable=targets.length>0&&targets.every(([,item])=>item.reachable);
  return '<div class="reachability-summary '+(allReachable?'pass':'fail')+'"><strong>'+
    (allReachable?'外网均可直连':'部分外网不可达')+'</strong><span>'+
    new Date(report.generatedAt).toLocaleString()+'</span></div><div class="reachability-targets">'+
    targets.map(function([name,item]){
      return '<div class="reachability-target"><span>'+esc(name)+'</span><b class="'+
        (item.reachable?'pass':'fail')+'">'+(item.reachable?'可直连':'不可达')+
        '</b><small>HTTP '+esc(item.status||'-')+' · '+fmt(item.totalMs,0)+' ms'+
        (item.error?' · '+esc(item.error):'')+'</small></div>';
    }).join('')+
    '</div><p class="direct-note">测试命令通过托管 SSH 在实例内部执行，结果是实例主动访问外部网站的真实情况。</p>';
};

loadReachability=async function(i,force){
  const id=String(i.id);
  if(reachabilityLoads.has(id)||!force&&reachabilityCache.has(id))return;
  reachabilityLoads.add(id);
  const button=document.querySelector('[data-reachability="'+CSS.escape(id)+'"]');
  if(button&&force)setButtonBusy(button,'测试中…');
  try{
    const report=await request('/api/instances/'+encodeURIComponent(id)+'/reachability',force?{method:'POST'}:undefined);
    reachabilityCache.set(id,report);
    const el=document.getElementById('r-'+id);
    if(el)el.innerHTML=reachabilityMarkup(report);
    if(force){
      const all=Object.values(report.targets||{}).every(item=>item.reachable);
      toast(all?'实例可直连全部测试网站':'实例存在不可达的测试网站');
    }
  }catch(error){
    if(force)toast('外网可达性测试失败：'+error.message);
  }finally{
    reachabilityLoads.delete(id);
    if(button&&force)clearButtonBusy(button);
  }
};
