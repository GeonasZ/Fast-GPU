const {app,BrowserWindow,dialog,shell,ipcMain}=require('electron');
const {spawn,spawnSync}=require('node:child_process');
const http=require('node:http');
const net=require('node:net');
const fs=require('node:fs');
const path=require('node:path');
const {randomBytes,createHash}=require('node:crypto');
const {canBindPort,parseWindowsListeningPids,waitForPortAvailable}=require('./lib/local-port');

const port=Number(process.env.PORT||4173);
const remoteArgument=process.argv.find(value=>value.startsWith('--remote-url='));
const remoteUrl=remoteArgument?remoteArgument.slice('--remote-url='.length).replace(/\/+$/,''):'';
const url=remoteUrl||`http://127.0.0.1:${port}`;
const allInOne=!remoteUrl;
const dataDirectory=path.join(__dirname,'.data');
const keyFile=path.join(dataDirectory,'local-client.key');
const localDatabase=path.join(dataDirectory,'local-fleet.sqlite');
const controlName=`fast-gpu-${createHash('sha256').update(__dirname).digest('hex').slice(0,16)}`;
const controlEndpoint=process.platform==='win32'
  ?`\\\\.\\pipe\\${controlName}`
  :path.join(dataDirectory,`${controlName}.sock`);

let serverProcess=null;
let mainWindow=null;
let controlServer=null;
let quitting=false;
let forceExitTimer=null;
let conflictWindow=null;
let conflictResolver=null;

app.setName('Fast GPU');
app.setPath('userData',path.join(dataDirectory,'electron-profile'));

function localEncryptionKey(){
  const configured=String(process.env.FLEET_CREDENTIAL_ENCRYPTION_KEY||'').trim();
  if(configured)return configured;
  fs.mkdirSync(dataDirectory,{recursive:true});
  try{
    const saved=fs.readFileSync(keyFile,'utf8').trim();
    if(/^[a-f0-9]{64}$/i.test(saved))return saved;
    throw new Error('本地客户端密钥文件格式错误，请恢复原文件或设置 FLEET_CREDENTIAL_ENCRYPTION_KEY');
  }catch(error){
    if(error.code!=='ENOENT')throw error;
    const generated=randomBytes(32).toString('hex');
    fs.writeFileSync(keyFile,generated+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});
    console.log(`已创建本地凭据主密钥：${keyFile}`);
    console.log('请备份此文件；丢失后将无法读取已保存的 SSH 私钥和供应商 API Key。');
    return generated;
  }
}

function startServer(){
  const encryptionKey=localEncryptionKey();
  const nodeExecutable=process.env.npm_node_execpath||'node';
  serverProcess=spawn(nodeExecutable,[path.join(__dirname,'server.js')],{
    cwd:__dirname,
    env:{
      ...process.env,
      FLEET_CREDENTIAL_ENCRYPTION_KEY:encryptionKey,
      FLEET_DATABASE_PATH:process.env.FLEET_DATABASE_PATH||localDatabase,
      FLEET_CLIENT_MODE:'local',
      FLEET_DEPLOYMENT_MODE:'all-in-one',
      FLEET_PARENT_PID:String(process.pid),
      HOST:'127.0.0.1',
      PORT:String(port),
    },
    stdio:'inherit',
    windowsHide:true,
  });
  serverProcess.once('error',error=>failAndQuit(`本地服务启动失败：${error.message}`));
  serverProcess.once('exit',code=>{
    serverProcess=null;
    if(!quitting)failAndQuit(`本地服务意外退出${code==null?'':`（退出码 ${code}）`}`);
  });
}

function askCloseConflict(){
  return new Promise(resolve=>{
    conflictWindow=new BrowserWindow({parent:mainWindow,modal:true,width:460,height:260,resizable:false,show:false,frame:false,webPreferences:{contextIsolation:true,nodeIntegration:false,preload:path.join(__dirname,'electron-preload.js')}});
    conflictResolver=()=>{resolve(true); conflictResolver=null; conflictWindow?.close(); conflictWindow=null;};
    conflictWindow.webContents.once('did-finish-load',()=>conflictWindow.show());
    conflictWindow.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(`<style>body{margin:0;background:#102019;color:#e5f0e9;font:14px system-ui;padding:28px}h2{margin:0 0 12px}p{color:#a8b9ae;line-height:1.6}.actions{display:flex;justify-content:flex-end;gap:10px;margin-top:26px}button{padding:10px 16px;border-radius:7px;border:1px solid #41634f;background:#183326;color:#dff5e7;cursor:pointer}button.primary{background:#25c46a;color:#092413;border-color:#25c46a}</style><h2>端口冲突</h2><p>端口 ${port} 已被其他服务占用。是否关闭冲突进程并继续启动？</p><div class="actions"><button onclick="window.close()">取消启动</button><button class="primary" onclick="window.fastGpuWindow.conflictChoice()">关闭冲突进程并继续</button></div>`));
    conflictWindow.on('closed',()=>{if(conflictWindow){conflictResolver=null; conflictWindow=null; resolve(false);}});
  });
}

async function ensureLocalPortAvailable(){
  if(await canBindPort(port))return;
  if(process.platform!=='win32')throw new Error(`端口 ${port} 已被其他服务占用，请先关闭该服务或通过 PORT 设置其他端口`);
  if(!await askCloseConflict())throw new Error('已取消启动');
  const output=spawnSync('netstat',['-ano','-p','tcp'],{encoding:'utf8',windowsHide:true}).stdout||'';
  const pids=parseWindowsListeningPids(output,port).filter(pid=>pid!==process.pid);
  if(!pids.length)throw new Error(`未能找到占用端口 ${port} 的进程`);
  for(const pid of pids){
    const result=spawnSync('taskkill',['/PID',String(pid),'/T','/F'],{encoding:'utf8',windowsHide:true});
    if(result.status!==0)throw new Error(`无法关闭占用端口 ${port} 的进程 ${pid}：${String(result.stderr||result.stdout||'权限不足').trim()}`);
  }
  if(!await waitForPortAvailable(port))throw new Error(`进程已关闭，但端口 ${port} 在 5 秒内仍未释放`);
}

function waitUntilReady(){
  return new Promise((resolve,reject)=>{
    let attempts=0;
    const probe=()=>{
      const request=http.get(`${url}/api/auth/me`,response=>{
        let body='';
        response.setEncoding('utf8');
        response.on('data',chunk=>body+=chunk);
        response.on('end',()=>{
          try{
            const payload=JSON.parse(body);
            if(response.statusCode===200&&payload.mode==='local')return resolve();
          }catch{}
          retry();
        });
      });
      request.setTimeout(2000,()=>request.destroy());
      request.once('error',retry);
    };
    const retry=()=>{
      if(++attempts>=120)return reject(new Error('本地客户端在 60 秒内未能响应，请检查终端中的服务错误'));
      setTimeout(probe,500);
    };
    probe();
  });
}

function stopServer(){
  const processToStop=serverProcess;
  if(!processToStop)return Promise.resolve();
  return new Promise(resolve=>{
    if(processToStop.exitCode!=null){ resolve(); return; }
    let settled=false;
    const finish=()=>{ if(settled)return; settled=true; clearTimeout(forceStop); resolve(); };
    processToStop.once('exit',finish);
    processToStop.kill('SIGTERM');
    // On Windows SIGTERM may only signal the wrapper. Kill the complete
    // process tree after a short grace period so the HTTP server cannot linger.
    const forceStop=setTimeout(()=>{
      if(processToStop.exitCode!=null)return finish();
      if(process.platform==='win32'){
        const killer=spawn('taskkill',['/PID',String(processToStop.pid),'/T','/F'],{windowsHide:true});
        killer.once('close',finish);
        killer.once('error',finish);
      }else{
        try{processToStop.kill('SIGKILL')}catch{}
        finish();
      }
    },1500);
    forceStop.unref();
  });
}

function showMainWindow(){
  if(!mainWindow)return;
  if(!mainWindow.isVisible())mainWindow.show();
  if(mainWindow.isMinimized())mainWindow.restore();
  mainWindow.focus();
}

function shutdown(){
  if(quitting)return;
  quitting=true;
  controlServer?.close();
  forceExitTimer=setTimeout(()=>app.exit(0),4000);
  forceExitTimer.unref();
  stopServer().finally(()=>app.exit(0));
}

function startControlServer(){
  if(process.platform!=='win32'&&fs.existsSync(controlEndpoint))fs.unlinkSync(controlEndpoint);
  controlServer=net.createServer(socket=>{
    socket.setEncoding('utf8');
    socket.once('data',command=>{
      if(command.trim()==='shutdown'){
        socket.end('ok');
        shutdown();
        return;
      }
      showMainWindow();
      socket.end('ok');
    });
  });
  controlServer.on('error',error=>{
    if(!quitting)console.error(`一体化客户端控制通道错误：${error.message}`);
  });
  controlServer.listen(controlEndpoint);
}

function failAndQuit(message){
  if(quitting)return;
  console.error(message);
  if(app.isReady())dialog.showErrorBox('Fast GPU 启动失败',message);
  shutdown();
}

function createWindow(){
  mainWindow=new BrowserWindow({
    width:1440,
    height:920,
    minWidth:980,
    minHeight:680,
    show:true,
    autoHideMenuBar:true,
    backgroundColor:'#f5f7fb',
    title:'Fast GPU',
    frame:false,
    webPreferences:{
      contextIsolation:true,
      nodeIntegration:false,
      sandbox:true,
      preload:path.join(__dirname,'electron-preload.js'),
    },
  });
  const publishMaximized=()=>mainWindow?.webContents.send('window:maximized-change',mainWindow.isMaximized());
  mainWindow.on('maximize',publishMaximized);
  mainWindow.on('unmaximize',publishMaximized);
  const splash=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="color-scheme" content="dark">
    <style>
      *{box-sizing:border-box}body{margin:0;background:#0d1813;color:#dce7e1;font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif}
      header{height:42px;padding:0 14px;display:flex;align-items:center;gap:9px;background:#0a1510;border-bottom:1px solid #26372f;-webkit-app-region:drag}
      i{width:22px;height:22px;display:grid;place-items:center;border-radius:6px;background:#25c46a;color:#092413;font-style:normal;font-weight:900}
      main{min-height:calc(100vh - 42px);display:grid;place-items:center;text-align:center}.spinner{width:34px;height:34px;margin:0 auto 16px;border:3px solid #355246;border-top-color:#43dc83;border-radius:50%;animation:spin .8s linear infinite}
      h1{margin:0 0 5px;font-size:18px}p{margin:0;color:#829087}@keyframes spin{to{transform:rotate(360deg)}}
    </style><header><i>G</i><strong>Fast GPU</strong></header><main><div><div class="spinner"></div><h1>正在启动一体化控制面</h1><p>正在打开本地服务与持久化配置…</p></div></main></html>`;
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splash)}`);
  mainWindow.webContents.setWindowOpenHandler(({url:target})=>{
    if(target.startsWith(url))return {action:'allow'};
    shell.openExternal(target);
    return {action:'deny'};
  });
  mainWindow.webContents.on('will-navigate',(event,target)=>{
    if(!target.startsWith(url)){
      event.preventDefault();
      shell.openExternal(target);
    }
  });
  mainWindow.on('closed',()=>{
    mainWindow=null;
    shutdown();
  });
  return mainWindow;
}

function electronWindowFor(event){
  const window=BrowserWindow.fromWebContents(event.sender);
  return window===mainWindow?window:null;
}
ipcMain.handle('window:minimize',event=>electronWindowFor(event)?.minimize());
ipcMain.handle('window:toggle-maximize',event=>{
  const window=electronWindowFor(event);
  if(!window)return false;
  window.isMaximized()?window.unmaximize():window.maximize();
  return window.isMaximized();
});
ipcMain.handle('window:is-maximized',event=>Boolean(electronWindowFor(event)?.isMaximized()));
ipcMain.handle('window:close',event=>electronWindowFor(event)?.close());
ipcMain.handle('conflict:choice',()=>{ conflictResolver?.(); return true; });
ipcMain.handle('dialog:pick-directory',async event=>{
  const window=electronWindowFor(event);
  if(!window)return null;
  const result=await dialog.showOpenDialog(window,{title:'选择要上传的文件夹',properties:['openDirectory','createDirectory']});
  return result.canceled?null:result.filePaths[0]||null;
});
ipcMain.handle('dialog:pick-files',async event=>{
  const window=electronWindowFor(event);
  if(!window)return [];
  const result=await dialog.showOpenDialog(window,{title:'选择要上传到对象存储的文件',properties:['openFile']});
  return result.canceled?[]:result.filePaths;
});
ipcMain.handle('dialog:pick-startup-script',async event=>{
  const window=electronWindowFor(event);
  if(!window)return null;
  const result=await dialog.showOpenDialog(window,{title:'选择本地启动脚本',properties:['openFile'],filters:[{name:'Shell 脚本',extensions:['sh']},{name:'所有文件',extensions:['*']}]});
  return result.canceled?null:result.filePaths[0]||null;
});
function storageFiles(root){
  const files=[];
  function walk(directory){
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
      const fullPath=path.join(directory,entry.name);
      if(entry.isDirectory())walk(fullPath);
      else if(entry.isFile())files.push({localPath:fullPath,relativePath:path.relative(root,fullPath).replaceAll('\\','/'),size:fs.statSync(fullPath).size});
    }
  }
  walk(root);
  return files;
}
ipcMain.handle('dialog:pick-storage-files',async event=>{
  const window=electronWindowFor(event);
  if(!window)return [];
  const result=await dialog.showOpenDialog(window,{title:'选择要上传到对象存储的文件',properties:['openFile','multiSelections']});
  return result.canceled?[]:result.filePaths.map(localPath=>({name:path.basename(localPath),kind:'file',rootPath:path.dirname(localPath),files:[{localPath,relativePath:path.basename(localPath),size:fs.statSync(localPath).size}]}));
});
ipcMain.handle('dialog:pick-storage-folder',async event=>{
  const window=electronWindowFor(event);
  if(!window)return [];
  const result=await dialog.showOpenDialog(window,{title:'选择要上传到对象存储的文件夹',properties:['openDirectory']});
  if(result.canceled||!result.filePaths[0])return [];
  const rootPath=result.filePaths[0];
  return [{name:path.basename(rootPath),kind:'folder',rootPath,files:storageFiles(rootPath)}];
});

if(!app.requestSingleInstanceLock()){
  app.quit();
}else{
  if(allInOne)startControlServer();
  app.on('second-instance',()=>{
    showMainWindow();
  });
  app.whenReady().then(async()=>{
    try{
      createWindow();
      if(allInOne){
        await ensureLocalPortAvailable();
        startServer();
        await waitUntilReady();
      }
      await mainWindow.loadURL(`${url}/?client=1`);
      showMainWindow();
      console.log(allInOne?'一体化控制面已就绪，Electron 客户端已打开。':`Electron 客户端已连接：${url}`);
    }catch(error){
      failAndQuit(error.message);
    }
  });
}

app.on('before-quit',(event)=>{
  if(!quitting){
    event.preventDefault();
    shutdown();
    return;
  }
  controlServer?.close();
  stopServer();
  if(!forceExitTimer)forceExitTimer=setTimeout(()=>app.exit(0),4000);
});

app.on('window-all-closed',()=>app.quit());

for(const signal of ['SIGINT','SIGTERM']){
  process.once(signal,shutdown);
}
