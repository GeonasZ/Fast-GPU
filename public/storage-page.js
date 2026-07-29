const storageProviderFields = {
  r2: {
    enabled: "#r2Enabled",
    endpoint: "#r2Endpoint",
    bucket: "#r2Bucket",
    prefix: "#r2Prefix",
    region: "#r2Region",
    accessKey: "#r2AccessKey",
    secretKey: "#r2SecretKey",
    hint: "#r2Hint",
  },
  oss: {
    enabled: "#ossEnabled",
    endpoint: "#ossEndpoint",
    bucket: "#ossBucket",
    prefix: "#ossPrefix",
    region: "#ossRegion",
    accessKey: "#ossAccessKey",
    secretKey: "#ossSecretKey",
    hint: "#ossHint",
  },
};
const storageProviderConfigured = Object.fromEntries(
  Object.keys(storageProviderFields).map((provider) => [provider, false]),
);
const storageProviderProfiles = Object.fromEntries(
  Object.keys(storageProviderFields).map((provider) => [provider, []]),
);
var storagePageReady = false;
for (const field of [
  {
    ids: ["#r2Bucket", "#ossBucket"],
    label: "Bucket Name",
    placeholder: "请输入 Bucket Name",
    description: "对象存储 Bucket Name",
  },
  {
    ids: ["#r2AccessKey", "#ossAccessKey"],
    label: "S3 Access Key ID",
    placeholder: "请输入 S3 Access Key ID",
    description: "在供应商控制台创建的 S3 Access Key ID（不是云账号或登录邮箱）",
  },
  {
    ids: ["#r2SecretKey", "#ossSecretKey"],
    label: "S3 Secret Access Key",
    placeholder: "请输入 S3 Secret Access Key",
    description: "在供应商控制台创建的 S3 Secret Access Key（不是云账号登录密码）",
  },
])
  for (const id of field.ids) {
    const input = $(id),
    labelText = [...input.closest("label").childNodes].find(
      (node) => node.nodeType === Node.TEXT_NODE,
    );
    if (labelText) labelText.textContent = field.label;
    input.placeholder = field.placeholder;
    input.setAttribute("aria-label", field.description);
  }

// <legend> renders in the fieldset border region, so the card header floats
// over the card edge. Promote it to a normal grid item that lives inside the
// padded card.
function normalizeStorageCards() {
  document.querySelectorAll("[data-storage-provider]").forEach((card) => {
    const legend = card.querySelector(":scope > legend");
    if (legend) {
      const head = document.createElement("div");
      head.className = "s3-legend" + (legend.className ? " " + legend.className : "");
      while (legend.firstChild) head.append(legend.firstChild);
      legend.replaceWith(head);
    }
  });
}
normalizeStorageCards();
$("#s3Form > .s3-actions button[type='submit']").hidden = true;
const globalStorageSave = $("#s3Form > .s3-actions button[type='submit']");
$("#s3Form > .s3-actions button[type='submit']").textContent = "保存并测试";
for (const [provider, fields] of Object.entries(storageProviderFields)) {
  const card = document.querySelector(`[data-storage-provider="${provider}"]`),
    manager = document.createElement("div");
  fields.profile = `#${provider}StorageProfile`;
  fields.name = `#${provider}StorageProfileName`;
  fields.add = `#${provider}StorageProfileAdd`;
  fields.remove = `#${provider}StorageProfileRemove`;
  fields.edit = `#${provider}StorageProfileEdit`;
  fields.save = `#${provider}StorageProfileSave`;
  fields.card = card;
  fields.dirty = false;
  manager.className = "storage-profile-manager";
  manager.innerHTML = `<label>配置<select id="${provider}StorageProfile"></select></label><label>配置名称<input id="${provider}StorageProfileName" maxlength="60" placeholder="例如：生产数据"></label><div class="storage-profile-actions"><button id="${provider}StorageProfileAdd" type="button">新增</button><button id="${provider}StorageProfileRemove" class="danger" type="button">删除</button></div>`;
  manager.querySelector("label").classList.add("storage-profile-picker");
  card.querySelector(":scope > .s3-legend").after(manager);
  manager.insertAdjacentHTML("beforeend", `<div class="storage-profile-summary"><strong id="${provider}StorageProfileSummary">暂无配置</strong><small id="${provider}StorageProfileMeta"></small></div><button id="${provider}StorageProfileEdit" type="button" hidden>编辑</button><button id="${provider}StorageProfileSave" type="button" class="primary" hidden>保存并测试</button>`);
  const editor = document.createElement("div"),
    editorActions = document.createElement("div");
  editor.className = "storage-profile-editor";
  editor.hidden = true;
  editorActions.className = "storage-profile-editor-actions";
  manager.after(editor);
  editor.append(manager.querySelector(":scope > label:not(.storage-profile-picker)"));
  for (const element of [...card.querySelectorAll(":scope > label, :scope > .storage-provider-hint")])
    editor.append(element);
  editor.append(editorActions);
  editorActions.append($(`#${provider}StorageProfileSave`));
  fields.editor = editor;
  for (const input of editor.querySelectorAll("input, select")) {
    input.addEventListener("input", () => { fields.dirty = true; });
    input.addEventListener("change", () => { fields.dirty = true; });
  }
}
// Provider Prefix is part of the stored profile and is included in every upload target.

function wrapStorageSection(element, title, description, className = "") {
  const details = document.createElement("details"),
    summary = document.createElement("summary"),
    heading = document.createElement("span"),
    copy = document.createElement("small");
  details.className = `storage-disclosure ${className}`.trim();
  heading.textContent = title;
  copy.textContent = description;
  summary.append(heading, copy);
  element.before(details);
  details.append(summary, element);
  return details;
}

const storageProviderDisclosure = wrapStorageSection(
  $("#s3Form"),
  "S3 供应商配置",
  "管理 Cloudflare R2 与阿里云 OSS 的连接凭据",
  "storage-provider-disclosure",
);
const storageUnavailable = document.createElement("div");
storageUnavailable.id = "storageUnavailable";
storageUnavailable.className = "table-card storage-unavailable";
storageUnavailable.textContent = "请先至少启用一个对象存储以开始";
storageProviderDisclosure.after(storageUnavailable);
const storageSummaryActions = document.createElement("span");
storageSummaryActions.className = "storage-summary-actions";
$("#storage .storage-settings").append(storageSummaryActions);
for (const provider of Object.keys(storageProviderFields)) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.storageSummaryProvider = provider;
  button.textContent = `${provider === "r2" ? "R2" : "OSS"} 新增`;
  button.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    storageProviderDisclosure.hidden = false;
    storageProviderDisclosure.open = true;
    if (storageProviderProfiles[provider].length)
      $(storageProviderFields[provider].edit).click();
    else $(storageProviderFields[provider].add).click();
  };
  storageSummaryActions.append(button);
}
// Its open state depends on server configuration. Exclude it from the first
// paint so a configured form does not appear expanded before closing.
storageProviderDisclosure.hidden = true;
$("#storagePrimary")?.closest("label")?.remove();
$("#storage .storage-settings p").textContent =
  "配置 S3-compatible 存储；新实例不会自动读取数据，按需手动同步。";

$("#storageUploadCard").insertAdjacentHTML(
  "beforebegin",
  '<section id="storageBrowser" class="table-card storage-browser"><header><div><span class="eyebrow">BUCKET CONTENTS</span><h3>查看 Bucket 内容</h3></div><button id="storageBrowserRefresh" type="button">刷新</button></header><div class="storage-browser-controls"><label>存储源<select id="storageBrowserProvider"><option value="r2">Cloudflare R2</option><option value="oss">阿里云 OSS</option></select></label><label>Prefix<input id="storageBrowserPrefix" placeholder="Bucket 根目录"></label><button id="storageBrowserOpen" class="primary" type="button">查看</button></div><div class="storage-browser-selection"><label><input id="storageBrowserSelectAll" type="checkbox">选择当前已加载对象</label><button id="storageBrowserDelete" class="danger" type="button" disabled>删除所选对象</button></div><div id="storageBrowserMeta" class="storage-browser-meta">先选择一个已启用的存储源。</div><div id="storageBrowserList" class="storage-browser-list"></div><button id="storageBrowserMore" type="button" hidden>加载更多</button></section>',
);
let storageBrowserToken = null,
  storageBrowserSelected = new Set();
function updateStorageBrowserSelection() {
  const checks = [...document.querySelectorAll("[data-storage-object-key]")],
    selected = checks.filter((item) => item.checked).length;
  $("#storageBrowserSelectAll").checked = Boolean(checks.length) && selected === checks.length;
  $("#storageBrowserSelectAll").indeterminate = selected > 0 && selected < checks.length;
  $("#storageBrowserDelete").disabled = !storageBrowserSelected.size;
  $("#storageBrowserDelete").textContent = storageBrowserSelected.size
    ? `删除所选对象（${storageBrowserSelected.size}）`
    : "删除所选对象";
}
function formatObjectSize(bytes) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = Number(bytes) || 0,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit ? value.toFixed(value >= 10 ? 1 : 2) : value} ${units[unit]}`;
}
async function loadStorageObjects(append = false) {
  const provider = $("#storageBrowserProvider").value,
    prefix = $("#storageBrowserPrefix").value.trim().replace(/^\/+|\/+$/g, ""),
    params = new URLSearchParams({ provider, prefix });
  if (append && storageBrowserToken)
    params.set("continuationToken", storageBrowserToken);
  if (!append) storageBrowserSelected = new Set();
  $("#storageBrowserMeta").textContent = "正在读取 Bucket…";
  try {
    const result = await request(`/api/storage/objects?${params}`),
      rows = [
        ...(result.prefixes || []).map((item) => ({ type: "prefix", key: item })),
        ...(result.objects || []).map((item) => ({ type: "object", ...item })),
      ],
      html = rows
        .map((item) =>
          item.type === "prefix"
            ? `<button type="button" class="storage-browser-row storage-browser-folder" data-prefix="${esc(item.key.replace(/\/$/, ""))}"><span>目录</span><strong>${esc(item.key)}</strong><small>打开</small></button>`
            : `<label class="storage-browser-row"><input type="checkbox" data-storage-object-key="${esc(item.key)}"><strong title="${esc(item.key)}">${esc(item.key)}</strong><small>${formatObjectSize(item.size)} · ${item.lastModified ? new Date(item.lastModified).toLocaleString() : "时间未知"}</small></label>`,
        )
        .join("");
    if (append) $("#storageBrowserList").insertAdjacentHTML("beforeend", html);
    else $("#storageBrowserList").innerHTML = html || '<div class="storage-browser-empty">当前 Prefix 下没有对象</div>';
    storageBrowserToken = result.nextContinuationToken;
    $("#storageBrowserMore").hidden = !storageBrowserToken;
    $("#storageBrowserMeta").textContent = `${result.provider.toUpperCase()} · ${result.bucket} · ${result.prefix || "根目录"}`;
    updateStorageBrowserSelection();
  } catch (error) {
    if (!append) $("#storageBrowserList").innerHTML = "";
    $("#storageBrowserMeta").textContent = `读取失败：${error.message}。请确认凭据具有 ListBucket 权限。`;
    $("#storageBrowserMore").hidden = true;
  }
}
$("#storageBrowserOpen").onclick = () => loadStorageObjects(false);
$("#storageBrowserRefresh").onclick = () => loadStorageObjects(false);
$("#storageBrowserMore").onclick = () => loadStorageObjects(true);
$("#storageBrowserSelectAll").onchange = function () {
  for (const checkbox of document.querySelectorAll("[data-storage-object-key]")) {
    checkbox.checked = this.checked;
    if (this.checked) storageBrowserSelected.add(checkbox.dataset.storageObjectKey);
    else storageBrowserSelected.delete(checkbox.dataset.storageObjectKey);
  }
  updateStorageBrowserSelection();
};
$("#storageBrowserList").onchange = (event) => {
  const checkbox = event.target.closest("[data-storage-object-key]");
  if (!checkbox) return;
  if (checkbox.checked) storageBrowserSelected.add(checkbox.dataset.storageObjectKey);
  else storageBrowserSelected.delete(checkbox.dataset.storageObjectKey);
  updateStorageBrowserSelection();
};
$("#storageBrowserDelete").onclick = async function () {
  const keys = [...storageBrowserSelected];
  if (!keys.length || !(await confirmStorageObjectDelete(keys))) return;
  setButtonBusy(this, "正在删除…");
  try {
    const result = await request("/api/storage/objects", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: $("#storageBrowserProvider").value, keys }),
    });
    toast(`已删除 ${result.deleted?.length || 0} 个对象`);
    await loadStorageObjects(false);
  } catch (error) {
    toast("删除对象失败：" + error.message);
  } finally {
    clearButtonBusy(this);
    updateStorageBrowserSelection();
  }
};


document.body.insertAdjacentHTML("beforeend", '<dialog id="storageDeleteDialog" class="storage-confirm-dialog"><form method="dialog"><div class="storage-confirm-icon" aria-hidden="true">!</div><div><span class="eyebrow">DELETE OBJECTS</span><h3>永久删除所选对象？</h3><p>这些对象将立即从 Bucket 中删除，且无法恢复。</p><div id="storageDeleteSummary" class="storage-delete-summary"></div></div><menu><button value="cancel">取消</button><button value="confirm" class="danger">永久删除</button></menu></form></dialog>');
function confirmStorageObjectDelete(keys) {
  const dialog = $("#storageDeleteDialog"), summary = $("#storageDeleteSummary");
  summary.innerHTML = `<strong>${keys.length} 个对象</strong><small>${keys.slice(0, 3).map(esc).join("<br>")}${keys.length > 3 ? `<br>以及另外 ${keys.length - 3} 个对象` : ""}</small>`;
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true }));
}
$("#storageBrowserList").onclick = (event) => {
  const folder = event.target.closest("[data-prefix]");
  if (!folder) return;
  $("#storageBrowserPrefix").value = folder.dataset.prefix;
  loadStorageObjects(false);
};

for (const provider of [
  {
    id: "r2",
    url: "https://dash.cloudflare.com/?to=/:account/r2",
    windowName: "fast-gpu-cloudflare-r2",
    label: "前往 Cloudflare R2 获取 Access Key",
  },
  {
    id: "oss",
    url: "https://oss.console.aliyun.com/overview",
    windowName: "fast-gpu-aliyun-oss",
    label: "前往阿里云 OSS 获取 AccessKey",
  },
]) {
  const legend = document.querySelector(
      `[data-storage-provider="${provider.id}"] .s3-legend`,
    ),
    toggle = legend.querySelector(".storage-toggle"),
    actions = document.createElement("span"),
    button = document.createElement("button");
  actions.className = "storage-provider-actions";
  button.type = "button";
  button.className = "storage-console-link";
  button.textContent = "前往获取凭证 ↗";
  button.setAttribute("aria-label", provider.label);
  button.onclick = () => openProviderWindow(provider.url, provider.windowName);
  actions.append(button, toggle);
  legend.append(actions);
}
$("#r2Region").disabled = true;
$("#r2Region").classList.add("fixed-storage-value");
$("#r2Region").insertAdjacentHTML(
  "afterend",
  '<small class="fixed-storage-hint">R2 的 S3 API 固定使用 auto</small>',
);
storageProviderDisclosure.insertAdjacentHTML(
  "afterend",
  '<form id="existingStorageForm" class="table-card existing-storage"><div><span class="eyebrow">MANUAL SYNC</span><h3>按需同步到实例</h3><p>选择 Bucket 内的目录或文件，再复制或挂载到实例。</p></div><label>运行中的实例<select id="existingStorageInstance" required><option value="">正在加载…</option></select></label><label>存储源<select id="existingStorageProvider"><option value="r2">Cloudflare R2</option><option value="oss">阿里云 OSS</option></select></label><label>Bucket 内目录或文件<div class="storage-path-picker"><input id="existingStoragePrefix" readonly placeholder="整个 Bucket"><button id="existingStorageBrowse" type="button">浏览…</button></div></label><label>实例目标目录<input id="existingStorageTarget" value="/data/datasets"></label><label>操作<select id="existingStorageMode"><option value="copy">复制到本地磁盘</option><option value="mount">只读挂载</option></select><small id="existingStorageModeHelp" class="storage-mode-help"></small><span id="existingStorageAutoInstallRow" class="storage-auto-install"><input id="existingStorageAutoInstall" type="checkbox" checked disabled>自动安装必要依赖</span></label><button class="primary" type="submit">开始复制</button><small id="existingStorageHint">新实例不会自动读取 S3；请选择内容后再执行操作。</small></form>',
);
document.body.insertAdjacentHTML(
  "beforeend",
  '<dialog id="storagePathDialog" class="storage-path-dialog"><form method="dialog"><header><div><span class="eyebrow">BUCKET BROWSER</span><h3>选择目录或文件</h3></div><button class="close" value="cancel" aria-label="关闭">×</button></header><div id="storagePathBreadcrumb" class="storage-path-breadcrumb"></div><div id="storagePathMeta" class="storage-browser-meta"></div><div id="storagePathList" class="storage-browser-list"></div><menu><button value="cancel">取消</button><button id="storagePathChooseFolder" type="button" class="primary">选择当前目录</button></menu></form></dialog>',
);
const existingStorageDisclosure = wrapStorageSection(
  $("#existingStorageForm"),
  "同步到实例",
  "选择 Bucket 文件夹并手动同步或挂载",
);
const storageBrowserDisclosure = wrapStorageSection(
  $("#storageBrowser"),
  "浏览 Bucket",
  "查看目录、选择对象或删除文件",
);
const storageUploadDisclosure = wrapStorageSection(
  $("#storageUploadCard"),
  "上传文件",
  "选择文件或文件夹，按需打包并上传",
);
existingStorageDisclosure.hidden = true;
storageBrowserDisclosure.hidden = true;
storageUploadDisclosure.hidden = true;
let existingStorageInstances = new Map();
let existingStorageProviderConfigs = {};
const existingStorageDraftKey = "fast-gpu-existing-storage-v1";
function readExistingStorageDraft() {
  try { return JSON.parse(localStorage.getItem(existingStorageDraftKey) || "{}"); }
  catch { return {}; }
}
function saveExistingStorageDraft() {
  localStorage.setItem(existingStorageDraftKey, JSON.stringify({
    instance: $("#existingStorageInstance").value,
    provider: $("#existingStorageProvider").value,
    prefix: $("#existingStoragePrefix").value,
    selectionType: $("#existingStoragePrefix").dataset.selectionType || "prefix",
    target: $("#existingStorageTarget").value,
    mode: $("#existingStorageMode").value,
    autoInstall: $("#existingStorageAutoInstall").checked,
  }));
}
function updateExistingStorageMode() {
  const mount = $("#existingStorageMode").value === "mount";
  $("#existingStorageModeHelp").textContent = mount
    ? "不下载完整数据，使用时从 S3 读取；依赖网络，断开前需卸载。"
    : "下载一份到实例磁盘；完成后可离线使用，不会删除目标目录中的其他文件。";
  $("#existingStorageAutoInstallRow").lastChild.textContent = mount
    ? "自动安装 rclone 和挂载依赖"
    : "自动安装 rclone";
  $("#existingStorageForm button[type='submit']").textContent = mount ? "开始挂载" : "开始复制";
}
async function loadExistingStorageInstances() {
  const response = await request("/api/instances");
  const available = response.instances || [];
  existingStorageInstances = new Map(available.map((item) => [String(item.id), item]));
  $("#existingStorageInstance").innerHTML =
    '<option value="">请选择实例</option>' +
    available
      .map((item) => `<option value="${esc(item.id)}">${esc(item.name)} · ${esc(item.provider)} · ${item.status === "running" ? "运行中" : "需先启动"}</option>`)
      .join("");
  const draft = readExistingStorageDraft();
  if (existingStorageInstances.has(String(draft.instance || "")))
    $("#existingStorageInstance").value = String(draft.instance);
}
$("#existingStorageMode").onchange = function () {
  $("#existingStorageTarget").value =
    this.value === "mount" ? `/data/object-storage/${$("#existingStorageProvider").value}` : "/data/datasets";
  updateExistingStorageMode();
  saveExistingStorageDraft();
};
$("#existingStorageProvider").onchange = function () {
  $("#existingStoragePrefix").value = "";
  $("#existingStoragePrefix").dataset.selectionType = "prefix";
  if ($("#existingStorageMode").value === "mount")
    $("#existingStorageTarget").value = `/data/object-storage/${this.value}`;
  saveExistingStorageDraft();
};
$("#existingStorageTarget").oninput = saveExistingStorageDraft;
$("#existingStorageAutoInstall").onchange = saveExistingStorageDraft;
updateExistingStorageMode();

let storagePathPrefix = "";
async function loadStoragePathDialog(prefix = "") {
  const provider = $("#existingStorageProvider").value;
  storagePathPrefix = String(prefix).replace(/^\/+|\/+$/g, "");
  $("#storagePathMeta").textContent = "正在读取 Bucket…";
  $("#storagePathList").innerHTML = "";
  const parts = storagePathPrefix ? storagePathPrefix.split("/") : [];
  $("#storagePathBreadcrumb").innerHTML = [
    '<button type="button" data-storage-path-prefix="">Bucket 根目录</button>',
    ...parts.map((part, index) => `<span>/</span><button type="button" data-storage-path-prefix="${esc(parts.slice(0, index + 1).join("/"))}">${esc(part)}</button>`),
  ].join("");
  try {
    const result = await request(`/api/storage/objects?${new URLSearchParams({ provider, prefix: storagePathPrefix })}`),
      rows = [
        ...(result.prefixes || []).map((key) => ({ type: "prefix", key: key.replace(/\/$/, "") })),
        ...(result.objects || []).map((item) => ({ type: "object", ...item })),
      ];
    $("#storagePathMeta").textContent = `${result.provider.toUpperCase()} · ${result.bucket} · ${result.prefix || "根目录"}`;
    $("#storagePathList").innerHTML = rows.map((item) => item.type === "prefix"
      ? `<button type="button" class="storage-browser-row storage-browser-folder" data-storage-path-open="${esc(item.key)}"><span>目录</span><strong>${esc(item.key.split("/").at(-1))}</strong><small>打开</small></button>`
      : `<button type="button" class="storage-browser-row storage-path-file" data-storage-path-file="${esc(item.key)}"><span>文件</span><strong title="${esc(item.key)}">${esc(item.key.split("/").at(-1))}</strong><small>${formatObjectSize(item.size)}</small></button>`
    ).join("") || '<div class="storage-browser-empty">当前目录为空</div>';
  } catch (error) {
    $("#storagePathMeta").textContent = `读取失败：${error.message}`;
  }
}
function chooseExistingStoragePath(prefix) {
  $("#existingStoragePrefix").value = prefix;
  $("#existingStoragePrefix").dataset.selectionType = prefix === storagePathPrefix ? "prefix" : "object";
  saveExistingStorageDraft();
  $("#storagePathDialog").close();
}
$("#existingStorageBrowse").onclick = () => {
  $("#storagePathDialog").showModal();
  loadStoragePathDialog($("#existingStoragePrefix").value);
};
$("#storagePathBreadcrumb").onclick = (event) => {
  const button = event.target.closest("[data-storage-path-prefix]");
  if (button) loadStoragePathDialog(button.dataset.storagePathPrefix);
};
$("#storagePathList").onclick = (event) => {
  const folder = event.target.closest("[data-storage-path-open]"),
    file = event.target.closest("[data-storage-path-file]");
  if (folder) loadStoragePathDialog(folder.dataset.storagePathOpen);
  else if (file) chooseExistingStoragePath(file.dataset.storagePathFile);
};
$("#storagePathChooseFolder").onclick = () => chooseExistingStoragePath(storagePathPrefix);
$("#existingStorageForm").onsubmit = async function (event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button"),
    id = $("#existingStorageInstance").value,
    instance = existingStorageInstances.get(id);
  if (!instance) return toast("请选择一个运行中的实例");
  if (instance.status !== "running")
    return toast("请确保实例正在运行且 SSH 正常工作");
  if (
    $("#existingStorageMode").value === "mount" &&
    $("#existingStoragePrefix").dataset.selectionType === "object"
  )
    return toast("只读挂载只支持 Bucket 或目录；单个文件请使用复制到本地磁盘");
  setButtonBusy(button, "正在同步…");
  $("#existingStorageHint").textContent = "正在检查依赖…";
  try {
    const url = `/api/instances/${encodeURIComponent(id)}/object-storage`,
      payload = {
        instanceProvider: instance.provider,
        provider: $("#existingStorageProvider").value,
        prefix: $("#existingStoragePrefix").value,
        target: $("#existingStorageTarget").value,
        mode: $("#existingStorageMode").value,
        autoInstall: $("#existingStorageAutoInstall").checked,
      },
      options = (body) => ({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      check = await request(url, options({ ...payload, phase: "check" }));
    if (!check.dependenciesReady) {
      $("#existingStorageHint").textContent = "正在安装依赖…";
      await request(url, options({ ...payload, phase: "prepare" }));
    }
    $("#existingStorageHint").textContent = "正在同步 S3 数据…";
    const result = await request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    saveExistingStorageDraft();
    // Do not expose verbose remote package-manager output in the form status.
    $("#existingStorageHint").textContent = result.mode === "mount"
      ? `S3 已挂载到 ${result.target}`
      : `S3 数据已同步到 ${result.target}`;
    toast(result.mode === "mount" ? "对象存储已只读挂载" : "对象存储同步完成");
  } catch (error) {
    $("#existingStorageHint").textContent = `${error.message}。请确保实例正在运行且 SSH 正常工作。`;
    toast("同步 S3 数据失败：" + error.message);
  } finally {
    clearButtonBusy(button);
  }
};
$("#existingStorageForm button[type='submit']").insertAdjacentHTML(
  "beforebegin",
  '<button id="disconnectExistingStorage" type="button" hidden>安全断开挂载</button>',
);
$("#existingStorageInstance").onchange = async function () {
  const instance = existingStorageInstances.get(this.value),
    button = $("#disconnectExistingStorage");
  button.hidden = true;
  saveExistingStorageDraft();
  if (!instance) return;
  if (instance.status !== "running") {
    $("#existingStorageHint").textContent =
      "可以先编辑配置；启动实例后才能读取状态、同步或挂载。";
    return;
  }
  try {
    const state = await request(
      `/api/instances/${encodeURIComponent(instance.id)}/object-storage?instanceProvider=${encodeURIComponent(instance.provider)}`,
    );
    if (!state.provider) return;
    $("#existingStorageProvider").value = state.provider;
    $("#existingStoragePrefix").value = state.prefix || "";
    $("#existingStoragePrefix").dataset.selectionType = "prefix";
    $("#existingStorageTarget").value = state.target || "/data/datasets";
    $("#existingStorageMode").value = state.mode || "copy";
    updateExistingStorageMode();
    saveExistingStorageDraft();
    $("#existingStorageHint").textContent =
      state.mode === "mount"
        ? state.mounted
          ? `当前已挂载 ${state.source} → ${state.target}`
          : "记录中的挂载已断开，可重新应用"
        : `最近同步：${state.source} → ${state.target}`;
    button.hidden = state.mode !== "mount" || !state.mounted;
  } catch (error) {
    $("#existingStorageHint").textContent = "读取实例 S3 状态失败：" + error.message;
  }
};
$("#disconnectExistingStorage").onclick = async function () {
  const instance = existingStorageInstances.get($("#existingStorageInstance").value);
  if (!instance) return;
  setButtonBusy(this, "正在断开…");
  try {
    await request(
      `/api/instances/${encodeURIComponent(instance.id)}/object-storage?instanceProvider=${encodeURIComponent(instance.provider)}&target=${encodeURIComponent($("#existingStorageTarget").value)}`,
      { method: "DELETE" },
    );
    this.hidden = true;
    $("#existingStorageHint").textContent = "挂载已安全断开；S3 中的对象没有被删除。";
    toast("S3 挂载已安全断开");
  } catch (error) {
    toast("断开挂载失败：" + error.message);
  } finally {
    clearButtonBusy(this);
  }
};
function setPageTitleAlert(text) {
  const alert = $("#pageTitleAlert");
  if (!alert) return;
  if (!text) {
    alert.hidden = true;
    return;
  }
  alert.textContent = text;
  alert.hidden = false;
}
// 根据已启用且已配置的供应商，刷新「上传到对象存储」卡片的目标 Bucket 选择器，
// 并在没有任何可用源时回退到占位提示。保存后 loadS3Config() 会调用本函数，
// 因此绝不能缺失，否则保存即使成功也会因为这里抛 ReferenceError 而提示「保存失败」。
function updateStorageUploadProviders(providers) {
  const select = $("#storageUploadProvider"),
    unavailable = $("#storageUploadUnavailable"),
    form = $("#storageUploadForm");
  if (!select || !unavailable || !form) return;
  const labels = { r2: "Cloudflare R2", oss: "阿里云 OSS" };
  const available = Object.entries(providers || {}).filter(
    ([, item]) => item && item.enabled && item.configured,
  );
  const previous = select.value;
  select.innerHTML = available
    .map(
      ([id, item]) =>
        `<option value="${esc(id)}">${esc(labels[id] || id.toUpperCase())}${item.bucket ? " · " + esc(item.bucket) : ""}</option>`,
    )
    .join("");
  if (available.length) {
    if (!available.some(([id]) => id === previous)) select.value = available[0][0];
    unavailable.hidden = true;
    form.hidden = false;
  } else {
    unavailable.hidden = false;
    form.hidden = true;
  }
}
function showStorageProfile(provider, profileId) {
  const fields = storageProviderFields[provider],
    profiles = storageProviderProfiles[provider],
    profile = profiles.find((item) => item.id === profileId) || null;
  $(fields.profile).value = profile?.id || "";
  $(fields.name).value = profile?.name || `配置 ${profiles.length + 1}`;
  $(fields.endpoint).value = profile?.endpoint || "";
  $(fields.bucket).value = profile?.bucket || "";
  $(fields.prefix).value = profile?.prefix || "";
  $(fields.region).value = profile?.region || (provider === "r2" ? "auto" : "");
  $(fields.accessKey).value = profile?.accessKeyId || "";
  $(fields.secretKey).value = profile?.secretAccessKey || "";
  $(fields.remove).disabled = !profile;
  $(fields.remove).hidden = !profile;
  fields.dirty = false;
  const summary = $(fields.card.querySelector("#" + provider + "StorageProfileSummary") ? `#${provider}StorageProfileSummary` : "");
  if (summary) summary.textContent = profile?.name || "暂无配置";
  const meta = $(`#${provider}StorageProfileMeta`);
  if (meta) meta.textContent = profile ? `${profile.bucket || "未填写 Bucket"}${profile.configured ? " · 已配置" : " · 配置不完整"}` : "请点击新增创建配置";
  const edit = $(`#${provider}StorageProfileEdit`), save = $(`#${provider}StorageProfileSave`);
  if (edit) edit.hidden = !profile;
  if (save) save.hidden = !profileId;
  $(fields.region).dispatchEvent(new Event("storage-profile-render"));
}
function setStorageEditorVisible(provider, visible) {
  const fields = storageProviderFields[provider];
  fields.card.classList.toggle("storage-profile-editing", visible);
  fields.editor.hidden = !visible;
  fields.card.querySelector(".storage-profile-picker").hidden = !storageProviderProfiles[provider].length;
  $(`#${provider}StorageProfileEdit`).hidden = visible || !$(fields.profile).value;
  $(`#${provider}StorageProfileSave`).hidden = !visible;
}
async function confirmStorageProfileDiscard(provider) {
  const fields = storageProviderFields[provider];
  if (!fields.dirty) return true;
  return confirmAction("当前配置有未保存修改，确定放弃修改吗？");
}
function renderStorageProfiles(provider, activeProfileId = "") {
  const fields = storageProviderFields[provider],
    profiles = storageProviderProfiles[provider],
    select = $(fields.profile);
  fields.card.querySelector(".storage-profile-picker").hidden = !profiles.length;
  select.innerHTML = profiles.length
    ? profiles.map((profile) => `<option value="${esc(profile.id)}">${esc(profile.name)}</option>`).join("")
    : '<option value="">尚无配置</option>';
  const selectedId = activeProfileId || profiles[0]?.id || "";
  select.dataset.previous = selectedId;
  showStorageProfile(provider, selectedId);
  setStorageEditorVisible(provider, false);
}
for (const [provider, fields] of Object.entries(storageProviderFields)) {
  $(fields.profile).onchange = async () => {
    if (!(await confirmStorageProfileDiscard(provider))) return renderStorageProfiles(provider, $(fields.profile).dataset.previous || "");
    $(fields.profile).dataset.previous = $(fields.profile).value;
    showStorageProfile(provider, $(fields.profile).value);
    setStorageEditorVisible(provider, false);
  };
  $(fields.edit).onclick = async () => { if (await confirmStorageProfileDiscard(provider)) setStorageEditorVisible(provider, true); };
  $(fields.add).onclick = () => {
    if (fields.dirty) return void confirmStorageProfileDiscard(provider).then((ok) => {
      if (ok) { fields.dirty = false; $(fields.add).click(); }
    });
    $(fields.profile).value = "";
    showStorageProfile(provider, "");
    $(fields.name).value = "";
    setStorageEditorVisible(provider, true);
    $(fields.name).focus();
  };
  $(fields.remove).onclick = async () => {
    const profileId = $(fields.profile).value,
      profile = storageProviderProfiles[provider].find((item) => item.id === profileId);
    if (!profile) return;
    if (!(await confirmAction(`确定删除对象存储配置“${profile.name}”吗？`))) return;
    try {
      await request(`/api/storage/providers/${provider}/profiles/${encodeURIComponent(profileId)}`, { method: "DELETE" });
      await loadS3Config();
      toast("对象存储配置已删除");
    } catch (error) {
      toast("删除失败：" + error.message);
    }
  };
}
let storageSelections = [],
  nextStorageSelectionId = 1,
  nextStorageGroupId = 1,
  lastStorageBoxPrefix = "";
let runningStorageUploadId = "";
async function loadStorageUploadQueue() {
  const queue = $("#storageUploadQueue");
  if (!queue) return;
  try {
    const result = await request("/api/storage/uploads"),
      uploads = result.uploads || [];
    queue.innerHTML = uploads.length
      ? `<div class="storage-upload-queue-head"><strong>中断的上传</strong><small>${uploads.length} 个任务</small></div>${uploads
          .map(
            (item) =>
              `<div class="storage-upload-item"><div><strong>${esc(item.fileName || item.key)}</strong><span>${esc(item.localPath || "浏览器临时文件")}</span><small>${esc(item.provider.toUpperCase())} · ${esc(item.bucket || "")} · ${esc(item.key)} · ${(Number(item.fileSize || 0) / 1024 / 1024).toFixed(1)} MiB</small></div><div><button type="button" data-storage-resume="${esc(item.uploadId)}">继续上传</button><button type="button" class="selection-remove" data-storage-delete="${esc(item.uploadId)}">删除并清理 S3</button></div></div>`,
          )
          .join("")}`
      : '<div class="storage-upload-queue-empty">没有中断的上传任务</div>';
    if (result.removed?.length)
      toast(`已清理 ${result.removed.length} 个本地文件不存在的上传缓存`);
  } catch (error) {
    queue.innerHTML = `<div class="storage-upload-queue-empty">读取上传任务失败：${esc(error.message)}</div>`;
  }
}
async function runPersistedStorageUpload(uploadId, button) {
  runningStorageUploadId = uploadId;
  $("#storageUploadTerminate").hidden = false;
  setButtonBusy(button, "上传中…");
  try {
    const result = await request(
      `/api/storage/uploads/${encodeURIComponent(uploadId)}/run`,
      { method: "POST" },
    );
    $("#storageUploadStatus").textContent = `上传完成：${result.key}`;
    $("#storageUploadBar").style.width = "100%";
    toast("文件已上传到对象存储");
  } catch (error) {
    if (runningStorageUploadId === uploadId) {
      $("#storageUploadStatus").textContent = `上传中断：${error.message}`;
      toast("上传中断，任务已保留：" + error.message);
    }
  } finally {
    if (runningStorageUploadId === uploadId) {
      runningStorageUploadId = "";
      $("#storageUploadTerminate").hidden = true;
    }
    clearButtonBusy(button);
    await loadStorageUploadQueue();
  }
}
$("#storageUploadTerminate").onclick = async function () {
  const uploadId = runningStorageUploadId;
  if (!uploadId) return;
  setButtonBusy(this, "正在终止…");
  try {
    await request(`/api/storage/uploads/${encodeURIComponent(uploadId)}`, {
      method: "DELETE",
    });
    runningStorageUploadId = "";
    this.hidden = true;
    $("#storageUploadStatus").textContent = "上传已终止，S3 分片已清理";
    toast("上传已终止并清理");
  } catch (error) {
    toast("终止上传失败：" + error.message);
  } finally {
    clearButtonBusy(this);
    await loadStorageUploadQueue();
  }
};
$("#storageUploadQueue").onclick = async function (event) {
  const resume = event.target.closest("[data-storage-resume]"),
    remove = event.target.closest("[data-storage-delete]");
  if (resume)
    return runPersistedStorageUpload(resume.dataset.storageResume, resume);
  if (!remove) return;
  setButtonBusy(remove, "正在清理…");
  try {
    await request(
      `/api/storage/uploads/${encodeURIComponent(remove.dataset.storageDelete)}`,
      { method: "DELETE" },
    );
    toast("上传记录和 S3 分片已清理");
  } catch (error) {
    toast("清理上传任务失败：" + error.message);
  } finally {
    await loadStorageUploadQueue();
  }
};
const storageDrop = $("#storageUploadDrop");
$("#storageUploadKey")?.closest("label")?.remove();
storageDrop.innerHTML = '<strong>添加上传内容</strong><small id="storageUploadFileLabel">尚未选择文件或文件夹</small><div class="storage-pick-actions"><button type="button" data-storage-pick-files>选择文件</button><button type="button" data-storage-pick-folder>选择文件夹</button></div>';
storageDrop.insertAdjacentHTML("afterend", '<div id="storageSelectionPanel" hidden><div class="storage-selection-toolbar"><strong>已选择内容</strong><div><button type="button" data-storage-merge>合并选中框</button><button type="button" data-storage-clear>清空</button></div></div><div id="storageSelectionGroups" class="storage-selection-groups"></div></div>');
function renderStorageSelections() {
  const panel = $("#storageSelectionPanel"),
    target = $("#storageSelectionGroups"),
    grouped = new Map();
  for (const box of storageSelections) {
    const key = box.groupId || `box-${box.id}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(box);
  }
  const archiveName = (boxes) => {
    const base = boxes.length === 1
      ? String(boxes[0].name || "upload")
      : `combined-${boxes.map((box) => String(box.name || "selection")).join("-")}`;
    return `${base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "upload"}.tar.gz`;
  };
  const renderBox = (box, groupBoxes) => {
    const selected = box.files.filter((file) => file.selected).length;
    const groupedBox = groupBoxes.length > 1,
      compressed = groupedBox || box.compress,
      uploadName = groupedBox ? (groupBoxes[0].uploadName || archiveName(groupBoxes)) : box.uploadName,
      destinationPrefix = groupBoxes[0].prefix || "",
      providerConfig = existingStorageProviderConfigs[$("#storageUploadProvider").value] || {},
      configPrefix = String(providerConfig.prefix || "").replace(/^\/+|\/+$/g, ""),
      bucket = providerConfig.bucket || "Bucket",
      destinationKey = [configPrefix, destinationPrefix, uploadName].filter(Boolean).join("/"),
      destination = `${bucket} / ${destinationKey}（配置 Prefix：${configPrefix || "根目录"}；上传 Prefix：${destinationPrefix || "根目录"}）`;
    return `<section class="storage-selection-box${box.marked ? " is-marked" : ""}"><header><label class="storage-box-selector"><input type="checkbox" data-storage-box-group="${box.id}" ${box.marked ? "checked" : ""}><span></span></label><div class="storage-box-title"><small>${box.kind === "folder" ? "文件夹" : "文件"}</small><strong title="${esc(box.name)}">${esc(box.name)}</strong></div><span class="storage-file-count">${selected}/${box.files.length}</span><button type="button" class="storage-box-remove" data-storage-remove-box="${box.id}" aria-label="移除 ${esc(box.name)}" title="移除">×</button></header><div class="storage-box-options"><label><span>上传为</span><input data-storage-box-name="${box.id}" value="${esc(uploadName || "")}" ${groupedBox && groupBoxes[0].id !== box.id ? "disabled" : ""}></label><label><span>Prefix</span><input data-storage-box-prefix="${box.id}" value="${esc(box.prefix || "")}" placeholder="留空则上传到根目录" ${groupedBox && groupBoxes[0].id !== box.id ? "disabled" : ""}></label><label class="storage-compress-toggle"><input type="checkbox" data-storage-box-compress="${box.id}" ${compressed ? "checked" : ""} ${groupedBox ? "disabled" : ""}><span><b>打包为 .tar.gz</b>${groupedBox ? "<small>合并组将共同打包</small>" : ""}</span></label></div><div class="storage-box-preview"><span>上传目标</span><code>${esc(destination)}</code></div><div class="storage-selection-files">${box.files.map((file, index) => { const locked = file.selected && selected === 1; return `<label class="storage-selection-file${file.selected ? " is-selected" : ""}${locked ? " is-required" : ""}"><span class="storage-tree-branch"></span><input type="checkbox" data-storage-file-box="${box.id}" data-storage-file-index="${index}" ${file.selected ? "checked" : ""} ${locked ? "disabled" : ""}><span class="storage-file-icon">${file.relativePath.includes("/") ? "└" : "·"}</span><span title="${esc(file.relativePath)}">${esc(file.relativePath)}</span><small>${formatObjectSize(file.size)}</small></label>`; }).join("")}</div></section>`;
  };
  target.innerHTML = [...grouped.entries()].map(([key, boxes]) => {
    const content = boxes.map((box) => renderBox(box, boxes)).join("");
    return String(key).startsWith("box-") ? content : `<section class="storage-compression-group"><header><div><span>合并压缩组</span><strong>${boxes.length} 个选择框将打包为一个文件</strong></div><button type="button" class="storage-ungroup" data-storage-ungroup="${key}">拆分后独立压缩上传</button></header>${content}</section>`;
  }).join("");
  panel.hidden = !storageSelections.length;
  const count = storageSelections.reduce((sum, box) => sum + box.files.filter((file) => file.selected).length, 0);
  $("#storageUploadFileLabel").textContent = storageSelections.length ? `${storageSelections.length} 个选择框 · ${count} 个文件` : "尚未选择文件或文件夹";
}
function addStorageSelections(boxes) {
  const inheritedPrefix = lastStorageBoxPrefix || storageSelections.at(-1)?.prefix || "";
  for (const source of boxes || []) {
    const compress = source.kind === "folder";
    storageSelections.push({ ...source, id: nextStorageSelectionId++, groupId: null, marked: false, prefix: inheritedPrefix, compress, uploadName: `${source.name}${compress ? ".tar.gz" : ""}`, files: source.files.map((file) => ({ ...file, selected: true })) });
  }
  renderStorageSelections();
}
storageDrop.onclick = async (event) => {
  const files = event.target.closest("[data-storage-pick-files]"),
    folder = event.target.closest("[data-storage-pick-folder]");
  if (!files && !folder) return;
  const picker = files ? window.fastGpuWindow?.pickStorageFiles : window.fastGpuWindow?.pickStorageFolder;
  if (!picker) return toast("文件和文件夹上传需要使用桌面客户端");
  addStorageSelections(await picker());
};
$("#storageSelectionPanel").onchange = (event) => {
  const box = storageSelections.find((item) => item.id === Number(event.target.dataset.storageFileBox || event.target.dataset.storageBoxGroup || event.target.dataset.storageBoxPrefix || event.target.dataset.storageBoxName || event.target.dataset.storageBoxCompress));
  if (!box) return;
  if (event.target.dataset.storageBoxPrefix != null)
    box.prefix = lastStorageBoxPrefix = event.target.value.trim().replace(/^\/+|\/+$/g, "");
  else if (event.target.dataset.storageBoxName != null) box.uploadName = event.target.value.replace(/^\/+|\/+$/g, "");
  else if (event.target.dataset.storageBoxCompress != null) {
    box.compress = event.target.checked;
    box.uploadName = box.compress ? `${box.uploadName.replace(/\.tar\.gz$/i, "")}.tar.gz` : box.uploadName.replace(/\.tar\.gz$/i, "");
  } else if (event.target.dataset.storageFileIndex != null) {
    const selected = box.files.filter((file) => file.selected).length;
    if (!event.target.checked && selected === 1) return;
    box.files[Number(event.target.dataset.storageFileIndex)].selected = event.target.checked;
  }
  else box.marked = event.target.checked;
  renderStorageSelections();
};
$("#storageUploadProvider").addEventListener("change", renderStorageSelections);
$("#storageSelectionPanel").onclick = (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.hasAttribute("data-storage-clear")) storageSelections = [];
  else if (button.dataset.storageRemoveBox) storageSelections = storageSelections.filter((box) => box.id !== Number(button.dataset.storageRemoveBox));
  else if (button.dataset.storageUngroup) storageSelections.forEach((box) => { if (String(box.groupId) === button.dataset.storageUngroup) box.groupId = null; });
  else if (button.hasAttribute("data-storage-merge")) {
    const marked = storageSelections.filter((box) => box.marked);
    if (marked.length < 2) return toast("请至少勾选两个选择框再合并");
    const groupId = nextStorageGroupId++;
    const combinedName = `combined-${marked.map((box) => box.name).join("-")}`
      .replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "combined-upload";
    marked[0].uploadName = `${combinedName}.tar.gz`;
    marked.forEach((box) => { box.groupId = groupId; box.marked = false; });
  }
  renderStorageSelections();
};
$("#storageUploadStart").onclick = async function () {
  const chosen = storageSelections.filter((box) => box.files.some((file) => file.selected));
  if (!chosen.length) return toast("请先选择要上传的文件");
  const button = this;
  setButtonBusy(button, "正在压缩…");
  try {
    const created = await request("/api/storage/upload-groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: $("#storageUploadProvider").value,
        boxes: chosen.map((box) => ({ id: box.id, name: box.name, uploadName: box.uploadName, compress: box.compress, kind: box.kind, groupId: box.groupId, prefix: box.prefix || "", rootPath: box.rootPath, files: box.files.filter((file) => file.selected) })),
      }),
    });
    storageSelections = [];
    renderStorageSelections();
    clearButtonBusy(button);
    await loadStorageUploadQueue();
    for (const upload of created.uploads) await runPersistedStorageUpload(upload.uploadId, button);
  } catch (error) {
    toast("创建上传任务失败：" + error.message);
    clearButtonBusy(button);
  }
};
async function loadS3Config() {
  if (!storagePageReady) return;
  let c;
  try {
    c = await request("/api/storage/providers");
  } catch (error) {
    // 无法读取存储配置属于真正的异常，仍然提示；但不打扰未配置的正常状态
    toast("读取对象存储设置失败：" + error.message);
    setPageTitleAlert("存储配置读取失败");
    storageProviderDisclosure.hidden = false;
    return;
  }
  // 实例列表加载失败不应阻塞存储设置页面（例如尚未配置任何算力供应商时）
  try {
    void loadExistingStorageInstances().catch(() => {
      $("#existingStorageInstance").innerHTML = '<option value="">请先启动实例</option>';
    });
  } catch (_instanceError) {
    $("#existingStorageInstance").innerHTML = '<option value="">请先启动实例</option>';
  }
  existingStorageProviderConfigs = c.providers || {};
  void loadStorageUploadQueue();
  for (const [provider, fields] of Object.entries(storageProviderFields)) {
    const item = c.providers?.[provider] || {};
    storageProviderProfiles[provider] = item.profiles || [];
    renderStorageProfiles(provider, item.activeProfileId);
    $(fields.enabled).checked = Boolean(item.enabled);
    if (
      item.region &&
      ![...$(fields.region).options].some(
        (option) => option.value === item.region,
      )
    ) {
      $(fields.region).add(
        new Option(`${item.region}（已保存）`, item.region),
      );
    }
  $(fields.accessKey).placeholder = "S3 Access Key ID";
    const verification = item.verification;
    $(fields.hint).textContent = item.configured
      ? verification
        ? `已保存 Bucket：${item.bucket} · 联通${verification.connected ? "正常" : "失败"} · 上传${verification.upload ? "可用" : "不可用"} · 下载${verification.download ? "可用" : "不可用"}`
        : `已保存 Bucket：${item.bucket} · 尚未测试`
      : "尚未配置";
  storageProviderConfigured[provider] = Boolean(item.configured);
    const summaryButton = storageSummaryActions.querySelector(`[data-storage-summary-provider="${provider}"]`);
    if (summaryButton) {
      summaryButton.textContent = `${provider === "r2" ? "R2" : "OSS"} ${item.profiles?.length ? "修改" : "新增"}`;
      summaryButton.className = item.profiles?.length ? "has-profile" : "";
    }
  }
  const draft = readExistingStorageDraft();
  if (draft.provider && existingStorageProviderConfigs[draft.provider]?.configured)
    $("#existingStorageProvider").value = draft.provider;
  $("#existingStoragePrefix").value = draft.prefix || "";
  $("#existingStoragePrefix").dataset.selectionType = draft.selectionType || "prefix";
  $("#existingStorageTarget").value = draft.target || "/data/datasets";
  $("#existingStorageMode").value = draft.mode === "mount" ? "mount" : "copy";
  $("#existingStorageAutoInstall").checked = true;
  updateExistingStorageMode();
 updateStorageUploadProviders(c.providers || {});
 for (const [provider, item] of Object.entries(c.providers || {}))
   $(`#storageBrowserProvider option[value="${provider}"]`).disabled =
     !item.enabled || !item.configured;
 if ($("#storageBrowserProvider").selectedOptions[0]?.disabled) {
   const available = [...$("#storageBrowserProvider").options].find(
     (option) => !option.disabled,
   );
   if (available) $("#storageBrowserProvider").value = available.value;
 }
 const enabled = Object.values(c.providers || {}).filter(
    (item) => item.enabled && item.configured,
  ).length;
  const configured = Object.entries(c.providers || {}).filter(
      ([, item]) => item.configured,
    ),
    labels = { r2: "R2", oss: "OSS" },
    allVerified =
      configured.length > 0 &&
      configured.every(
        ([, item]) =>
          item.verification?.connected &&
          item.verification?.upload &&
          item.verification?.download,
      );
  storageProviderDisclosure.open = configured.length === 0;
  storageProviderDisclosure.hidden = false;
  storageUnavailable.hidden = enabled > 0;
  existingStorageDisclosure.hidden = enabled === 0;
  storageBrowserDisclosure.hidden = enabled === 0;
  storageUploadDisclosure.hidden = enabled === 0;
  $("#s3Status").className = "pill " + (allVerified ? "ready" : "warning");
  $("#s3Status").textContent = configured.length
    ? configured
        .map(
          ([id, item]) =>
            `${labels[id] || id.toUpperCase()} 联通${item.verification?.connected ? "✓" : "✗"} 上传${item.verification?.upload ? "✓" : "✗"} 下载${item.verification?.download ? "✓" : "✗"}`,
        )
        .join(" · ")
    : "尚未配置";
  setPageTitleAlert(allVerified || !configured.length ? null : "存储权限异常");
  $("#s3Hint").textContent = enabled
    ? "凭据会安全保存；新实例不会自动同步，请在需要时手动选择内容。"
    : "请至少启用并完整配置一个对象存储供应商。";
  for (const [provider, fields] of Object.entries(storageProviderFields))
    $(`#existingStorageProvider option[value="${provider}"]`).disabled = !$(fields.enabled).checked;
}
$("#ossRegion").onchange = function () {
  $("#ossEndpoint").value = this.value
    ? `https://oss-${this.value}.aliyuncs.com`
    : "";
};
function createSearchableSelect(select) {
  const root = document.createElement("div"),
    trigger = document.createElement("button"),
    popup = document.createElement("div"),
    search = document.createElement("input"),
    list = document.createElement("div"),
    empty = document.createElement("div");
  root.className = "searchable-select";
  trigger.type = "button";
  trigger.className = "searchable-select-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  popup.className = "searchable-select-popup";
  popup.hidden = true;
  search.type = "search";
  search.className = "searchable-select-search";
  search.placeholder = "搜索地区或 Region ID";
  search.setAttribute("aria-label", "搜索阿里云 OSS 地区");
  list.className = "searchable-select-list";
  list.setAttribute("role", "listbox");
  empty.className = "searchable-select-empty";
  empty.textContent = "没有匹配的地区";
  empty.hidden = true;
  popup.append(search, list, empty);
  root.append(trigger, popup);
  select.classList.add("searchable-select-native");
  select.after(root);

  function options() {
    return [...select.options].map((option) => ({
      value: option.value,
      label: option.textContent.trim(),
      group:
        option.parentElement?.tagName === "OPTGROUP"
          ? option.parentElement.label
          : "",
    }));
  }
  function syncTrigger() {
    const selected = select.selectedOptions[0];
    trigger.innerHTML = `<span>${esc(selected?.textContent.trim() || "请选择区域")}</span><i aria-hidden="true"></i>`;
  }
  function render(query = "") {
    const normalized = query.trim().toLocaleLowerCase(),
      matches = options().filter(
        ({ label, value, group }) =>
          !normalized ||
          `${label} ${value} ${group}`.toLocaleLowerCase().includes(normalized),
      );
    list.innerHTML = "";
    let lastGroup = null;
    for (const item of matches) {
      if (item.group && item.group !== lastGroup) {
        const heading = document.createElement("div");
        heading.className = "searchable-select-group";
        heading.textContent = item.group;
        list.append(heading);
        lastGroup = item.group;
      }
      const row = document.createElement("button");
      row.type = "button";
      row.className = "searchable-select-option";
      row.dataset.value = item.value;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(item.value === select.value));
      row.innerHTML = `<span>${esc(item.label)}</span>${item.value ? `<small>${esc(item.value)}</small>` : ""}`;
      row.onclick = () => {
        select.value = item.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        syncTrigger();
        close();
      };
      list.append(row);
    }
    empty.hidden = matches.length > 0;
  }
  function positionPopup() {
    const rect = trigger.getBoundingClientRect(),
      gap = 6,
      viewportGap = 12,
      below = window.innerHeight - rect.bottom - gap - viewportGap,
      above = rect.top - gap - viewportGap,
      maxHeight = Math.max(180, Math.min(380, Math.max(below, above))),
      openAbove = below < 220 && above > below,
      popupWidth = Math.min(
        Math.max(rect.width, 300),
        window.innerWidth - viewportGap * 2,
      );
    popup.style.left = `${Math.max(viewportGap, Math.min(rect.left, window.innerWidth - popupWidth - viewportGap))}px`;
    popup.style.width = `${popupWidth}px`;
    popup.style.maxHeight = `${maxHeight}px`;
    popup.style.top = openAbove ? "auto" : `${rect.bottom + gap}px`;
    popup.style.bottom = openAbove
      ? `${window.innerHeight - rect.top + gap}px`
      : "auto";
  }
  function open() {
    popup.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    search.value = "";
    render();
    positionPopup();
    requestAnimationFrame(() => search.focus());
  }
  function close() {
    popup.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  }
  trigger.onclick = () => (popup.hidden ? open() : close());
  search.oninput = () => render(search.value);
  root.onkeydown = (event) => {
    if (event.key === "Escape") {
      close();
      trigger.focus();
    }
  };
  document.addEventListener("pointerdown", (event) => {
    if (!root.contains(event.target)) close();
  });
  window.addEventListener("resize", () => !popup.hidden && positionPopup());
  window.addEventListener(
    "scroll",
    () => !popup.hidden && positionPopup(),
    true,
  );
  select.addEventListener("change", syncTrigger);
  select.addEventListener("storage-profile-render", syncTrigger);
  new MutationObserver(syncTrigger).observe(select, {
    childList: true,
    subtree: true,
  });
  syncTrigger();
}
createSearchableSelect($("#ossRegion"));
async function saveStorageProvider(provider) {
  const fields = storageProviderFields[provider], button = $(fields.save), values = {
    enabled: $(fields.enabled).checked,
    profileId: $(fields.profile).value,
      name: $(fields.name).value,
      endpoint: $(fields.endpoint).value,
      bucket: $(fields.bucket).value,
      prefix: $(fields.prefix).value,
    region: $(fields.region).value,
    accessKeyId: $(fields.accessKey).value,
    secretAccessKey: $(fields.secretKey).value,
  };
  setButtonBusy(button, "保存并测试中…");
  try {
    await request("/api/storage/providers", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ providers: { [provider]: values } }) });
    fields.dirty = false;
    await loadS3Config();
    toast(`${provider.toUpperCase()} 配置已保存并完成测试`);
  } catch (error) {
    toast("保存失败：" + error.message);
  } finally {
    clearButtonBusy(button);
  }
}
for (const [provider, fields] of Object.entries(storageProviderFields))
  $(fields.save).onclick = () => saveStorageProvider(provider);
storagePageReady = true;
setTimeout(() => {
  if ($("#storage")?.classList.contains("active")) loadS3Config();
}, 0);
globalThis.loadS3Config = loadS3Config;
$("#s3Form").onsubmit = async function (event) {
  event.preventDefault();
  const button =
    event.submitter || event.currentTarget.querySelector("button[type=submit]");
  setButtonBusy(button, "保存并测试中…");
  try {
    const providers = Object.fromEntries(
      Object.entries(storageProviderFields).map(([provider, fields]) => [
        provider,
        {
          enabled: $(fields.enabled).checked,
          profileId: $(fields.profile).value,
          name: $(fields.name).value,
          endpoint: $(fields.endpoint).value,
          bucket: $(fields.bucket).value,
          region: $(fields.region).value,
          accessKeyId: $(fields.accessKey).value,
          secretAccessKey: $(fields.secretKey).value,
        },
      ]),
    );
    const hasStoredOrEnteredProfile = Object.entries(providers).some(
      ([provider, values]) =>
        storageProviderProfiles[provider].length ||
        values.endpoint.trim() ||
        values.bucket.trim() ||
        values.accessKeyId.trim() ||
        values.secretAccessKey.trim(),
    );
    if (!hasStoredOrEnteredProfile)
      throw new Error("空表单不能保存，请先填写一条完整配置");
    await request("/api/storage/providers", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providers,
      }),
    });
    await loadS3Config();
    toast("对象存储设置已保存，连通及上传下载权限已测试");
  } catch (error) {
    toast("保存失败：" + error.message);
  } finally {
    clearButtonBusy(button);
  }
};
