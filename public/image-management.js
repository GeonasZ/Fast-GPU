let imageProfiles = [], imageProfileDefaults = null, activeImageProfile = null, lastFocusedImageProfileId = null;

function createImageManagementUi() {
  const styles = document.createElement("link");
  styles.rel = "stylesheet";
  styles.href = "/image-management.css";
  document.head.append(styles);
  const localSourceStyles = document.createElement("link");
  localSourceStyles.rel = "stylesheet";
  localSourceStyles.href = "/image-local-source.css";
  document.head.append(localSourceStyles);
  const button = document.createElement("button");
  button.dataset.view = "images";
  button.innerHTML = "<span>▧</span> 开机行为";
  button.onclick = () => { go("images"); loadImageProfiles(activeImageProfile?.id).catch(error=>toast(error.message)); };
  document.querySelector('.sidebar nav button[data-view="storage"]').before(button);
  pages.images = ["开机行为", "分别管理 Docker 容器与 VM 宿主机的启动配置"];
  const section = document.createElement("section");
  section.id = "images";
  section.className = "view";
  section.innerHTML = `
    <div class="image-management-head"><div><span class="eyebrow">BOOT BEHAVIORS</span><h2>镜像与开机行为</h2><p>分别管理 Docker 容器和 VM 宿主机首次启动时的系统行为。</p></div><div class="image-create-actions"><button id="newDockerProfile" class="primary" type="button">＋ Docker 配置</button><button id="newVmProfile" type="button">＋ VM 配置</button></div></div>
    <div class="image-management-layout"><aside id="imageProfileList" class="image-profile-list" aria-live="polite"></aside>
    <form id="imageProfileForm" class="image-profile-editor"><input id="imageProfileId" type="hidden">
      <div class="image-editor-head"><div><span id="imageProfileType" class="pill stopped">自定义</span><h3 id="imageEditorTitle">选择一条配置</h3></div><div class="image-editor-actions"><button id="duplicateImageProfile" type="button">复制</button><button id="deleteImageProfile" class="danger" type="button">删除</button></div></div>
      <div class="image-profile-fields"><label>配置名称<input id="imageProfileName" maxlength="120" required></label><label>配置类型<select id="imageProfileTypeSelect"><option value="docker">Docker 容器</option><option value="vm">VM 宿主机</option></select></label><label id="imageProfileBaseWrap">Docker 镜像（可选）<select id="imageProfileBase"></select></label><label id="customProfileImageWrap" hidden>自定义镜像地址<input id="imageProfileImage" placeholder="registry/namespace/image:tag"></label><label id="imageProfileCudaWrap">CUDA 主版本<select id="imageProfileCuda"><option value="13">CUDA 13</option><option value="12">CUDA 12</option></select></label></div>
      <section class="startup-actions"><div class="startup-actions-head"><div><strong>启动脚本配置</strong><small>直接编辑实际执行的脚本，下方会实时整理其中的软件安装、包安装和远程脚本。</small></div></div>
      <div class="script-toolbar"><strong>开机启动脚本</strong><div><label class="script-source-control">来源<select id="startupScriptSource"><option value="editor">在线编辑</option><option value="local">本地文件</option></select></label><button id="loadPresetStartupScript" type="button">载入预设脚本</button><button id="uploadStartupScript" type="button">上传覆盖</button><button id="downloadStartupScript" type="button">下载脚本</button><input id="startupScriptFile" type="file" accept=".sh,text/x-shellscript,text/plain" hidden></div></div>
      <div id="startupScriptDrop" class="startup-script-drop"><textarea id="imageProfileScript" rows="18" spellcheck="false" placeholder="#!/usr/bin/env bash"></textarea><small>可将 .sh 文件拖到此处覆盖编辑器内容</small></div>
      <div id="localStartupScriptDrop" class="local-startup-script-drop" hidden><div><strong>本地脚本路径</strong><code id="localStartupScriptPath">尚未选择</code><span id="localStartupScriptBubble" class="local-file-bubble" hidden>文件不存在</span></div><button id="pickLocalStartupScript" type="button">选择文件</button><input id="localStartupScriptFile" type="file" accept=".sh,text/x-shellscript,text/plain" hidden><small>也可以将本机 .sh 文件拖到这里；平台只保存路径，每次启动实例时重新读取。</small></div></section>
      <div class="install-plan"><div><strong>安装与下载内容</strong><small>SSH 是平台强制步骤，不需要写入用户脚本。</small></div><div><span class="system-install-step"><b>系统必装</b> SSH 检测、安装、配置与启动</span><div id="imageInstallPlan"></div></div></div>
      <div class="image-save-row"><span id="imageProfileStatus"></span><button class="primary" type="submit">保存配置</button></div>
    </form></div>`;
  document.querySelector("main").append(section);
}
createImageManagementUi();

function profileBaseOptions(profileType = $("#imageProfileTypeSelect")?.value || "docker") {
  const values = [...new Map(imageProfiles.filter(item=>item.profileType==="docker"&&item.image).map(item => [item.image, item])).values()];
  $("#imageProfileBase").innerHTML = (profileType === "vm" ? '<option value="">使用平台默认 Docker 镜像</option>' : "") + values.map(item =>
    `<option value="${esc(item.image)}" data-cuda="${item.cudaMajor}">${esc(item.image)}</option>`
  ).join("") + '<option value="custom">自定义镜像地址…</option>';
}
function renderInstallPlan(plan = []) {
  const labels = {apt:"系统软件",pip:"Python 包",npm:"Node 包",fetch:"远程脚本",download:"远程脚本"};
  $("#imageInstallPlan").innerHTML = plan.length ? plan.map(item =>
    `<span><b>${labels[item.type] || esc(item.type)}</b>${esc(item.value)}</span>`
  ).join("") : "<small>尚未识别到标准安装命令；脚本仍会完整执行。</small>";
}
function localInstallPlan() {
  const script = $("#imageProfileScript").value.replace(/\\\r?\n/g, " "), results = [];
  const patterns = [["apt",/(?:apt-get|apt)\s+install(?:\s+-[^\s]+)*\s+([^;&\n]+)/g],["pip",/(?:pip3?|python3?\s+-m\s+pip)\s+install(?:\s+-[^\s]+)*\s+([^;&\n]+)/g],["npm",/npm\s+install(?:\s+-[^\s]+)*\s+([^;&\n]+)/g],["fetch",/(?:curl|wget)\b[^\n]*?\b(https?:\/\/[^\s'";|]+)/g]];
  for(const [type,pattern] of patterns)for(const match of script.matchAll(pattern)){const values=type==="fetch"?[match[1]]:match[1].trim().split(/\s+/).filter(x=>!x.startsWith("-"));for(const value of values)results.push({type,value});}
  renderInstallPlan(results.filter((item,index)=>results.findIndex(other=>other.type===item.type&&other.value===item.value)===index).slice(0,80));
}
function editImageProfile(profile) {
  activeImageProfile = profile;
  if (profile?.id) lastFocusedImageProfileId = profile.id;
  $("#imageProfileId").value = profile?.id || "";
  $("#imageProfileName").value = profile?.name || "新开机配置";
  $("#imageProfileTypeSelect").value = profile?.profileType || "docker";
  $("#imageProfileCuda").value = String(profile?.cudaMajor || 13);
  $("#imageProfileScript").value = profile?.startupScript ?? imageProfileDefaults?.startupScript ?? "";
  $("#startupScriptSource").value = profile?.scriptSource || "editor";
  $("#localStartupScriptPath").textContent = profile?.startupScriptPath || "尚未选择";
  $("#localStartupScriptPath").dataset.path = profile?.startupScriptPath || "";
  $("#localStartupScriptBubble").hidden = profile?.scriptSource !== "local" || profile?.localFileExists !== false;
  $("#imageEditorTitle").textContent = profile?.name || "新建配置";
  $("#imageProfileType").textContent = profile?.isPreset ? "系统预设" : "自定义";
  $("#imageProfileType").className = `pill ${profile?.isPreset ? "ready" : "stopped"}`;
  $("#deleteImageProfile").disabled = Boolean(profile?.isPreset);
  profileBaseOptions(profile?.profileType || "docker");
  const known = [...$("#imageProfileBase").options].some(option => option.value === (profile?.image||""));
  $("#imageProfileBase").value = known ? (profile?.image||"") : "custom";
  if (known) $("#customProfileImageWrap").setAttribute("hidden", "");
  else $("#customProfileImageWrap").removeAttribute("hidden");
  $("#customProfileImageWrap").style.display = known ? "none" : "grid";
  $("#imageProfileImage").value = known ? "" : (profile?.image || "");
  $("#imageProfileStatus").textContent = "";
  renderInstallPlan(profile?.installPlan || []);
  updateStartupScriptSource();
  updateProfileTypeFields();
  renderImageProfileList();
}
function renderImageProfileList() {
  const group=(type,title)=>`<section class="behavior-profile-group"><header><strong>${title}</strong><small>${type==="docker"?"容器镜像与容器内脚本":"宿主机脚本"}</small></header>${imageProfiles.filter(profile=>profile.profileType===type).map(profile => `
    <button type="button" data-image-profile="${esc(profile.id)}" class="${activeImageProfile?.id===profile.id?"active":""}">
      <span><strong>${esc(profile.name)}</strong><span>${profile.isPreset?"<b>预设</b>":""}${profile.scriptSource==="local"&&profile.localFileExists===false?'<b class="missing-local-file">本地脚本丢失</b>':""}</span></span><code>${profile.profileType==="docker"?esc(profile.image||"供应商默认镜像"):"VM 宿主机"}</code><small>SSH 系统必装 · 启动脚本配置</small>
    </button>`).join("")}</section>`;
  $("#imageProfileList").innerHTML = group("docker","Docker 配置")+group("vm","VM 配置");
}
async function loadImageProfiles(selectId) {
  const data = await request("/api/image-profiles");
  imageProfiles = data.profiles;
  imageProfileDefaults = data.defaults;
  profileBaseOptions();
  const selected = imageProfiles.find(item => item.id === selectId) || imageProfiles.find(item=>item.recommended) || imageProfiles[0];
  editImageProfile(selected);
  return imageProfiles;
}
$("#imageProfileList").onclick = event => {
  const button=event.target.closest("[data-image-profile]");
  if(button)editImageProfile(imageProfiles.find(item=>item.id===button.dataset.imageProfile));
};
$("#newDockerProfile").onclick=()=>{const source=imageProfiles.find(item=>item.profileType==="docker"&&item.image);editImageProfile({profileType:"docker",name:"新 Docker 开机行为",image:source?.image||"",cudaMajor:source?.cudaMajor||13,startupScript:imageProfileDefaults.startupScript});};
$("#newVmProfile").onclick=()=>editImageProfile({profileType:"vm",name:"新 VM 开机行为",image:"",cudaMajor:13,startupScript:imageProfileDefaults.vmStartupScript});
$("#duplicateImageProfile").onclick=()=>{const source=activeImageProfile;if(!source)return;editImageProfile({...source,id:"",name:`${source.name} 副本`,isPreset:false,recommended:false});};
$("#imageProfileBase").onchange=()=>{const custom=$("#imageProfileBase").value==="custom";if(custom)$("#customProfileImageWrap").removeAttribute("hidden");else $("#customProfileImageWrap").setAttribute("hidden","");$("#customProfileImageWrap").style.display=custom?"grid":"none";if(!custom){const option=$("#imageProfileBase").selectedOptions[0];$("#imageProfileCuda").value=option.dataset.cuda||"13";}};
function updateProfileTypeFields(){const vm=$("#imageProfileTypeSelect").value==="vm";$("#imageProfileBaseWrap").firstChild.textContent=vm?"Docker 镜像（可选）":"Docker 镜像（必选）";$("#imageProfileBaseWrap").hidden=false;$("#imageProfileCudaWrap").hidden=false;$("#customProfileImageWrap").hidden=$("#imageProfileBase").value!=="custom";$("#imageProfileType").textContent=vm?"VM":"Docker";}
$("#imageProfileTypeSelect").onchange=()=>{const current=$("#imageProfileBase").value;profileBaseOptions($("#imageProfileTypeSelect").value);if([...$("#imageProfileBase").options].some(option=>option.value===current))$("#imageProfileBase").value=current;updateProfileTypeFields();};
$("#imageProfileScript").oninput=localInstallPlan;
function updateStartupScriptSource(){const local=$("#startupScriptSource").value==="local";$("#startupScriptDrop").hidden=local;$("#localStartupScriptDrop").hidden=!local;$("#uploadStartupScript").hidden=local;$("#downloadStartupScript").hidden=local;$("#loadPresetStartupScript").hidden=local;}
$("#startupScriptSource").onchange=updateStartupScriptSource;
$("#loadPresetStartupScript").onclick=()=>{$("#imageProfileScript").value=activeImageProfile?.presetScript||imageProfileDefaults.startupScript;localInstallPlan();$("#imageProfileStatus").textContent="已载入预设脚本，保存后生效";};
function useScriptFile(file){if(!file)return;if(file.size>256*1024)return toast("脚本不能超过 256 KiB");const reader=new FileReader();reader.onload=()=>{$("#imageProfileScript").value=String(reader.result||"");localInstallPlan();$("#imageProfileStatus").textContent=`已载入 ${file.name}，保存后生效`;};reader.readAsText(file);}
$("#uploadStartupScript").onclick=()=>$("#startupScriptFile").click();
$("#startupScriptFile").onchange=event=>useScriptFile(event.target.files[0]);
function setLocalStartupScriptPath(localPath){if(!localPath)return;$("#localStartupScriptPath").textContent=localPath;$("#localStartupScriptPath").dataset.path=localPath;$("#localStartupScriptBubble").hidden=true;$("#imageProfileStatus").textContent="已选择本地脚本，保存后平台将按此路径读取";}
async function useLocalStartupScriptFile(file){if(!file)return;const localPath=window.fastGpuWindow?.getPathForFile?.(file);if(!localPath)return toast("浏览器无法读取文件的本地路径，请使用桌面客户端选择");setLocalStartupScriptPath(localPath);}
$("#pickLocalStartupScript").onclick=async()=>{const localPath=await window.fastGpuWindow?.pickStartupScript?.();if(localPath)setLocalStartupScriptPath(localPath);else if(!window.fastGpuWindow?.pickStartupScript)$("#localStartupScriptFile").click();};
$("#localStartupScriptFile").onchange=event=>useLocalStartupScriptFile(event.target.files[0]);
for(const type of ["dragenter","dragover"])$("#localStartupScriptDrop").addEventListener(type,event=>{event.preventDefault();event.currentTarget.classList.add("dragging");});
for(const type of ["dragleave","drop"])$("#localStartupScriptDrop").addEventListener(type,event=>{event.preventDefault();event.currentTarget.classList.remove("dragging");if(type==="drop")useLocalStartupScriptFile(event.dataTransfer.files[0]);});
for(const type of ["dragenter","dragover"])$("#startupScriptDrop").addEventListener(type,event=>{event.preventDefault();event.currentTarget.classList.add("dragging");});
for(const type of ["dragleave","drop"])$("#startupScriptDrop").addEventListener(type,event=>{event.preventDefault();event.currentTarget.classList.remove("dragging");if(type==="drop")useScriptFile(event.dataTransfer.files[0]);});
$("#downloadStartupScript").onclick=()=>{const url=URL.createObjectURL(new Blob([$("#imageProfileScript").value],{type:"text/x-shellscript"})),link=document.createElement("a");link.href=url;link.download=`${($("#imageProfileName").value||"startup").replace(/[^a-z0-9._-]+/gi,"-")}.sh`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$("#deleteImageProfile").onclick=async()=>{if(!activeImageProfile||activeImageProfile.isPreset)return;if(!activeImageProfile.id){const previous=imageProfiles.find(item=>item.id===lastFocusedImageProfileId)||imageProfiles[0];if(previous)editImageProfile(previous);return;}await request(`/api/image-profiles/${encodeURIComponent(activeImageProfile.id)}`,{method:"DELETE"});toast("配置已删除");await loadImageProfiles();};
$("#imageProfileForm").onsubmit=async event=>{event.preventDefault();const id=$("#imageProfileId").value,local=$("#startupScriptSource").value==="local",profileType=$("#imageProfileTypeSelect").value,payload={name:$("#imageProfileName").value,profileType,image:$("#imageProfileBase").value==="custom"?$("#imageProfileImage").value:$("#imageProfileBase").value,cudaMajor:Number($("#imageProfileCuda").value),kind:profileType==="vm"?"vm":activeImageProfile?.kind||"custom",downloads:[],startupScript:local?"":$("#imageProfileScript").value,startupScriptPath:local?$("#localStartupScriptPath").dataset.path:""};if(profileType==="docker"&&!payload.image)return toast("请选择 Docker 镜像");if(local&&!payload.startupScriptPath)return toast("请先选择本地启动脚本");const result=await request(id?`/api/image-profiles/${encodeURIComponent(id)}`:"/api/image-profiles",{method:id?"PUT":"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});toast("开机行为已保存");await loadImageProfiles(result.profile.id);};
loadImageProfiles().catch(error=>toast(`镜像配置加载失败：${error.message}`));
