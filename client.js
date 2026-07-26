const {spawn}=require('node:child_process');
const path=require('node:path');

function serverUrl(){
  const value=String(process.argv[2]||process.env.FLEET_SERVER_URL||'').trim().replace(/\/+$/,'');
  if(!value)throw new Error('请指定平台服务端 URL，例如：npm run start:local -- https://gpu.example.com');
  const parsed=new URL(value);
  const local=['localhost','127.0.0.1','::1'].includes(parsed.hostname);
  if(parsed.protocol!=='https:'&&!(parsed.protocol==='http:'&&local))throw new Error('远程服务端必须使用 HTTPS；只有 localhost 可以使用 HTTP');
  return parsed.href.replace(/\/$/,'');
}

function openWindow(url){
  const electronExecutable=require('electron');
  const child=spawn(electronExecutable,[path.join(__dirname,'local-client.js'),`--remote-url=${url}`],{
    cwd:__dirname,
    detached:true,
    stdio:'ignore',
    windowsHide:true,
  });
  child.unref();
}

try{
  const url=serverUrl();
  console.log(`正在连接平台服务端：${url}`);
  openWindow(url);
}catch(error){
  console.error(error.message);
  process.exitCode=1;
}
