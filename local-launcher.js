const {spawn}=require('node:child_process');
const net=require('node:net');
const path=require('node:path');
const {createHash}=require('node:crypto');

const projectDirectory=__dirname;
const controlName=`gpu-fleet-${createHash('sha256').update(projectDirectory).digest('hex').slice(0,16)}`;
const controlEndpoint=process.platform==='win32'
  ?`\\\\.\\pipe\\${controlName}`
  :path.join(projectDirectory,'.data',`${controlName}.sock`);

function sendControlCommand(command,timeoutMs=800){
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(controlEndpoint);
    let settled=false;
    const finish=(error)=>{
      if(settled)return;
      settled=true;
      clearTimeout(timeout);
      socket.destroy();
      error?reject(error):resolve();
    };
    const timeout=setTimeout(()=>{
      finish(new Error('连接一体化客户端超时'));
    },timeoutMs);
    socket.setEncoding('utf8');
    socket.once('connect',()=>socket.write(command));
    socket.once('data',reply=>finish(reply.trim()==='ok'?null:new Error('一体化客户端拒绝了控制命令')));
    socket.once('error',finish);
    socket.once('close',()=>{if(!settled)finish(new Error('一体化客户端未返回确认'))});
  });
}

async function attachToExistingClient(){
  try{
    await sendControlCommand('focus');
    return true;
  }catch{
    return false;
  }
}

async function main(){
  if(process.argv.includes('--stop')){
    try{
      await sendControlCommand('shutdown',2000);
      console.log('一体化客户端及本地服务已关闭。');
    }catch{
      console.log('当前没有正在运行的一体化客户端。');
    }
    return;
  }

  if(await attachToExistingClient()){
    console.log('已恢复正在运行的一体化窗口。需要关闭时请运行 npm run stop:all。');
    return;
  }

  const electronExecutable=require('electron');
  const child=spawn(electronExecutable,[path.join(projectDirectory,'local-client.js')],{
    cwd:projectDirectory,
    env:process.env,
    stdio:'inherit',
    windowsHide:true,
  });
  let stopping=false;
  const stop=async()=>{
    if(stopping)return;
    stopping=true;
    try{await sendControlCommand('shutdown',2000)}
    catch{if(!child.killed)child.kill('SIGTERM')}
  };
  process.once('SIGINT',stop);
  process.once('SIGTERM',stop);
  child.once('error',error=>{
    console.error(`一体化客户端启动失败：${error.message}`);
    process.exitCode=1;
  });
  child.once('exit',(code,signal)=>{
    if(signal&&!stopping)console.error(`一体化客户端异常退出：${signal}`);
    process.exitCode=code??(stopping?0:1);
  });
}

main().catch(error=>{
  console.error(error.message);
  process.exitCode=1;
});
