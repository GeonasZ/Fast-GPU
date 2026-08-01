const billingProviders = [];
let activeBillingProvider = "",
  providerConfigStatus = [],
  providerFieldDefinitions = new Map(),
  providerDefinitions = new Map(),
  billingProviderRenderId = 0;
const providerExtensions = new Map(),
  providerExtensionLoads = new Map();
globalThis.registerProviderExtension = (id, extension) =>
  providerExtensions.set(String(id), Object.freeze({ ...extension }));
function providerExtension(id) {
  return providerExtensions.get(String(id)) || {};
}
function runProviderExtensionHook(name, context) {
  for (const extension of providerExtensions.values()) {
    const hook = extension[name];
    if (typeof hook !== "function") continue;
    try {
      hook.call(extension, context);
    } catch (error) {
      console.warn(`Provider extension hook ${name} failed`, error);
    }
  }
}
async function loadProviderExtension(definition) {
  if (!definition.clientModule || providerExtensionLoads.has(definition.id))
    return providerExtensionLoads.get(definition.id);
  const loaded = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = definition.clientModule;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(Error(`无法加载 ${definition.title} 页面扩展`));
    document.head.append(script);
  });
  providerExtensionLoads.set(definition.id, loaded);
  return loaded;
}

function applyProviderDefinitions(document) {
  for (const definition of document.cloudCompute || []) {
    providerDefinitions.set(definition.id, definition);
    const current = billingProviders.find((item) => item.id === definition.id);
    if (!current) {
      billingProviders.push({
        id: definition.id,
        name: definition.title,
        currency: definition.currency || "",
        url: definition.portals?.find((portal) => portal.id === "billing")?.url || "",
        keyUrl: definition.portals?.find((portal) => portal.id === "key")?.url || "",
      });
    } else {
      current.name = definition.title || current.name;
      current.description = definition.description || current.description;
      current.currency = definition.currency || current.currency;
      current.url = definition.portals?.find((portal) => portal.id === "billing")?.url || current.url;
      current.keyUrl = definition.portals?.find((portal) => portal.id === "key")?.url || current.keyUrl;
    }
    providerFieldDefinitions.set(definition.id, definition.fields || []);
  }
  const providerFilter = $("#providerFilter");
  if ($("#providerCount"))
    $("#providerCount").textContent = String((document.cloudCompute || []).length);
  if (providerFilter) {
    const previous = providerFilter.value;
    providerFilter.replaceChildren(
      new Option("全部供应商", ""),
      ...(document.cloudCompute || []).map(
        (definition) => new Option(definition.title, definition.title),
      ),
    );
    providerFilter.value = previous;
  }
  const accessList = $("#instanceAccessInfoList");
  if (accessList)
    accessList.innerHTML = (document.cloudCompute || [])
      .filter((definition) => definition.instanceAccess)
      .map((definition) => `<article class="access-${esc(definition.instanceAccess.level)}"><header><strong>${esc(definition.title)}</strong><span>${esc(definition.instanceAccess.label)}</span></header><p>${esc(definition.instanceAccess.description)}</p></article>`)
      .join("");
  if (!activeBillingProvider) activeBillingProvider = billingProviders[0]?.id || "";
}

async function loadProviderDefinitions() {
  if (providerFieldDefinitions.size) return;
  const definitions = await request("/api/provider-config");
  applyProviderDefinitions(definitions);
  await Promise.all((definitions.cloudCompute || []).map(loadProviderExtension));
  runProviderExtensionHook("instancesLoaded", { instances });
}
function updateProviderConnectionSummary(
  view = readUiState().view || "market",
) {
  const summary = $("#providerConnectionSummary");
  summary.hidden = !["market", "instances"].includes(view);
  if (summary.hidden) return;
  if (!providerConfigStatus.length) {
    summary.className = "system disconnected";
    summary.innerHTML = "<i></i> 正在检查平台连接…";
    return;
  }
  const disconnected = providerConfigStatus.filter((item) => !item.configured);
  const expired = providerConfigStatus.filter((item) => item.authIssue);
  const incomplete = providerConfigStatus.filter(
    (item) => item.configured && item.provisioningReady === false,
  );
  if (expired.length) {
    summary.className = "system disconnected";
    summary.innerHTML = `<i></i> 授权已失效：${expired.map((item) => esc(item.name)).join("、")}`;
  } else if (disconnected.length) {
    summary.className = "system disconnected";
    summary.innerHTML = `<i></i> 未连接：${disconnected.map((item) => esc(item.name)).join("、")}`;
  } else if (incomplete.length) {
    summary.className = "system warning";
    const incompleteText = incomplete
      .map((item) => `${esc(item.name)}（请前往供应商账户中心配置）`)
      .join("、");
    summary.innerHTML = `<i></i> 配置未完成：${incompleteText}`;
  } else {
    summary.className = "system connected";
    summary.innerHTML = "<i></i> 所有平台已连接";
  }
}
function openProviderWindow(url, name) {
  const popup = window.open(
    url,
    name,
    "popup,width=1200,height=820,resizable=yes,scrollbars=yes",
  );
  if (!popup) toast("浏览器阻止了供应商窗口，请允许本站弹出窗口");
}
function renderProviderKeys(provider, status) {
  const keys = status?.keys || [],
    form = $("#providerKeyForm"),
    addButton = $("#addProviderKey"),
    keyButton = $("#launchKeyPortal"),
    keyHead = $(".provider-key-head");
  let headActions = keyHead.querySelector(".provider-key-head-actions");
  if (!headActions) {
    headActions = document.createElement("div");
    headActions.className = "provider-key-head-actions";
    keyHead.append(headActions);
  }
  headActions.append(keyButton, addButton);
  if (!status) {
    $("#providerKeyStatus").textContent = "正在读取 Key 状态…";
    $("#providerKeyList").innerHTML = "";
    form.hidden = true;
    addButton.hidden = false;
    addButton.disabled = true;
    return;
  }
  addButton.disabled = false;
  $("#providerKeyStatus").innerHTML = status.authIssue
    ? `<span class="provider-auth-bubble">授权已过期或失效</span> ${esc(status.authIssue.keyLabel)} · •••• ${esc(status.authIssue.keySuffix)}`
    : keys.length
      ? `已添加 ${keys.length} 个 Key`
      : "尚未配置 API Key";
  $("#providerKeyList").innerHTML = keys
    .map(
      (key) =>
        `<div class="provider-key-item ${key.active ? "active" : ""} ${status.authIssue?.keyId === key.id ? "auth-expired" : ""}"><span><strong class="provider-key-label">${esc(key.label || "未命名 Key")}${status.authIssue?.keyId === key.id ? '<b class="provider-auth-bubble">授权已过期或失效</b>' : ""}</strong><code>•••• ${esc(key.keySuffix)}</code><small>${key.active ? "当前使用" : "备用"} · ${new Date(key.createdAt).toLocaleDateString()}</small></span><div>${key.active ? "<b>使用中</b>" : `<button type="button" data-activate-provider-key="${esc(key.id)}">切换使用</button>`}<button type="button" data-rename-provider-key="${esc(key.id)}" data-current-label="${esc(key.label || "")}">重命名</button><button type="button" data-download-provider-key="${esc(key.id)}">安全下载</button><button type="button" data-delete-provider-key="${esc(key.id)}">删除</button></div></div>`,
    )
    .join("");
  form.hidden = keys.length > 0;
  addButton.hidden = !form.hidden;
  addButton.textContent = "＋ 添加新 Key";
  addButton.onclick = () => {
    form.hidden = false;
    addButton.hidden = true;
    $("#providerApiKey").focus();
  };
  $$("[data-activate-provider-key]").forEach(
    (button) =>
      (button.onclick = async () => {
        button.disabled = true;
        try {
          await request(
            `/api/providers/${encodeURIComponent(provider.id)}/api-keys/${encodeURIComponent(button.dataset.activateProviderKey)}/activate`,
            { method: "POST" },
          );
          await loadProviderConfig();
          await showBillingProvider(provider.id);
          toast(
            `已切换到末四位 ${button.closest(".provider-key-item").querySelector("code").textContent.slice(-4)} 的 Key`,
          );
        } catch (error) {
          button.disabled = false;
          toast("切换失败：" + error.message);
        }
      }),
  );
  $$("[data-download-provider-key]").forEach(
    (button) =>
      (button.onclick = async () => {
        button.disabled = true;
        try {
          await secureKeyDownload(
            `/api/providers/${encodeURIComponent(provider.id)}/api-keys/${encodeURIComponent(button.dataset.downloadProviderKey)}/export`,
            `${provider.id}-api-key.txt`,
          );
          toast("API Key 已通过临时密钥加密下载");
        } catch (error) {
          toast("下载失败：" + error.message);
        } finally {
          button.disabled = false;
        }
      }),
  );
  $$("[data-delete-provider-key]").forEach(
    (button) =>
      (button.onclick = async () => {
        if (
          !(await confirmAction(
            `确定删除末四位 ${button.closest(".provider-key-item").querySelector("code").textContent.slice(-4)} 的 Key？`,
            { title: "删除 API Key", confirmText: "删除" },
          ))
        )
          return;
        button.disabled = true;
        try {
          await request(
            `/api/providers/${encodeURIComponent(provider.id)}/api-keys/${encodeURIComponent(button.dataset.deleteProviderKey)}`,
            { method: "DELETE" },
          );
          await loadProviderConfig();
          await showBillingProvider(provider.id);
          toast("API Key 已删除");
        } catch (error) {
          button.disabled = false;
          toast("删除失败：" + error.message);
        }
      }),
  );
  $$("[data-rename-provider-key]").forEach(
    (button) =>
      (button.onclick = () => {
        const item = button.closest(".provider-key-item"),
          labelNode = item.querySelector(".provider-key-label"),
          editor = document.createElement("span"),
          input = document.createElement("input"),
          save = document.createElement("button"),
          cancel = document.createElement("button");
        editor.className = "provider-key-rename-editor";
        input.maxLength = 120;
        input.value = button.dataset.currentLabel || "";
        input.placeholder = "Key 名称";
        save.type = cancel.type = "button";
        save.textContent = "保存";
        cancel.textContent = "取消";
        editor.append(input, save, cancel);
        labelNode.replaceWith(editor);
        input.focus();
        input.select();
        cancel.onclick = () => showBillingProvider(provider.id);
        input.onkeydown = (event) => {
          if (event.key === "Enter") save.click();
          if (event.key === "Escape") cancel.click();
        };
        save.onclick = async () => {
          const label = input.value.trim();
          save.disabled = cancel.disabled = true;
          try {
            await request(
              `/api/providers/${encodeURIComponent(provider.id)}/api-keys/${encodeURIComponent(button.dataset.renameProviderKey)}/rename`,
              { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label }) },
            );
            await loadProviderConfig();
            await showBillingProvider(provider.id);
            toast(label ? `已更新名称为「${label}」` : "已清空 Key 名称");
          } catch (error) {
            save.disabled = cancel.disabled = false;
            toast("重命名失败：" + error.message);
          }
        };
      }),
  );
}
async function renderProviderBalance(provider, status, isCurrent = () => true) {
  let balance = $("#providerBalance");
  if (!balance) {
    const title = $("#billingTitle"),
      row = document.createElement("div");
    row.className = "billing-title-row";
    title.before(row);
    row.append(title);
    balance = document.createElement("div");
    balance.id = "providerBalance";
    balance.className = "provider-balance";
    row.append(balance);
  }
  if (!status) {
    balance.innerHTML = "<small>账户余额</small><strong>正在加载…</strong>";
    return;
  }
  if (!status.configured) {
    balance.innerHTML =
      "<small>账户余额</small><strong>配置 API Key 后读取</strong>";
    return;
  }
  balance.innerHTML = "<small>账户余额</small><strong>正在读取…</strong>";
  try {
    const data = await request(
      `/api/providers/${encodeURIComponent(provider.id)}/balance`,
    );
    if (!isCurrent()) return;
    balance.innerHTML = data.supported
      ? `<small>账户余额 · 实时</small><strong>${data.currency === "USD" ? "$" : ""}${Number(data.amount).toFixed(2)}</strong>`
      : `<small>账户余额</small><strong>${esc(data.message || "暂不支持自动读取")}</strong><button type="button" data-open-provider-balance>前往供应商查看 ↗</button>`;
    const portalButton = balance.querySelector("[data-open-provider-balance]");
    if (portalButton)
      portalButton.onclick = () =>
        openProviderWindow(provider.url, "fast-gpu-provider-balance");
  } catch (error) {
    if (isCurrent())
      balance.innerHTML = `<small>账户余额</small><strong>读取失败：${esc(error.message)}</strong>`;
  }
}
async function showBillingProvider(id) {
  const renderId = ++billingProviderRenderId,
    provider = billingProviders.find((x) => x.id === id) || billingProviders[0],
    isCurrent = () => renderId === billingProviderRenderId;
  activeBillingProvider = provider.id;
  $("#providerBillingTabs").innerHTML = billingProviders
    .map((x) => {
      const status = providerConfigStatus.find((s) => s.id === x.id),
        keyCount = status?.keyCount || 0,
        stateText = !status
          ? "正在加载"
          : status.authIssue
            ? "授权已失效"
          : keyCount
            ? keyCount + " 个 Key"
            : status.provisioningReady
              ? "可部署"
              : "需要 Key";
      return `<button class="${x.id === provider.id ? "active" : ""} ${status?.authIssue ? "auth-expired" : ""}" data-billing-provider="${esc(x.id)}"><strong>${esc(x.name)}${status?.authIssue ? '<b class="provider-auth-bubble">授权已失效</b>' : ""}</strong><small>${esc(x.currency)} · ${stateText}</small></button>`;
    })
    .join("");
  $$("[data-billing-provider]").forEach(
    (button) =>
      (button.onclick = () =>
        showBillingProvider(button.dataset.billingProvider)),
  );
  const status = providerConfigStatus.find((x) => x.id === provider.id),
    billingButton = $("#launchBillingPortal"),
    keyButton = $("#launchKeyPortal");
  let extensionHost = $("#providerExtensionHost");
  if (!extensionHost) {
    extensionHost = document.createElement("div");
    extensionHost.id = "providerExtensionHost";
    $("#providerKeyForm").after(extensionHost);
  }
  extensionHost.replaceChildren();
  $("#billingMark").textContent = provider.name[0];
  $("#billingTitle").textContent = `${provider.name} · 账户与 API Key`;
  $("#billingDescription").textContent =
    provider.description ||
    "余额不足时可先充值；Key 缺失或需要更换时，可打开官方页面获取并粘贴到下方。";
  billingButton.disabled = false;
  billingButton.textContent = "打开充值页面 ↗";
  keyButton.disabled = false;
  keyButton.textContent = "获取 API Key ↗";
  $("#providerApiKey").value = "";
  const apiKeyField = (providerFieldDefinitions.get(provider.id) || []).find(
    (field) => field.id === "apiKey",
  );
  if (apiKeyField) {
    $("#providerApiKey").placeholder = apiKeyField.placeholder || apiKeyField.label;
    $("#providerApiKey").type = apiKeyField.masked ? "password" : "text";
  }
  renderProviderKeys(provider, status);
  billingButton.onclick = () =>
    openProviderWindow(provider.url, "fast-gpu-provider-billing");
  keyButton.onclick = () =>
    openProviderWindow(
      status?.keyUrl || provider.keyUrl,
      "fast-gpu-provider-api-key",
    );
  await renderProviderBalance(provider, status, isCurrent);
  if (!isCurrent()) return;
  await providerExtension(provider.id).renderBilling?.({
    host: extensionHost,
    provider,
    definition: providerDefinitions.get(provider.id),
    status,
    isCurrent,
    refresh: async () => {
      await loadProviderConfig();
      await showBillingProvider(provider.id);
    },
  });
}
async function loadProviderConfig() {
  try {
    const [config] = await Promise.all([
      request("/api/config/status"),
      loadProviderDefinitions().catch((error) =>
        console.warn("Provider declarations unavailable; using built-in fallback", error),
      ),
    ]);
    providerConfigStatus = config.providers || [];
    updateProviderConnectionSummary();
  } catch (error) {
    toast("读取厂商 Key 状态失败：" + error.message);
  }
}
$("#providerKeyForm").onsubmit = async (event) => {
  event.preventDefault();
  const provider = billingProviders.find((x) => x.id === activeBillingProvider),
    apiKey = $("#providerApiKey").value.trim(),
    label = $("#providerApiKeyLabel").value.trim(),
    button = event.currentTarget.querySelector("button");
  if (!apiKey) return toast("请先粘贴 API Key");
  button.disabled = true;
  try {
    await request(`/api/providers/${encodeURIComponent(provider.id)}/api-key`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey, label }),
    });
    $("#providerApiKey").value = "";
    $("#providerApiKeyLabel").value = "";
    await loadProviderConfig();
    await showBillingProvider(provider.id);
    toast(`${provider.name} API Key 已验证、加密保存并立即生效`);
  } catch (error) {
    toast("保存或验证失败：" + error.message);
  } finally {
    button.disabled = false;
  }
};
function renderOffers() {
  const q = $("#search").value.toLowerCase(),
    g = $("#gpuFilter").value,
    p = $("#providerFilter").value;
  const rows = offers.filter(
    (o) =>
      JSON.stringify(o).toLowerCase().includes(q) &&
      (!g || o.gpu.includes(g)) &&
      (!p || o.providerName === p),
  );
  $("#offerRows").innerHTML =
    rows
      .map((o) => {
        const disk =
          o.diskMin || o.diskMax
            ? `系统盘 ${o.diskMin || 0}–${o.diskMax || "∞"} GB`
            : o.disk
              ? `${o.disk} GB 磁盘`
              : "";
        const details =
          [
            o.cpu && `${o.cpu} vCPU`,
            o.ram && `${o.ram} GB RAM`,
            o.vram && `${o.vram} GB VRAM`,
            disk,
          ]
            .filter(Boolean)
            .join(" · ") || "由供应商实时调度";
        const price = formatPrice(
          o,
          o.priceEstimateUnavailable ? "无法预估" : "创建前确认",
        );
        const extensionRow = providerExtension(o.provider).renderOfferRow?.({
          offer: o,
          details,
          price,
        });
        if (extensionRow) return extensionRow;
        const inventory =
          {
            none: "无库存",
            low: "库存紧张",
            normal: "库存一般",
            high: "库存充足",
            High: "库存充足",
            Low: "库存紧张",
            unknown: "库存需创建确认",
          }[o.inventory] ||
          o.network ||
          (o.available ? "有库存" : "无库存");
        const canLaunch =
          o.deployable !== undefined ? o.deployable : o.available !== false;
        const priceSource = o.priceEstimated
          ? `预估 · 来源：${(o.estimateProviders || []).join("、") || "其他厂商同型号价格中位数"}`
          : o.priceEstimateUnavailable
            ? "没有其他厂商的同型号、同配置实例"
          : "";
        return `<tr><td><strong>${o.gpuCount || 1}× ${esc(o.gpu)}</strong><span class="sub">${esc(details)}</span></td><td><span class="provider"><i>${esc(o.providerName[0])}</i>${esc(o.providerName)}</span></td><td>${esc(o.region || "自动调度")}</td><td class="availability ${canLaunch ? "" : "unavailable"}">● ${esc(inventory)}</td><td><span class="score">${o.priceEstimated ? "估价" : o.priceEstimateUnavailable ? "无估价" : o.source === "live" ? "实时" : "配置"}</span></td><td>${canLaunch ? "可立即创建" : "等待库存"}</td><td class="price"><strong>${esc(o.priceEstimated ? `≈ ${price}` : price)}</strong>${priceSource ? `<span class="sub">${esc(priceSource)}</span>` : ""}</td><td><button class="launch" data-launch="${esc(o.id)}" ${canLaunch ? "" : "disabled"}>启动 →</button></td></tr>`;
      })
      .join("") || '<tr><td colspan="8">没有匹配的资源</td></tr>';
  $$("[data-launch]").forEach(
    (b) => (b.onclick = () => openLaunch(b.dataset.launch)),
  );
  for (const extension of providerExtensions.values())
    extension.bindOfferRows?.({
      getOffers: () => offers,
      setOffers: (value) => { offers = value; },
      chooseOffer: (value) => { selected = value; },
      showLaunch,
    });
}

async function loadOffers(force = false) {
  if (offersLoading) return offersLoading;
  offersLoading = (async () => {
    $("#refresh").disabled = true;
    $("#refresh").textContent = "加载 GPU…";
    try {
      ({ offers } = await request(force ? "/api/offers?refresh=1" : "/api/offers"));
      renderOffers();
      if (force) {
        $("#refresh").textContent = "加载地区库存…";
        for (const definition of providerDefinitions.values()) {
          const extension = providerExtension(definition.id);
          if (typeof extension.refreshOffers !== "function") continue;
          try {
            await extension.refreshOffers({
              definition,
              getOffers: () => offers,
              setOffers: (value) => { offers = value; },
              render: renderOffers,
            });
          } catch (e) {
            toast(`${definition.title} 地区库存加载失败：${e.message}`);
          }
        }
      }
    } finally {
      $("#refresh").disabled = false;
      $("#refresh").textContent = "↻ 刷新报价";
      offersLoading = null;
    }
  })();
  return offersLoading;
}
["search", "gpuFilter", "providerFilter"].forEach(
  (id) =>
    ($("#" + id).oninput = () => {
      saveUiState({ [id]: $("#" + id).value });
      renderOffers();
    }),
);
$("#refresh").onclick = async () => {
  await loadOffers(true);
  toast("报价与地区库存已刷新");
};
if(!$("#dockerProfile")){
  const providerImageWrap=$("#imageVersion").closest("label"),behaviorPanel=document.createElement("section"),dockerWrap=document.createElement("label"),vmWrap=document.createElement("label");
  providerImageWrap.id="providerImageWrap";
  providerImageWrap.firstChild.nodeValue="厂商镜像";
  behaviorPanel.className="boot-behavior-panel";
  behaviorPanel.innerHTML='<div class="boot-behavior-head"><span aria-hidden="true">↻</span><div><strong>开机行为</strong><small>选择实例启动后自动执行的配置</small></div></div><div class="boot-behavior-fields"></div>';
  dockerWrap.id="dockerProfileWrap";
  dockerWrap.innerHTML='Docker 开机行为<select id="dockerProfile"></select><small id="dockerProfileHint">配置在开机行为页维护。</small>';
  vmWrap.id="vmProfileWrap";vmWrap.hidden=true;
  vmWrap.innerHTML='VM 开机行为<select id="vmProfile"></select><small id="vmProfileHint">宿主机脚本仅用于 VM。</small>';
  behaviorPanel.querySelector(".boot-behavior-fields").append(dockerWrap,vmWrap);
  providerImageWrap.after(behaviorPanel);
}
function behaviorHint(type){
  const select=$(type==="vm"?"#vmProfile":"#dockerProfile"),hint=$(type==="vm"?"#vmProfileHint":"#dockerProfileHint"),profile=imageProfiles.find(item=>item.id===select.value);
  hint.textContent=profile?.localFileExists===false?`本地启动脚本不存在：${profile.startupScriptPath}`:profile?`${type==="docker"?(profile.image||"供应商默认镜像"):"VM 宿主机"} · SSH 系统必装 · 启动脚本配置`:"请先选择开机行为";
  hint.classList.toggle("local-file-hint",profile?.localFileExists===false);
  if(type==="docker")$("#cudaFallbackWrap").style.display=providerDefinitions.get(selected?.provider)?.launch?.cudaFallback&&profile?.cudaMajor===13?"block":"none";
}
function profileOptions(type){return imageProfiles.filter(profile=>profile.profileType===type).map(profile=>`<option value="${esc(profile.id)}" ${profile.recommended&&profile.localFileExists!==false?"selected":""} ${profile.localFileExists===false?"disabled":""}>${esc(profile.name)}${profile.localFileExists===false?"（本地脚本不存在）":""}</option>`).join("");}
async function showLaunch() {
  const launch = providerDefinitions.get(selected.provider)?.launch || {
    profileType: "docker",
  };
  $("#selectedOffer").innerHTML =
    `<div class="offer-summary"><strong>${selected.gpuCount || 1}× ${esc(selected.gpu)}</strong><div class="sub">${esc(selected.providerName)} · ${esc(selected.region || "自动调度")}${selected.vram ? " · " + selected.vram + " GB 显存" : ""}</div></div>`;
  $("#dialogPrice").textContent = formatPrice(
    selected,
    selected.priceEstimateUnavailable ? "无法预估" : "以供应商创建响应为准",
  );
  $("#dialogPrice").previousElementSibling.querySelector("small").textContent =
    selected.priceEstimated
      ? `其他厂商同型号中位数估价 · 来源：${(selected.estimateProviders || []).join("、")} · 创建后显示真实价格`
      : selected.priceEstimateUnavailable
        ? "其他厂商没有同型号、同配置实例；创建后显示真实价格"
      : "按实际运行时长计费";
  $("#cudaFallbackWrap").style.display =
    launch.cudaFallback ? "block" : "none";
  $("#allowCuda128Fallback").checked = false;
  const imageSelect=$("#imageVersion"),dockerSelect=$("#dockerProfile"),vmSelect=$("#vmProfile");
  $("#providerImageWrap").hidden=!launch.providerImage;
  $("#dockerProfileWrap").hidden=launch.profileType!=="docker";
  $("#vmProfileWrap").hidden=launch.profileType!=="vm";
  imageSelect.disabled=dockerSelect.disabled=vmSelect.disabled=true;
  dockerSelect.innerHTML="<option>正在加载 Docker 配置…</option>";
  vmSelect.innerHTML="<option>正在加载 VM 配置…</option>";
  if (launch.providerImage) {
    $("#imageVersionHint").textContent =
      "可选择账号镜像（含已共享到账号的社区镜像）或官方基础镜像。";
  }
  $("#launchDialog").showModal();
  try {
    ({profiles:imageProfiles}=await request("/api/image-profiles"));
    dockerSelect.innerHTML=profileOptions("docker");
    vmSelect.innerHTML=profileOptions("vm");
    if(!dockerSelect.options.length)throw Error("没有可用的 Docker 开机行为");
    if(launch.profileType==="vm"&&!vmSelect.options.length)throw Error("没有可用的 VM 开机行为");
    dockerSelect.onchange=()=>behaviorHint("docker");
    vmSelect.onchange=()=>behaviorHint("vm");
    behaviorHint("docker");
    if(launch.profileType==="vm")behaviorHint("vm");
    if (launch.providerImage) {
      const discovery = await request(`/api/providers/${encodeURIComponent(selected.provider)}/discovery`),
        account = discovery.accountImages || [],
        official = discovery.officialImages || [],
        options = (images) =>
          images
            .map((image) => {
              const id = image.image_uuid || image.uuid || image.id,
                name = image.image_name || image.name || image.imageName || id;
              return `<option value="${esc(id)}" data-cuda-min="${esc(image.cudaMin || "")}">${esc(name)}</option>`;
            })
            .join("");
      imageSelect.innerHTML =
        (account.length
          ? `<optgroup label="我的 / 已共享镜像">${options(account)}</optgroup>`
          : "") +
        (official.length
          ? `<optgroup label="厂商官方基础镜像">${options(official)}</optgroup>`
          : "");
      if (!account.length && !official.length)
        throw Error("厂商没有返回可用镜像");
    }
    imageSelect.disabled=!launch.providerImage;
    dockerSelect.disabled=launch.profileType!=="docker";
    vmSelect.disabled=launch.profileType!=="vm";
  } catch (error) {
    dockerSelect.innerHTML='<option value="">配置加载失败</option>';
    toast(error.message);
  }
}
function openLaunch(id) {
  selected = offers.find((o) => o.id === id);
  showLaunch();
}
  $("#confirmLaunch").onclick = async (e) => {
  e.preventDefault();
  const button = $("#confirmLaunch"),
    old = button.textContent,
    launch = providerDefinitions.get(selected.provider)?.launch || { profileType: "docker" };
    if(launch.providerImage&&(!$("#imageVersion").value||$("#imageVersion").disabled))return toast("请先选择可用的厂商镜像");
    if(launch.profileType==="docker"&&(!$("#dockerProfile").value||$("#dockerProfile").disabled))return toast("请先选择 Docker 开机行为");
    if(launch.profileType==="vm"&&(!$("#vmProfile").value||$("#vmProfile").disabled))return toast("请先选择 VM 开机行为");
    const launchProfile=imageProfiles.find(profile=>profile.id===$("#dockerProfile").value),vmLaunchProfile=imageProfiles.find(profile=>profile.id===$("#vmProfile").value);
    if(launch.profileType==="docker"&&launchProfile?.localFileExists===false||launch.profileType==="vm"&&vmLaunchProfile?.localFileExists===false)return toast("本地启动脚本不存在，请到开机行为页重新选择文件");
  button.disabled = true;
  button.textContent = "正在提交…";
  try {
    const item = await request("/api/instances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        offerId: selected.id,
        provider: selected.provider,
        productId: selected.productId,
        region: selected.region,
        gpuCount: selected.gpuCount,
        rootfsSize: Math.max(10, Number(selected.diskMin) || 100),
        name: $("#instanceName").value,
        clusterId: selected.clusterId,
        price: selected.price,
        priceUnit: selected.priceUnit,
        priceSource: selected.priceSource || selected.source,
        imageVersion: launch.providerImage ? undefined : $("#imageVersion").value,
            imageProfileId:
              launch.profileType === "docker" ? $("#dockerProfile").value : undefined,
        vmProfileId:
          launch.profileType === "vm" ? $("#vmProfile").value : undefined,
        imageUuid:
          launch.providerImage ? $("#imageVersion").value : undefined,
        cudaMin:
          launch.providerImage
            ? Number($("#imageVersion").selectedOptions[0]?.dataset.cudaMin) ||
              undefined
            : undefined,
        allowCuda128Fallback:
          launch.cudaFallback &&
          $("#allowCuda128Fallback").checked,
      }),
    });
    $("#launchDialog").close();
    toast(`实例 ${item.name || item.id} 正在启动`);
    await loadInstances();
    go("instances");
  } catch (error) {
    if (["local_startup_script_missing","local_startup_script_invalid","local_startup_script_too_large"].includes(error.code)) {
      const profile=imageProfiles.find(item=>item.id===$("#dockerProfile").value)||imageProfiles.find(item=>item.id===$("#vmProfile").value);
      if(profile)profile.localFileExists=false;
      const affected=profile?.profileType==="vm"?$("#vmProfile"):$("#dockerProfile");
      affected.selectedOptions[0]?.setAttribute("disabled","");
      behaviorHint(profile?.profileType||"docker");
      toast(error.message);
    } else if (providerDefinitions.get(selected.provider)?.errorPolicies?.[error.code] === "invalidate-offer") {
      if (selected) {
        selected.available = false;
        selected.deployable = false;
        selected.inventory = "none";
      }
      $("#launchDialog").close();
      renderOffers();
      toast(error.message);
    } else if (error.code === "stale_inventory") {
      $("#launchDialog").close();
      showInventoryNotice();
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      await loadOffers(true);
      showInventoryNotice(true);
    } else toast(`创建失败：${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = old;
  }
};
