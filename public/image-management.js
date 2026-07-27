let imageProfiles = [], imageProfileDefaults = null, activeImageProfile = null;

function createImageManagementUi() {
  const styles = document.createElement("link");
  styles.rel = "stylesheet";
  styles.href = "/image-management.css";
  document.head.append(styles);
  const button = document.createElement("button");
  button.dataset.view = "images";
  button.innerHTML = "<span>▧</span> 镜像管理";
  button.onclick = () => { go("images"); loadImageProfiles(activeImageProfile?.id).catch(error=>toast(error.message)); };
  document.querySelector('.sidebar nav button[data-view="storage"]').before(button);
  pages.images = ["镜像管理", "配置基础镜像、预下载内容与开机脚本"];
  const section = document.createElement("section");
  section.id = "images";
  section.className = "view";
  section.innerHTML = `
    <div class="image-management-head"><div><span class="eyebrow">BOOT PROFILES</span><h2>镜像与开机配置</h2><p>集中管理基础镜像、预下载文件和实例首次启动脚本。</p></div><button id="newImageProfile" class="primary" type="button">＋ 新建配置</button></div>
    <div class="image-management-layout"><aside id="imageProfileList" class="image-profile-list" aria-live="polite"></aside>
    <form id="imageProfileForm" class="image-profile-editor"><input id="imageProfileId" type="hidden">
      <div class="image-editor-head"><div><span id="imageProfileType" class="pill stopped">自定义</span><h3 id="imageEditorTitle">选择一条配置</h3></div><div class="image-editor-actions"><button id="duplicateImageProfile" type="button">复制</button><button id="deleteImageProfile" class="danger" type="button">删除</button></div></div>
      <div class="image-profile-fields"><label>配置名称<input id="imageProfileName" maxlength="120" required></label><label>基础镜像<select id="imageProfileBase"></select></label><label id="customProfileImageWrap" hidden>自定义镜像地址<input id="imageProfileImage" placeholder="registry/namespace/image:tag"></label><label>CUDA 主版本<select id="imageProfileCuda"><option value="13">CUDA 13</option><option value="12">CUDA 12</option></select></label><label class="image-downloads-field">开机预下载 URL（每行一条）<textarea id="imageProfileDownloads" rows="4" placeholder="https://example.com/model.tar.zst"></textarea></label></div>
      <div class="script-toolbar"><strong>开机启动脚本</strong><div><button id="loadPresetStartupScript" type="button">载入预设脚本</button><button id="uploadStartupScript" type="button">上传覆盖</button><button id="downloadStartupScript" type="button">下载脚本</button><input id="startupScriptFile" type="file" accept=".sh,text/x-shellscript,text/plain" hidden></div></div>
      <div id="startupScriptDrop" class="startup-script-drop"><textarea id="imageProfileScript" rows="18" spellcheck="false" placeholder="#!/usr/bin/env bash"></textarea><small>可将 .sh 文件拖到此处覆盖编辑器内容</small></div>
      <div class="install-plan"><div><strong>识别到的安装与下载内容</strong><small>仅作辅助预览，最终以脚本原文为准。</small></div><div id="imageInstallPlan"></div></div>
      <div class="image-save-row"><span id="imageProfileStatus"></span><button class="primary" type="submit">保存配置</button></div>
    </form></div>`;
  document.querySelector("main").append(section);
}
createImageManagementUi();
if ($("#imageVersion")?.parentElement?.firstChild)
  $("#imageVersion").parentElement.firstChild.nodeValue = "开机配置";

function profileBaseOptions() {
  const values = [...new Map(imageProfiles.map(item => [item.image, item])).values()];
  $("#imageProfileBase").innerHTML = values.map(item =>
    `<option value="${esc(item.image)}" data-cuda="${item.cudaMajor}">${esc(item.image)}</option>`
  ).join("") + '<option value="custom">自定义镜像地址…</option>';
}
function renderInstallPlan(plan = []) {
  const labels = {apt:"APT",pip:"PIP",npm:"NPM",download:"下载"};
  $("#imageInstallPlan").innerHTML = plan.length ? plan.map(item =>
    `<span><b>${labels[item.type] || esc(item.type)}</b>${esc(item.value)}</span>`
  ).join("") : "<small>尚未识别到标准安装命令；脚本仍会完整执行。</small>";
}
function localInstallPlan() {
  const script = $("#imageProfileScript").value.replace(/\\\r?\n/g, " "), results = [];
  for (const value of $("#imageProfileDownloads").value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean)) results.push({type:"download",value});
  const patterns = [["apt",/(?:apt-get|apt)\s+install(?:\s+-[^\s]+)*\s+([^;&\n]+)/g],["pip",/(?:pip3?|python3?\s+-m\s+pip)\s+install(?:\s+-[^\s]+)*\s+([^;&\n]+)/g],["npm",/npm\s+install(?:\s+-[^\s]+)*\s+([^;&\n]+)/g],["download",/(?:curl|wget)\b[^\n]*(https?:\/\/[^\s'";]+)/g]];
  for(const [type,pattern] of patterns)for(const match of script.matchAll(pattern)){const values=type==="download"?[match[1]]:match[1].trim().split(/\s+/).filter(x=>!x.startsWith("-"));for(const value of values)results.push({type,value});}
  renderInstallPlan(results.filter((item,index)=>results.findIndex(other=>other.type===item.type&&other.value===item.value)===index).slice(0,80));
}
function editImageProfile(profile) {
  activeImageProfile = profile;
  $("#imageProfileId").value = profile?.id || "";
  $("#imageProfileName").value = profile?.name || "新开机配置";
  $("#imageProfileCuda").value = String(profile?.cudaMajor || 13);
  $("#imageProfileDownloads").value = (profile?.downloads || []).join("\n");
  $("#imageProfileScript").value = profile?.startupScript ?? imageProfileDefaults?.startupScript ?? "";
  $("#imageEditorTitle").textContent = profile?.name || "新建配置";
  $("#imageProfileType").textContent = profile?.isPreset ? "系统预设" : "自定义";
  $("#imageProfileType").className = `pill ${profile?.isPreset ? "ready" : "stopped"}`;
  $("#deleteImageProfile").disabled = !profile || profile.isPreset;
  const known = [...$("#imageProfileBase").options].some(option => option.value === profile?.image);
  $("#imageProfileBase").value = known ? profile.image : "custom";
  $("#customProfileImageWrap").hidden = known;
  $("#imageProfileImage").value = known ? "" : (profile?.image || "");
  $("#imageProfileStatus").textContent = "";
  renderInstallPlan(profile?.installPlan || []);
  renderImageProfileList();
}
function renderImageProfileList() {
  $("#imageProfileList").innerHTML = imageProfiles.map(profile => `
    <button type="button" data-image-profile="${esc(profile.id)}" class="${activeImageProfile?.id===profile.id?"active":""}">
      <span><strong>${esc(profile.name)}</strong>${profile.isPreset?"<b>预设</b>":""}</span><code>${esc(profile.image)}</code><small>CUDA ${profile.cudaMajor} · ${(profile.downloads||[]).length} 个预下载</small>
    </button>`).join("");
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
$("#newImageProfile").onclick=()=>editImageProfile(null);
$("#duplicateImageProfile").onclick=()=>{const source=activeImageProfile;if(!source)return;editImageProfile({...source,id:"",name:`${source.name} 副本`,isPreset:false,recommended:false});};
$("#imageProfileBase").onchange=()=>{const custom=$("#imageProfileBase").value==="custom";$("#customProfileImageWrap").hidden=!custom;if(!custom){const option=$("#imageProfileBase").selectedOptions[0];$("#imageProfileCuda").value=option.dataset.cuda||"13";}};
$("#imageProfileScript").oninput=localInstallPlan;
$("#imageProfileDownloads").oninput=localInstallPlan;
$("#loadPresetStartupScript").onclick=()=>{$("#imageProfileScript").value=activeImageProfile?.presetScript||imageProfileDefaults.startupScript;localInstallPlan();$("#imageProfileStatus").textContent="已载入预设脚本，保存后生效";};
function useScriptFile(file){if(!file)return;if(file.size>256*1024)return toast("脚本不能超过 256 KiB");const reader=new FileReader();reader.onload=()=>{$("#imageProfileScript").value=String(reader.result||"");localInstallPlan();$("#imageProfileStatus").textContent=`已载入 ${file.name}，保存后生效`;};reader.readAsText(file);}
$("#uploadStartupScript").onclick=()=>$("#startupScriptFile").click();
$("#startupScriptFile").onchange=event=>useScriptFile(event.target.files[0]);
for(const type of ["dragenter","dragover"])$("#startupScriptDrop").addEventListener(type,event=>{event.preventDefault();event.currentTarget.classList.add("dragging");});
for(const type of ["dragleave","drop"])$("#startupScriptDrop").addEventListener(type,event=>{event.preventDefault();event.currentTarget.classList.remove("dragging");if(type==="drop")useScriptFile(event.dataTransfer.files[0]);});
$("#downloadStartupScript").onclick=()=>{const url=URL.createObjectURL(new Blob([$("#imageProfileScript").value],{type:"text/x-shellscript"})),link=document.createElement("a");link.href=url;link.download=`${($("#imageProfileName").value||"startup").replace(/[^a-z0-9._-]+/gi,"-")}.sh`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$("#deleteImageProfile").onclick=async()=>{if(!activeImageProfile||activeImageProfile.isPreset)return;await request(`/api/image-profiles/${encodeURIComponent(activeImageProfile.id)}`,{method:"DELETE"});toast("配置已删除");await loadImageProfiles();};
$("#imageProfileForm").onsubmit=async event=>{event.preventDefault();const id=$("#imageProfileId").value,payload={name:$("#imageProfileName").value,image:$("#imageProfileBase").value==="custom"?$("#imageProfileImage").value:$("#imageProfileBase").value,cudaMajor:Number($("#imageProfileCuda").value),kind:activeImageProfile?.kind||"custom",downloads:$("#imageProfileDownloads").value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean),startupScript:$("#imageProfileScript").value};const result=await request(id?`/api/image-profiles/${encodeURIComponent(id)}`:"/api/image-profiles",{method:id?"PUT":"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});toast("镜像配置已保存");await loadImageProfiles(result.profile.id);};
loadImageProfiles().catch(error=>toast(`镜像配置加载失败：${error.message}`));
