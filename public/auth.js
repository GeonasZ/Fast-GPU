const form=document.querySelector('#authForm');
const loginTab=document.querySelector('#loginTab');
const registerTab=document.querySelector('#registerTab');
const nameField=document.querySelector('#nameField');
const displayName=document.querySelector('#displayName');
const password=document.querySelector('#password');
const errorBox=document.querySelector('#authError');
const submit=document.querySelector('#submitAuth');
let mode='login';

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
