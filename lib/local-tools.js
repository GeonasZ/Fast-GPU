const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {spawnSync}=require('node:child_process');

const CWRSYNC_RELEASE={
  version:'6.4.8',
  url:'https://itefix.net/sites/default/files/2026-06/cwrsync_6.4.8_x64_free.zip',
  sha256:'8798363513b05c355ad87f8f3efbb15b7b6433996b652efec712efd52d7c8336',
};

const applicationToolsDirectory=path.resolve(process.env.FLEET_APPLICATION_TOOLS_DIR||path.join(__dirname,'..','.data','tools'));
const systemToolsDirectory=path.resolve(process.env.FLEET_SYSTEM_TOOLS_DIR||(
  process.platform==='win32'
    ?path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'Fast GPU','tools')
    :path.join(process.env.XDG_DATA_HOME||path.join(os.homedir(),'.local','share'),'gpu-fleet','tools')
));

function commandAvailable(command){
  const lookup=process.platform==='win32'?'where.exe':'which';
  return spawnSync(lookup,[command],{windowsHide:true,stdio:'ignore'}).status===0;
}

function runInstaller(command,args){
  const result=spawnSync(command,args,{
    windowsHide:true,
    encoding:'utf8',
    timeout:10*60*1000,
    maxBuffer:8*1024*1024,
  });
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error(String(result.stderr||result.stdout||`${command} 退出码 ${result.status}`).trim());
}

function systemInstallCandidates(tool){
  if(process.platform==='win32'){
    const wingetId={cloudflared:'Cloudflare.cloudflared',rsync:'RsyncProject.Rsync',ssh:'Microsoft.OpenSSH.Preview'}[tool];
    const packageName=tool==='ssh'?'openssh':tool;
    return[
      {when:'winget',command:'winget',args:['install','--id',wingetId,'--exact','--silent','--accept-package-agreements','--accept-source-agreements']},
      {when:'choco',command:'choco',args:['install',packageName,'-y','--no-progress']},
      {when:'scoop',command:'scoop',args:['install',packageName]},
    ];
  }
  if(process.platform==='darwin')return[{when:'brew',command:'brew',args:['install',tool]}];
  const elevated=(command,args)=>commandAvailable('pkexec')
    ?{command:'pkexec',args:[command,...args]}
    :{command:'sudo',args:['-n',command,...args]};
  if(commandAvailable('apt-get'))return[elevated('apt-get',['install','-y',tool])];
  if(commandAvailable('dnf'))return[elevated('dnf',['install','-y',tool])];
  if(commandAvailable('pacman'))return[elevated('pacman',['-S','--noconfirm',tool])];
  if(commandAvailable('zypper'))return[elevated('zypper',['--non-interactive','install',tool])];
  return[];
}

function installWithSystemPackageManager(tool){
  const candidates=systemInstallCandidates(tool).filter(candidate=>!candidate.when||commandAvailable(candidate.when));
  if(!candidates.length)throw Object.assign(new Error('没有找到受支持的系统包管理器（winget、Chocolatey、Scoop、Homebrew、apt、dnf、pacman 或 zypper）'),{status:409});
  const errors=[];
  for(const candidate of candidates){
    try{
      runInstaller(candidate.command,candidate.args);
      const installed=resolveTool(tool);
      if(installed.executable)return installed.executable;
      throw new Error('安装命令已完成，但当前进程还未发现可执行文件；请重启 Fast GPU');
    }catch(error){errors.push(`${candidate.when||candidate.command}: ${error.message}`)}
  }
  throw Object.assign(new Error(`系统包管理器安装失败：${errors.join('；')}`),{status:502});
}

function findExecutable(directory,names){
  if(!fs.existsSync(directory))return '';
  const wanted=new Set(names.map(name=>name.toLowerCase())),pending=[directory];
  while(pending.length){
    const current=pending.pop();
    for(const entry of fs.readdirSync(current,{withFileTypes:true})){
      const filename=path.join(current,entry.name);
      if(entry.isDirectory())pending.push(filename);
      else if(wanted.has(entry.name.toLowerCase()))return filename;
    }
  }
  return '';
}

function toolNames(tool){
  if(tool==='rsync')return process.platform==='win32'?['rsync.exe']:['rsync'];
  if(tool==='cloudflared')return process.platform==='win32'?['cloudflared.exe']:['cloudflared'];
  if(tool==='ssh')return process.platform==='win32'?['ssh.exe']:['ssh'];
  if(tool==='scp')return process.platform==='win32'?['scp.exe']:['scp'];
  throw new Error(`未知本地工具：${tool}`);
}

function resolveTool(tool){
  if(commandAvailable(tool))return{executable:tool,source:'existing'};
  const directory=tool==='scp'?'ssh':tool;
  const system=findExecutable(path.join(systemToolsDirectory,directory),toolNames(tool));
  if(system)return{executable:system,source:'system'};
  const application=findExecutable(path.join(applicationToolsDirectory,directory),toolNames(tool));
  if(application)return{executable:application,source:'application'};
  return{executable:'',source:'missing'};
}

async function download(url,filename,expectedSha256=''){
  const response=await fetch(url,{headers:{'user-agent':'GPU-Fleet'}});
  if(!response.ok)throw new Error(`下载失败（HTTP ${response.status}）`);
  fs.mkdirSync(path.dirname(filename),{recursive:true});
  const temporary=`${filename}.download`;
  const contents=Buffer.from(await response.arrayBuffer());
  if(expectedSha256){
    const actualSha256=createHash('sha256').update(contents).digest('hex');
    if(actualSha256!==expectedSha256.toLowerCase())throw new Error(`下载文件校验失败（SHA-256 ${actualSha256}）`);
  }
  fs.writeFileSync(temporary,contents);
  fs.renameSync(temporary,filename);
  if(process.platform!=='win32')fs.chmodSync(filename,0o755);
}

async function installRsync(scope){
  if(process.platform!=='win32')throw Object.assign(new Error('当前系统请使用系统包管理器安装 rsync'),{status:409});
  const directory=path.join(scope==='system'?systemToolsDirectory:applicationToolsDirectory,'rsync');
  fs.mkdirSync(directory,{recursive:true});
  const archive=path.join(directory,`cwrsync-${CWRSYNC_RELEASE.version}.zip`);
  await download(CWRSYNC_RELEASE.url,archive,CWRSYNC_RELEASE.sha256);
  const extracted=spawnSync('tar.exe',['-xf',archive,'-C',directory],{windowsHide:true,encoding:'utf8'});
  fs.rmSync(archive,{force:true});
  if(extracted.status!==0)throw new Error(`解压 cwRsync 失败：${String(extracted.stderr||'tar.exe 不可用').trim()}`);
  const executable=findExecutable(directory,['rsync.exe']);
  if(!executable)throw new Error('cwRsync 已下载，但压缩包中未找到 rsync.exe');
  return executable;
}

async function installCloudflared(scope){
  const directory=path.join(scope==='system'?systemToolsDirectory:applicationToolsDirectory,'cloudflared');
  const filename=path.join(directory,process.platform==='win32'?'cloudflared.exe':'cloudflared');
  const platform={
    win32:'windows-amd64.exe',
    linux:process.arch==='arm64'?'linux-arm64':'linux-amd64',
  }[process.platform];
  if(!platform)throw Object.assign(new Error('当前系统请使用系统包管理器安装 cloudflared'),{status:409});
  await download(`https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${platform}`,filename);
  return filename;
}

async function installSsh(scope){
  if(process.platform!=='win32')throw Object.assign(new Error('当前系统请使用系统包管理器安装 OpenSSH 客户端'),{status:409});
  const directory=path.join(scope==='system'?systemToolsDirectory:applicationToolsDirectory,'ssh');
  const releaseResponse=await fetch('https://api.github.com/repos/PowerShell/Win32-OpenSSH/releases/latest',{headers:{accept:'application/vnd.github+json','user-agent':'GPU-Fleet'}});
  if(!releaseResponse.ok)throw new Error(`读取 OpenSSH 版本失败（HTTP ${releaseResponse.status}）`);
  const release=await releaseResponse.json(),asset=(release.assets||[]).find(item=>/^OpenSSH-Win64\.zip$/i.test(item.name));
  if(!asset)throw new Error('最新 OpenSSH 版本没有可用的 Win64 压缩包');
  fs.mkdirSync(directory,{recursive:true});
  const archive=path.join(directory,'OpenSSH-Win64.zip');
  await download(asset.browser_download_url,archive);
  const extracted=spawnSync('tar.exe',['-xf',archive,'-C',directory],{windowsHide:true,encoding:'utf8'});
  fs.rmSync(archive,{force:true});
  if(extracted.status!==0)throw new Error(`解压 OpenSSH 失败：${String(extracted.stderr||'tar.exe 不可用').trim()}`);
  const executable=findExecutable(directory,['ssh.exe']);
  if(!executable)throw new Error('OpenSSH 已下载，但压缩包中未找到 ssh.exe');
  return executable;
}

async function installTool(tool,scope){
  if(!['system','application'].includes(scope))throw Object.assign(new Error('安装位置无效'),{status:400});
  const existing=resolveTool(tool);
  if(existing.executable&&existing.source===scope)return existing.executable;
  if(scope==='system')return installWithSystemPackageManager(tool);
  if(tool==='cloudflared')return installCloudflared(scope);
  if(tool==='ssh')return installSsh(scope);
  return installRsync(scope);
}

module.exports={applicationToolsDirectory,systemToolsDirectory,resolveTool,installTool};
