const form=document.querySelector('#authForm');
const loginTab=document.querySelector('#loginTab');
const registerTab=document.querySelector('#registerTab');
const nameField=document.querySelector('#nameField');
const displayName=document.querySelector('#displayName');
const password=document.querySelector('#password');
const errorBox=document.querySelector('#authError');
const submit=document.querySelector('#submitAuth');
let mode='login';

function setupDesktopTitlebar(){
  if(!window.fastGpuWindow)return;
  const titlebar=document.createElement('div');
  titlebar.className='desktop-titlebar';
  titlebar.setAttribute('aria-label','应用窗口标题栏');
  titlebar.innerHTML='<div class="desktop-title"><span class="desktop-title-logo">G</span><strong>Fast GPU</strong></div><div class="desktop-window-controls"><button type="button" data-window-action="minimize" aria-label="最小化">—</button><button type="button" data-window-action="maximize" aria-label="最大化">□</button><button type="button" data-window-action="close" aria-label="关闭">×</button></div>';
  document.body.prepend(titlebar);
  document.documentElement.classList.add('electron-client-root');
  document.body.classList.add('electron-client');
  const maximizeButton=document.querySelector('[data-window-action="maximize"]');
  const showMaximized=maximized=>{
    maximizeButton.textContent=maximized?'❐':'□';
    maximizeButton.setAttribute('aria-label',maximized?'还原窗口':'最大化');
  };
  document.querySelector('[data-window-action="minimize"]').onclick=()=>window.fastGpuWindow.minimize();
  maximizeButton.onclick=async()=>showMaximized(await window.fastGpuWindow.toggleMaximize());
  document.querySelector('[data-window-action="close"]').onclick=()=>window.fastGpuWindow.close();
  window.fastGpuWindow.isMaximized().then(showMaximized);
  window.fastGpuWindow.onMaximizedChange(showMaximized);
}
setupDesktopTitlebar();

function setMode(next){
  mode=next;
  const registering=mode==='register';
  loginTab.classList.toggle('active',!registering);
  registerTab.classList.toggle('active',registering);
  nameField.hidden=!registering;
  displayName.required=registering;
  password.autocomplete=registering?'new-password':'current-password';
  document.querySelector('#passwordHint').textContent=registering?'至少 10 个字符。':'使用你注册时设置的密码。';
  submit.textContent=registering?'创建账户':'登录';
  errorBox.textContent='';
}
loginTab.onclick=()=>setMode('login');
registerTab.onclick=()=>setMode('register');
form.onsubmit=async event=>{
  event.preventDefault();
  submit.disabled=true;
  errorBox.textContent='';
  try{
    const response=await fetch(`/api/auth/${mode}`,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({email:document.querySelector('#email').value,password:password.value,displayName:displayName.value}),
    });
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||'请求失败');
    const next=new URLSearchParams(location.search).get('next');
    location.replace(next&&next.startsWith('/')&&!next.startsWith('//')?next:'/');
  }catch(error){
    errorBox.textContent=error.message;
  }finally{
    submit.disabled=false;
  }
};
fetch('/api/auth/context').then(response=>response.json()).then(context=>{
  if(context.registrationEnabled===false){
    registerTab.hidden=true;
    if(mode==='register')setMode('login');
  }
}).catch(()=>{});
