
const http=require('node:http'),{execFile,execFileSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const run=(cmd,args,timeout=120000,signal)=>new Promise(resolve=>{let child;const stop=()=>{if(!child?.pid)return;try{process.kill(-child.pid,'SIGTERM')}catch{}setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}},1500).unref()};child=execFile(cmd,args,{timeout,maxBuffer:8e6,detached:process.platform!=='win32'},(error,stdout,stderr)=>{signal?.removeEventListener('abort',stop);resolve({ok:!error,aborted:Boolean(signal?.aborted),stdout:String(stdout).trim(),stderr:String(stderr).trim()})});signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop()});
const throwIfAborted=signal=>{if(signal?.aborted)throw Object.assign(Error('性能测试已停止'),{code:'benchmark_cancelled'})};
function resolveExecutable(name,extra=[]){const candidates=[process.env[name.toUpperCase()+'_PATH'],...String(process.env.PATH||'').split(path.delimiter).map(dir=>path.join(dir,name)),...extra].filter(Boolean);try{const loginPath=execFileSync('/bin/bash',['-lc','command -v '+name],{encoding:'utf8',timeout:5000}).trim();if(loginPath)candidates.unshift(loginPath)}catch{}return candidates.find(file=>{try{fs.accessSync(file,fs.constants.X_OK);return true}catch{return false}})||null}
const nvbandwidthPath=resolveExecutable('nvbandwidth',['/usr/local/bin/nvbandwidth','/usr/bin/nvbandwidth','/opt/nvbandwidth/nvbandwidth','/opt/nvbandwidth/build/nvbandwidth','/workspace/nvbandwidth/build/nvbandwidth']);
function versionOf(file,args=['--version']){if(!file)return null;try{return execFileSync(file,args,{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']}).trim().split('\n')[0]||null}catch{return null}}
function inspectTools(){const definitions=[['codex','Codex CLI',[]],['claude','Claude Code',[]],['nvbandwidth','nvbandwidth',['/usr/local/bin/nvbandwidth','/usr/bin/nvbandwidth']],['fio','fio',[]],['rclone','rclone',[]],['node','Node.js',[]]];return definitions.map(([id,label,extra])=>{const executable=id==='nvbandwidth'?nvbandwidthPath:resolveExecutable(id,extra);return{id,label,installed:Boolean(executable),path:executable,version:versionOf(executable)}})}
const installedTools=inspectTools();
function bandwidthStatus(){const installed=Boolean(nvbandwidthPath);let lastRun=null,results=null;try{const report=JSON.parse(fs.readFileSync('/var/lib/gpu-fleet/benchmark.json','utf8'));lastRun=report.generatedAt||null;results=report.nvbandwidth||null}catch{}return{installed,path:nvbandwidthPath,lastRun,results}}
async function telemetry(){const q=await run('nvidia-smi',['--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw','--format=csv,noheader,nounits']);const gpus=q.stdout.split('\n').filter(Boolean).map(line=>{const [index,name,util,memoryUsed,memoryTotal,temperature,power]=line.split(',').map(x=>x.trim());return{index:+index,name,util:+util,memoryUsed:+memoryUsed,memoryTotal:+memoryTotal,temperature:+temperature,power:+power}}),error=q.ok?undefined:{component:'nvidia-smi',code:'gpu_telemetry_collection_failed',message:q.stderr||q.stdout||'nvidia-smi 执行失败'};return{ts:Date.now(),gpus,tools:installedTools,load:require('node:os').loadavg(),memory:{free:require('node:os').freemem(),total:require('node:os').totalmem()},error}}
const csvLines=s=>s.split('\n').filter(Boolean).map(line=>line.split(',').map(x=>x.trim()));
const reachabilityTargets={huggingface:'https://huggingface.co',cloudflare:'https://www.cloudflare.com',aws:'https://aws.amazon.com',openai:'https://api.openai.com/v1/models',google:'https://www.google.com/generate_204'};
async function testReachability(signal){
  const targets={};
  for(const [name,url] of Object.entries(reachabilityTargets)){throwIfAborted(signal);const probe=await run('curl',['--noproxy','*','-o','/dev/null','-sS','-w','%{http_code}|%{remote_ip}|%{time_namelookup}|%{time_connect}|%{time_appconnect}|%{time_total}','--connect-timeout','8','--max-time','20',url],120000,signal);throwIfAborted(signal);const [status,remoteIp,dns,connect,tls,total]=probe.stdout.split('|');targets[name]={url,proxyBypassed:true,reachable:/^[234]/.test(status),status:Number(status)||0,remoteIp,dnsMs:+dns*1000,connectMs:+connect*1000,tlsMs:+tls*1000,totalMs:+total*1000,error:probe.ok?'':probe.stderr}}
  const result={generatedAt:new Date().toISOString(),mode:'direct-origin',explicitProxyBypassed:true,allReachable:Object.values(targets).every(x=>x.reachable),targets,note:'Origin probes run inside the GPU instance with curl --noproxy *. Cloud NAT is a normal direct egress path; transparent network intermediaries cannot be ruled out by curl alone.'};
  fs.mkdirSync('/var/lib/gpu-fleet',{recursive:true});fs.writeFileSync('/var/lib/gpu-fleet/reachability.json',JSON.stringify(result,null,2));return result
}
const computeBenchmarkScript=`
import json, sys, time
import torch

mode = sys.argv[1]
size = 8192 if mode == "full" else 4096
warmups = 8 if mode == "full" else 3
iterations = 30 if mode == "full" else 10
tests = [
    ("fp32", torch.float32, False),
    ("tf32", torch.float32, True),
    ("fp16", torch.float16, True),
    ("bf16", torch.bfloat16, True),
]
result = {"mode": mode, "matrixSize": size, "warmups": warmups, "iterations": iterations, "gpus": []}
for index in range(torch.cuda.device_count()):
    torch.cuda.set_device(index)
    device = torch.device("cuda", index)
    props = torch.cuda.get_device_properties(index)
    gpu = {"index": index, "name": props.name, "results": []}
    for name, dtype, allow_tf32 in tests:
        try:
            if name == "tf32" and props.major < 8:
                raise RuntimeError("TF32 Tensor Core is not supported by this GPU")
            if name == "bf16" and not torch.cuda.is_bf16_supported():
                raise RuntimeError("BF16 is not supported by this GPU")
            torch.backends.cuda.matmul.allow_tf32 = allow_tf32
            a = torch.randn((size, size), device=device, dtype=dtype)
            b = torch.randn((size, size), device=device, dtype=dtype)
            for _ in range(warmups):
                torch.mm(a, b)
            torch.cuda.synchronize(device)
            samples = []
            for _ in range(iterations):
                start = torch.cuda.Event(enable_timing=True)
                end = torch.cuda.Event(enable_timing=True)
                start.record()
                torch.mm(a, b)
                end.record()
                end.synchronize()
                samples.append(start.elapsed_time(end) / 1000)
            samples.sort()
            seconds = samples[len(samples) // 2]
            gpu["results"].append({"precision": name, "tflops": 2 * size ** 3 / seconds / 1e12, "medianMs": seconds * 1000, "ok": True})
            del a, b
            torch.cuda.empty_cache()
        except Exception as error:
            gpu["results"].append({"precision": name, "ok": False, "error": str(error)})
            torch.cuda.empty_cache()
    result["gpus"].append(gpu)
print(json.dumps(result))
`;
async function gpuComputeBenchmark(mode,signal){
  const compute=await run('python3',['-c',computeBenchmarkScript,mode],mode==='full'?10*60*1000:5*60*1000,signal);
  throwIfAborted(signal);
  if(!compute.ok)return{available:false,error:compute.stderr||'PyTorch GPU compute benchmark failed'};
  try{return JSON.parse(compute.stdout)}catch{return{available:false,error:'GPU compute benchmark did not return valid JSON',raw:compute.stdout}}
}
async function benchmark(mode='quick',signal){
  throwIfAborted(signal);
  const full=mode==='full',fioSize=full?'2G':'256M',downloadBytes=full?'100000000':'20000000';
  const gpu=await run('nvidia-smi',['--query-gpu=index,name,pci.bus_id,pcie.link.gen.current,pcie.link.gen.max,pcie.link.width.current,pcie.link.width.max','--format=csv,noheader,nounits'],120000,signal);
  const compute=await gpuComputeBenchmark(mode,signal);
  throwIfAborted(signal);const nvlink=await run('nvidia-smi',['nvlink','-s'],120000,signal);const topology=await run('nvidia-smi',['topo','-m'],120000,signal);const bandwidth=nvbandwidthPath?await run(nvbandwidthPath,['-j'],300000,signal):{ok:false,stdout:'',stderr:'nvbandwidth executable not found in Agent PATH or known install locations'};throwIfAborted(signal);
  const gpuCount=csvLines(gpu.stdout).length,ncclScript='/tmp/gpu-fleet-nccl-check.py';
  let nccl={ok:false,skipped:gpuCount<2,error:gpuCount<2?'single GPU':''};
  if(gpuCount>1){fs.writeFileSync(ncclScript,"import torch, torch.distributed as dist\ndist.init_process_group('nccl')\nx=torch.tensor([1.0],device='cuda')\ndist.all_reduce(x)\nassert x.item()==dist.get_world_size()\nif dist.get_rank()==0: print('NCCL all_reduce passed on %d GPUs' % dist.get_world_size())\ndist.destroy_process_group()\n");const check=await run('torchrun',['--standalone',`--nproc_per_node=${gpuCount}`,ncclScript],120000,signal);try{fs.unlinkSync(ncclScript)}catch{}throwIfAborted(signal);nccl={ok:check.ok,skipped:false,output:check.stdout,error:check.stderr||(!check.ok?'NCCL all_reduce failed':'')}}
  fs.mkdirSync('/data',{recursive:true});const diskFile='/data/.gpu-fleet-fio';
  const disk=await run('fio',['--name=fleet','--filename='+diskFile,'--size='+fioSize,'--rw=readwrite','--rwmixread=50','--bs=1M','--direct=1','--iodepth=16','--ioengine=libaio','--output-format=json'],300000,signal);throwIfAborted(signal);
  const download=await run('curl',['--noproxy','*','--fail','-sS','-o','/dev/null','-w','%{speed_download}','--connect-timeout','10','--max-time','120','https://speed.cloudflare.com/__down?bytes='+downloadBytes],120000,signal);throwIfAborted(signal);
  const upload=await run('curl',['--noproxy','*','--fail','-sS','-o','/dev/null','-w','%{speed_upload}','--connect-timeout','10','--max-time','120','-X','POST','--data-binary','@'+diskFile,'https://speed.cloudflare.com/__up'],120000,signal);try{fs.unlinkSync(diskFile)}catch{}throwIfAborted(signal);
  const reachabilityResult=await testReachability(signal),reachability=reachabilityResult.targets;
  let fio=null,nvbandwidth=null;try{fio=JSON.parse(disk.stdout)}catch{}try{nvbandwidth=JSON.parse(bandwidth.stdout)}catch{}const diskJob=fio?.jobs?.[0];
  const report={generatedAt:new Date().toISOString(),gpus:csvLines(gpu.stdout).map(([index,name,busId,genCurrent,genMax,widthCurrent,widthMax])=>({index:+index,name,busId,pcie:{genCurrent:+genCurrent,genMax:+genMax,widthCurrent:+widthCurrent,widthMax:+widthMax}})),compute,nccl,nvlink:{ok:nvlink.ok,raw:nvlink.stdout,error:nvlink.stderr},topology:{ok:topology.ok,raw:topology.stdout,error:topology.stderr},nvbandwidth:nvbandwidth||{available:false,error:bandwidth.stderr||'nvbandwidth did not return valid JSON'},disk:{target:'/data',ok:disk.ok&&!!fio,readMBps:(diskJob?.read?.bw_bytes||0)/1e6,writeMBps:(diskJob?.write?.bw_bytes||0)/1e6,readIops:diskJob?.read?.iops||0,writeIops:diskJob?.write?.iops||0,raw:fio,error:disk.ok?'':disk.stderr},internet:{downloadMbps:download.ok?Number(download.stdout)*8/1e6:null,uploadMbps:upload.ok?Number(upload.stdout)*8/1e6:null,downloadError:download.ok?'':download.stderr,uploadError:upload.ok?'':upload.stderr,direct:true,proxyBypassed:true},reachability,note:'Measured inside the GPU instance. Compute results are real PyTorch GEMM throughput, not theoretical specifications. Multi-GPU instances run a real NCCL all_reduce; GPU memory is not treated as one automatically merged pool.'};fs.mkdirSync('/var/lib/gpu-fleet',{recursive:true});fs.writeFileSync('/var/lib/gpu-fleet/benchmark.json',JSON.stringify(report,null,2));return report
}
function profile(){try{return JSON.parse(fs.readFileSync('/var/lib/gpu-fleet/profile.json','utf8'))}catch{return{status:'provisioning',phase:'awaiting_bootstrap',phaseLabel:'正在等待初始化脚本'}}}
function controlUrl(pathname){const base=process.env.BASE_URL||process.env.FLEET_TELEMETRY_PUSH_URL;return base?new URL(pathname,base).href:null}
function agentHeaders(){return{'content-type':'application/json','x-fleet-agent-id':process.env.FLEET_AGENT_ID||'',authorization:`Bearer ${process.env.FLEET_AGENT_SECRET||''}`}}
let jobRunning=false,benchmarkController=null;async function executeAgentJob(job){if(jobRunning||!job)return;jobRunning=true;benchmarkController=new AbortController();const provider=process.env.FLEET_PROVIDER||'unknown',instanceName=process.env.FLEET_INSTANCE_NAME,agentId=process.env.FLEET_AGENT_ID,headers=agentHeaders();try{let result;if(job.type==='benchmark')result=await benchmark(job.params?.mode,benchmarkController.signal);else throw Error(`unsupported agent job type: ${job.type}`);await fetch(controlUrl('/api/agent/job-result'),{method:'POST',headers,body:JSON.stringify({agentId,provider,instanceName,jobId:job.id,status:'completed',result}),signal:AbortSignal.timeout(30000)})}catch(error){await fetch(controlUrl('/api/agent/job-result'),{method:'POST',headers,body:JSON.stringify({agentId,provider,instanceName,jobId:job.id,status:error.code==='benchmark_cancelled'?'cancelled':'failed',error:error.message}),signal:AbortSignal.timeout(15000)}).catch(()=>{})}finally{jobRunning=false;benchmarkController=null}}
let telemetryPushing=false;async function pushTelemetry(){if(telemetryPushing||!process.env.FLEET_TELEMETRY_PUSH_URL||!process.env.FLEET_INSTANCE_NAME)return;telemetryPushing=true;try{const response=await fetch(process.env.FLEET_TELEMETRY_PUSH_URL,{method:'POST',headers:agentHeaders(),body:JSON.stringify({agentId:process.env.FLEET_AGENT_ID,provider:process.env.FLEET_PROVIDER||'unknown',instanceName:process.env.FLEET_INSTANCE_NAME,capabilities:['agent_jobs'],telemetry:{...await telemetry(),runtime:profile()}}),signal:AbortSignal.timeout(15000)}),payload=await response.json().catch(()=>({}));if(!response.ok)throw Error(`HTTP ${response.status}: ${payload.error||response.statusText}`);if(payload.job&&!jobRunning)void executeAgentJob(payload.job)}catch(error){console.error('telemetry push failed:',error.message)}finally{telemetryPushing=false}}
if(process.env.FLEET_TELEMETRY_PUSH_URL){setTimeout(pushTelemetry,1000);setInterval(pushTelemetry,3000).unref()}
http.createServer(async(req,res)=>{res.setHeader('content-type','application/json');const requestUrl=new URL(req.url,'http://127.0.0.1');try{if(process.env.FLEET_AGENT_SECRET&&req.headers.authorization!==`Bearer ${process.env.FLEET_AGENT_SECRET}`){res.statusCode=401;return res.end(JSON.stringify({error:'unauthorized'}))}if(requestUrl.pathname==='/health')return res.end(JSON.stringify({ok:true,runtime:profile()}));if(requestUrl.pathname==='/telemetry')return res.end(JSON.stringify({...await telemetry(),runtime:profile()}));if(requestUrl.pathname==='/reachability'&&req.method==='POST')return res.end(JSON.stringify(await testReachability()));if(requestUrl.pathname==='/reachability'&&fs.existsSync('/var/lib/gpu-fleet/reachability.json'))return res.end(fs.readFileSync('/var/lib/gpu-fleet/reachability.json'));if(requestUrl.pathname==='/benchmark/status')return res.end(JSON.stringify({running:Boolean(benchmarkController)}));if(requestUrl.pathname==='/benchmark'&&req.method==='DELETE'){const stopped=Boolean(benchmarkController);benchmarkController?.abort();return res.end(JSON.stringify({stopped}))}if(requestUrl.pathname==='/benchmark'&&req.method==='POST'){if(benchmarkController){res.statusCode=409;return res.end(JSON.stringify({error:'性能测试正在运行'}))}benchmarkController=new AbortController();try{return res.end(JSON.stringify({...await benchmark(requestUrl.searchParams.get('mode')==='full'?'full':'quick',benchmarkController.signal),runtime:profile()}))}finally{benchmarkController=null}}if(requestUrl.pathname==='/benchmark'&&fs.existsSync('/var/lib/gpu-fleet/benchmark.json'))return res.end(fs.readFileSync('/var/lib/gpu-fleet/benchmark.json'));res.statusCode=404;res.end(JSON.stringify({error:'not found'}))}catch(e){res.statusCode=e.code==='benchmark_cancelled'?499:500;res.end(JSON.stringify({error:e.message,code:e.code}))}}).listen(Number(process.env.FLEET_AGENT_PORT||3000),'0.0.0.0');
