const billingProviders = [
  {
    id: "ppio",
    name: "PPIO 派欧云",
    currency: "人民币",
    url: "https://ppio.com/billing",
    keyUrl: "https://ppio.com/settings/key-management",
  },
  {
    id: "autodl",
    name: "AutoDL",
    currency: "人民币",
    url: "https://www.autodl.com/",
    keyUrl: "https://www.autodl.com/",
  },
  {
    id: "hyperstack",
    name: "Hyperstack",
    currency: "美元",
    url: "https://console.hyperstack.cloud/",
    keyUrl: "https://console.hyperstack.cloud/api-keys",
  },
  {
    id: "runpod",
    name: "RunPod",
    currency: "美元",
    url: "https://www.console.runpod.io/user/billing",
    keyUrl: "https://www.console.runpod.io/user/settings",
  },
];
let activeBillingProvider = "ppio",
  providerConfigStatus = [],
  billingProviderRenderId = 0;
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
    (item) =>
      item.id === "hyperstack" &&
      item.configured &&
      item.missing?.some((requirement) =>
        String(requirement).startsWith("HYPERSTACK_"),
      ),
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
      .map((item) =>
        item.id === "hyperstack"
          ? `${esc(item.name)}（请前往供应商账户中心配置）`
          : esc(item.name),
      )
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
  $("#hyperstackConfigForm").hidden = true;
  $("#openAutoDLImageImport").hidden = true;
  $("#billingMark").textContent = provider.name[0];
  $("#billingTitle").textContent = `${provider.name} · 账户与 API Key`;
  $("#billingDescription").textContent =
    provider.id === "hyperstack"
      ? "保存 API Key 后，平台会自动读取 Environment、SSH Keypair 和宿主机系统。"
      : "余额不足时可先充值；Key 缺失或需要更换时，可打开官方页面获取并粘贴到下方。";
  billingButton.disabled = false;
  billingButton.textContent = "打开充值页面 ↗";
  keyButton.disabled = false;
  keyButton.textContent = "获取 API Key ↗";
  $("#providerApiKey").value = "";
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
  const showHyperstackConfig =
    provider.id === "hyperstack" && status?.configured;
  if (showHyperstackConfig)
    setHyperstackConfigCollapsed(
      Boolean(status.hyperstackConfig?.environment),
      status.hyperstackConfig,
    );
  $("#hyperstackConfigForm").hidden = !showHyperstackConfig;
  $("#openAutoDLImageImport").hidden =
    provider.id !== "autodl" || !status?.configured;
  if (showHyperstackConfig) {
    await loadHyperstackResources(status.hyperstackConfig);
    if (isCurrent())
      setHyperstackConfigCollapsed(
        Boolean(status.hyperstackConfig?.environment),
        status.hyperstackConfig,
      );
  }
}
let autodlImportPoll;
function autodlSelectionMode() {
  return (
    document.querySelector('input[name="autodlSelectionMode"]:checked')
      ?.value || "manual"
  );
}
async function loadAutoDLImportOptions() {
  const mode = autodlSelectionMode(),
    status = $("#autodlImportStatus"),
    button = $("#startAutoDLImageImport");
  $("#autodlManualGpuWrap").hidden = mode !== "manual";
  $("#autodlMaxPriceWrap").hidden = mode !== "auto";
  button.disabled = true;
  status.textContent =
    mode === "auto" ? "正在读取实验性网页报价…" : "正在读取可用 GPU…";
  try {
    const data = await request(
        `/api/providers/autodl/image-import/options?mode=${mode}`,
      ),
      products = data.products || [];
    $("#autodlManualGpu").innerHTML = products
      .map(
        (product) =>
          `<option value="${esc(product.id)}">${esc(product.name || product.id)}</option>`,
      )
      .join("");
    if (mode === "auto") {
      const offers = data.offers || [];
      $("#autodlMarketHint").textContent =
        data.warning || `发现 ${offers.length} 个可验证报价`;
      status.textContent = data.unavailable
        ? `自动选价不可用：${data.warning}`
        : `已找到 ${offers.length} 个有库存且价格明确的候选；提交时会重新查询。`;
      button.disabled = Boolean(data.unavailable || !offers.length);
    } else {
      status.textContent = `可手动选择 ${products.length} 种 GPU；AutoDL Pro API 创建响应不会提前给出最终价格。`;
      button.disabled = !products.length;
    }
  } catch (error) {
    status.textContent = "读取选项失败：" + error.message;
  }
}
async function pollAutoDLImageImport(id) {
  clearTimeout(autodlImportPoll);
  try {
    const job = await request(
        `/api/providers/autodl/image-imports/${encodeURIComponent(id)}`,
      ),
      price = Number.isFinite(job.actualPrice)
        ? ` · 实际 ¥${job.actualPrice.toFixed(3)}/小时`
        : "",
      instance = job.instanceId ? ` · 临时实例 ${job.instanceId}` : "";
    $("#autodlImportStatus").textContent =
      `${job.message}${price}${instance}${job.error ? "：" + job.error : ""}`;
    if (job.status === "running")
      autodlImportPoll = setTimeout(() => pollAutoDLImageImport(id), 3000);
    else {
      $("#startAutoDLImageImport").disabled = false;
      toast(
        job.status === "completed"
          ? "镜像转存完成，临时实例已释放"
          : "镜像转存需要处理，请查看状态说明",
      );
    }
  } catch (error) {
    $("#autodlImportStatus").textContent = "读取任务状态失败：" + error.message;
  }
}
$("#openAutoDLImageImport").onclick = async () => {
  $("#autodlConfirmCost").checked = false;
  $("#autodlImageImportDialog").showModal();
  await loadAutoDLImportOptions();
};
$$('input[name="autodlSelectionMode"]').forEach(
  (input) => (input.onchange = loadAutoDLImportOptions),
);
$$("#autodlImageImportForm button[formnovalidate]").forEach(
  (button) =>
    (button.onclick = (event) => {
      event.preventDefault();
      $("#autodlImageImportDialog").close("cancel");
    }),
);
$("#autodlImageImportForm").onsubmit = async (event) => {
  event.preventDefault();
  const button = $("#startAutoDLImageImport");
  if (!$("#autodlConfirmCost").checked)
    return toast("请先确认费用和失败处理风险");
  setButtonBusy(button, "正在提交…");
  try {
    const job = await request("/api/providers/autodl/image-imports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceImageUuid: $("#autodlSourceImageUuid").value,
        imageName: $("#autodlTargetImageName").value,
        selectionMode: autodlSelectionMode(),
        productId: $("#autodlManualGpu").value,
        maxPrice: Number($("#autodlMaxPrice").value),
        confirmCost: true,
      }),
    });
    $("#autodlImportStatus").textContent = "任务已创建，正在确定 GPU…";
    pollAutoDLImageImport(job.id);
  } catch (error) {
    $("#autodlImportStatus").textContent = "提交失败：" + error.message;
  } finally {
    clearButtonBusy(button);
  }
};
async function loadProviderConfig() {
  try {
    const config = await request("/api/config/status");
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
    toast(
      provider.id === "hyperstack"
        ? "API Key 已验证，请选择部署资源"
        : `${provider.name} API Key 已加密保存并立即生效`,
    );
  } catch (error) {
    toast("保存或验证失败：" + error.message);
  } finally {
    button.disabled = false;
  }
};
function setupHyperstackConfigCollapse() {
  const form = $("#hyperstackConfigForm"),
    head = form.querySelector(".hyperstack-config-head");
  const actions = document.createElement("div");
  actions.className = "hyperstack-config-head-actions";
  const refresh = $("#refreshHyperstackResources"),
    toggle = document.createElement("button");
  toggle.id = "toggleHyperstackConfig";
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "true");
  toggle.textContent = "收起";
  actions.append(refresh, toggle);
  head.append(actions);
  const summary = document.createElement("div");
  summary.id = "hyperstackConfigSummary";
  summary.className = "hyperstack-config-summary";
  summary.hidden = true;
  head.after(summary);
  const shell = document.createElement("div"),
    body = document.createElement("div");
  shell.className = "hyperstack-config-body-shell";
  body.className = "hyperstack-config-body";
  [...form.children]
    .filter((child) => child !== head && child !== summary)
    .forEach((child) => body.append(child));
  shell.append(body);
  form.append(shell);
  toggle.onclick = () =>
    setHyperstackConfigCollapsed(
      toggle.getAttribute("aria-expanded") === "true",
    );
}
function setHyperstackConfigCollapsed(collapsed, saved = {}) {
  const form = $("#hyperstackConfigForm"),
    toggle = $("#toggleHyperstackConfig"),
    summary = $("#hyperstackConfigSummary");
  form.classList.toggle("collapsed", collapsed);
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.textContent = collapsed ? "查看或修改" : "收起";
  const values = [
    saved.environment || $("#hyperstackEnvironment").value,
    saved.keyName || $("#hyperstackKeypair").value,
    saved.region || $("#hyperstackKeypair").selectedOptions[0]?.dataset.region,
    saved.imageName || $("#hyperstackImage").value,
  ].filter(Boolean);
  summary.textContent = values.length
    ? `✓ 已保存 · ${values.join(" · ")}`
    : "尚未保存部署配置";
  summary.hidden = !collapsed;
}
if (!$("#hyperstackImageUser")) {
  const form = $("#hyperstackConfigForm"),
    submit = form.querySelector('button[type="submit"]'),
    imageUserLabel = document.createElement("label");
  imageUserLabel.innerHTML =
    '宿主机 SSH 用户 <span class="default-value-tag">默认值，可选修改</span><input id="hyperstackImageUser" autocomplete="username" placeholder="例如 ubuntu、debian">';
  submit.before(imageUserLabel);
}
setupHyperstackConfigCollapse();
async function loadHyperstackResources(saved = {}) {
  const form = $("#hyperstackConfigForm"),
    status = $("#hyperstackConfigStatus");
  form.hidden = false;
  status.textContent = "正在从 Hyperstack 读取资源…";
  for (const id of [
    "hyperstackEnvironment",
    "hyperstackKeypair",
    "hyperstackImage",
  ])
    $("#" + id).disabled = true;
  try {
    const data = await request("/api/providers/hyperstack/resources"),
      environment = $("#hyperstackEnvironment"),
      keypair = $("#hyperstackKeypair"),
      image = $("#hyperstackImage");
    environment.innerHTML = (data.environments || [])
      .map(
        (x) =>
          `<option value="${esc(x.name)}">${esc(x.name)} · ${esc(x.region || "未知区域")}</option>`,
      )
      .join("");
    const keypairs = data.keypairs || [];
    keypair.innerHTML = keypairs.length
      ? keypairs
          .map(
        (x) =>
          `<option value="${esc(x.name)}" data-keypair-id="${esc(x.id)}" data-managed="${x.platformManaged ? "true" : ""}" data-policy-mode="${esc(x.registrationPolicy?.mode || "on-demand")}" data-policy-environments="${esc(JSON.stringify(x.registrationPolicy?.environments || []))}" data-environment="${esc(x.environmentName || "")}" data-region="${esc(x.region || "")}">${esc(x.name)}${x.environmentName ? " · " + esc(x.environmentName) : ""}${x.region ? " · " + esc(x.region) : " · 区域未知"}${x.platformManaged ? " · 平台管理" : ""}</option>`,
      )
          .join("")
      : '<option value="">当前没有 SSH Keypair</option>';
    keypair.disabled = !keypairs.length;
    image.innerHTML = (data.images || [])
      .map((x) => `<option value="${esc(x.name)}">${esc(x.name)}</option>`)
      .join("");
    if (saved.environment) environment.value = saved.environment;
    if (saved.keypairId) {
      const savedOption = [...keypair.options].find(
        (option) => option.dataset.keypairId === String(saved.keypairId),
      );
      if (savedOption) savedOption.selected = true;
    } else if (saved.keyName) keypair.value = saved.keyName;
    if (saved.imageName) image.value = saved.imageName;
    const inferHyperstackImageUser = () => {
      const name = image.value.toLowerCase();
      if (name.includes("debian")) return "debian";
      if (name.includes("centos")) return "centos";
      if (name.includes("rocky") || name.includes("alma")) return "rocky";
      return "ubuntu";
    };
    $("#hyperstackImageUser").value =
      saved.imageUser || inferHyperstackImageUser();
    $("#hyperstackAgentCidr").value = saved.agentCidr || "0.0.0.0/0";
    const filterKeypairs = () => {
      const selected = environment.value;
      [...keypair.options].forEach(
        (option) =>
          (option.hidden = Boolean(
            option.dataset.environment &&
            option.dataset.environment !== selected,
          )),
      );
      if (keypair.selectedOptions[0]?.hidden) {
        const availableIndex = [...keypair.options].findIndex(
          (option) => !option.hidden,
        );
        keypair.selectedIndex = availableIndex;
      }
      renderHyperstackKeypairPicker();
      renderHyperstackKeypairRegistration(data.environments || []);
    };
    environment.onchange = filterKeypairs;
    keypair.onchange = () =>
      renderHyperstackKeypairRegistration(data.environments || []);
    image.onchange = () => {
      $("#hyperstackImageUser").value = inferHyperstackImageUser();
    };
    filterKeypairs();
    status.textContent = keypairs.length
      ? `已读取 ${data.environments?.length || 0} 个 Environment、${keypairs.length} 个 Keypair、${data.images?.length || 0} 个镜像`
      : "尚无 SSH Keypair，请先由平台创建一个";
  } catch (error) {
    status.textContent = "资源读取失败：" + error.message;
    toast(status.textContent);
  } finally {
    $("#hyperstackEnvironment").disabled = false;
    $("#hyperstackImage").disabled = false;
    $("#hyperstackKeypair").disabled = !$("#hyperstackKeypair")
      .selectedOptions[0]?.dataset.keypairId;
  }
}
$("#refreshHyperstackResources").onclick = () =>
  loadHyperstackResources(
    providerConfigStatus.find((x) => x.id === "hyperstack")?.hyperstackConfig,
  );
if (!$("#createHyperstackKeypair")) {
  const button = document.createElement("button"),
    keypairSelect = $("#hyperstackKeypair"),
    keypairLabel = keypairSelect.parentElement,
    keypairTitle = document.createElement("span");
  button.id = "createHyperstackKeypair";
  button.type = "button";
  button.className = "field-link-button";
  button.textContent = "＋ 平台创建";
  keypairTitle.className = "hyperstack-field-title";
  keypairTitle.textContent = "SSH Keypair";
  keypairTitle.append(button);
  keypairLabel.firstChild.remove();
  keypairLabel.insertBefore(keypairTitle, keypairSelect);
  const ownershipNotice = document.createElement("small");
  ownershipNotice.id = "hyperstackKeypairOwnershipNotice";
  ownershipNotice.className = "hyperstack-keypair-ownership-notice";
  ownershipNotice.setAttribute("role", "status");
  ownershipNotice.hidden = true;
  keypairSelect.after(ownershipNotice);
  const picker = document.createElement("div");
  picker.id = "hyperstackKeypairPicker";
  picker.className = "entity-picker";
  picker.innerHTML =
    '<button type="button" class="entity-picker-trigger" aria-haspopup="listbox" aria-expanded="false"><span>选择 SSH Keypair</span><i aria-hidden="true">⌄</i></button><div class="entity-picker-popup" role="listbox" hidden></div>';
  keypairSelect.classList.add("entity-picker-native");
  keypairSelect.after(picker);
  const emptyState = document.createElement("div");
  emptyState.id = "hyperstackKeypairEmpty";
  emptyState.className = "hyperstack-keypair-empty";
  emptyState.hidden = true;
  emptyState.innerHTML =
    '<span aria-hidden="true">⌁</span><div><strong>还没有 SSH Keypair</strong><small>创建后平台会加密保存私钥，用于安全连接新建的 VM。</small></div><button type="button">创建 Keypair</button>';
  emptyState.querySelector("button").onclick = () => button.click();
  ownershipNotice.after(emptyState);
  const registration = document.createElement("fieldset");
  registration.id = "hyperstackKeypairRegistration";
  registration.className = "hyperstack-keypair-registration";
  registration.innerHTML =
    '<legend>Keypair 区域注册</legend><label><input type="radio" name="hyperstackKeypairRegistrationMode" value="on-demand" checked> 按需自动注册 <small>推荐</small></label><label><input type="radio" name="hyperstackKeypairRegistrationMode" value="selected"> 注册到指定 Environment</label><div id="hyperstackKeypairEnvironmentChoices"></div><div class="hyperstack-keypair-registration-actions"><small id="hyperstackKeypairRegistrationStatus"></small><button id="saveHyperstackKeypairRegistration" type="button">保存注册策略</button></div>';
  keypairLabel.after(registration);
}
function renderHyperstackKeypairPicker() {
  const select = $("#hyperstackKeypair"),
    picker = $("#hyperstackKeypairPicker"),
    trigger = picker?.querySelector(".entity-picker-trigger"),
    popup = picker?.querySelector(".entity-picker-popup");
  if (!picker || !trigger || !popup) return;
  const options = [...select.options].filter(
      (option) => option.dataset.keypairId && !option.hidden,
    ),
    selected = select.selectedOptions[0],
    selectedManaged = selected?.dataset.managed === "true";
  trigger.disabled = !options.length;
  trigger.classList.toggle(
    "unmanaged",
    Boolean(selected?.dataset.keypairId) && !selectedManaged,
  );
  trigger.querySelector("span").textContent = selected?.dataset.keypairId
    ? `${selected.textContent}${selectedManaged ? "" : " · 非平台管理"}`
    : "当前 Environment 没有 SSH Keypair";
  popup.innerHTML = options
    .map(
      (option) =>
        `<div class="entity-picker-item ${option.selected ? "selected" : ""} ${option.dataset.managed === "true" ? "" : "unmanaged"}" role="option" aria-selected="${option.selected}"><button type="button" data-select-keypair="${esc(option.dataset.keypairId)}"><strong>${esc(option.value)}</strong><small>${esc(option.dataset.environment || "")}${option.dataset.region ? " · " + esc(option.dataset.region) : ""}${option.dataset.managed === "true" ? " · 平台管理" : " · 非平台管理 · 不可创建 VM"}</small></button><button type="button" class="entity-picker-delete" data-delete-keypair="${esc(option.dataset.keypairId)}" aria-label="删除 ${esc(option.value)}" title="删除 Keypair">×</button></div>`,
    )
    .join("");
  trigger.onclick = () => {
    const opening = popup.hidden;
    popup.hidden = !opening;
    trigger.setAttribute("aria-expanded", String(opening));
  };
  popup.querySelectorAll("[data-select-keypair]").forEach((button) => {
    button.onclick = () => {
      const option = [...select.options].find(
        (item) => item.dataset.keypairId === button.dataset.selectKeypair,
      );
      if (option) option.selected = true;
      popup.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      select.dispatchEvent(new Event("change"));
      renderHyperstackKeypairPicker();
    };
  });
  popup.querySelectorAll("[data-delete-keypair]").forEach((button) => {
    button.onclick = async (event) => {
      event.stopPropagation();
      const option = [...select.options].find(
        (item) => item.dataset.keypairId === button.dataset.deleteKeypair,
      );
      if (
        !option ||
        !(await confirmAction(
          `确定删除 SSH Keypair “${option.value}”？Hyperstack 中的公钥和平台保存的私钥都会被删除。`,
          { title: "删除 SSH Keypair", confirmText: "删除" },
        ))
      )
        return;
      button.disabled = true;
      try {
        await request(
          `/api/providers/hyperstack/keypairs/${encodeURIComponent(button.dataset.deleteKeypair)}`,
          { method: "DELETE" },
        );
        await loadProviderConfig();
        await loadHyperstackResources(
          providerConfigStatus.find((item) => item.id === "hyperstack")
            ?.hyperstackConfig || {},
        );
        toast("SSH Keypair 已删除");
      } catch (error) {
        button.disabled = false;
        toast("Keypair 删除失败：" + error.message);
      }
    };
  });
}
document.addEventListener("click", (event) => {
  const picker = $("#hyperstackKeypairPicker"),
    popup = picker?.querySelector(".entity-picker-popup"),
    trigger = picker?.querySelector(".entity-picker-trigger");
  if (picker && popup && !picker.contains(event.target)) {
    popup.hidden = true;
    trigger?.setAttribute("aria-expanded", "false");
  }
});
function renderHyperstackKeypairRegistration(environments) {
  const panel = $("#hyperstackKeypairRegistration"),
    option = $("#hyperstackKeypair").selectedOptions[0],
    choices = $("#hyperstackKeypairEnvironmentChoices"),
    status = $("#hyperstackKeypairRegistrationStatus"),
    button = $("#saveHyperstackKeypairRegistration"),
    ownershipNotice = $("#hyperstackKeypairOwnershipNotice"),
    emptyState = $("#hyperstackKeypairEmpty"),
    createButton = $("#createHyperstackKeypair"),
    hasKeypair = Boolean(option?.dataset.keypairId);
  if (!panel) return;
  panel.hidden = !hasKeypair;
  if (emptyState) emptyState.hidden = hasKeypair;
  createButton?.classList.toggle("empty-primary", !hasKeypair);
  if (!hasKeypair) {
    if (ownershipNotice) ownershipNotice.hidden = true;
    return;
  }
  const managed = option.dataset.managed === "true",
    mode = option.dataset.policyMode || "on-demand";
  if (ownershipNotice) {
    ownershipNotice.hidden = managed;
    ownershipNotice.textContent = managed
      ? ""
      : "非平台管理：平台没有此 Keypair 的私钥，不能用它在平台创建或管理 VM，也不能跨区域注册。请改选或创建一个“平台管理”的 Keypair。";
  }
  const configSubmit = $("#hyperstackConfigForm").querySelector(
    'button[type="submit"]',
  );
  if (configSubmit) {
    configSubmit.disabled = !managed;
    configSubmit.title = managed
      ? ""
      : "非平台管理的 SSH Keypair 不能用于平台创建 VM";
  }
  panel.disabled = !managed;
  panel.classList.toggle("unavailable", !managed);
  panel.querySelector(
    `input[name="hyperstackKeypairRegistrationMode"][value="${mode}"]`,
  ).checked = true;
  let selected = [];
  try {
    selected = JSON.parse(option.dataset.policyEnvironments || "[]");
  } catch {}
  choices.innerHTML = environments
    .map(
      (environment) =>
        `<label><input type="checkbox" value="${esc(environment.name)}" ${selected.includes(environment.name) ? "checked" : ""}> <span>${esc(environment.name)}</span><small>${esc(environment.region || "区域未知")}</small></label>`,
    )
    .join("");
  const updateMode = () => {
    const selectedMode = panel.querySelector(
      'input[name="hyperstackKeypairRegistrationMode"]:checked',
    )?.value;
    choices.hidden = selectedMode !== "selected";
  };
  panel
    .querySelectorAll('input[name="hyperstackKeypairRegistrationMode"]')
    .forEach((input) => (input.onchange = updateMode));
  updateMode();
  status.textContent = managed
    ? mode === "selected"
      ? `已选择 ${selected.length} 个 Environment`
      : "首次创建某区域 VM 时自动注册同一公钥"
    : "该 Keypair 不是平台管理的，无法自动复制";
  button.onclick = async () => {
    const keypairId = option.dataset.keypairId,
      selectedMode = panel.querySelector(
        'input[name="hyperstackKeypairRegistrationMode"]:checked',
      ).value,
      selectedEnvironments = [...choices.querySelectorAll('input:checked')].map(
        (input) => input.value,
      );
    button.disabled = true;
    status.textContent =
      selectedMode === "selected" ? "正在批量注册…" : "正在保存…";
    try {
      const saved = await request(
        `/api/providers/hyperstack/keypairs/${encodeURIComponent(keypairId)}/registration`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: selectedMode,
            environments: selectedEnvironments,
          }),
        },
      );
      option.dataset.policyMode = saved.mode;
      option.dataset.policyEnvironments = JSON.stringify(saved.environments);
      await loadHyperstackResources({
        ...providerConfigStatus.find((item) => item.id === "hyperstack")
          ?.hyperstackConfig,
        keypairId,
      });
      toast("SSH Keypair 注册策略已保存");
    } catch (error) {
      status.textContent = "保存失败：" + error.message;
    } finally {
      button.disabled = false;
    }
  };
}
$("#createHyperstackKeypair").onclick = async () => {
  const button = $("#createHyperstackKeypair"),
    environment = $("#hyperstackEnvironment").value;
  if (!environment) return toast("请先选择 Environment");
  if (
    !(await confirmAction(
      `平台将在 ${environment} 创建新的 SSH Keypair，并加密保存私钥。`,
      { title: "创建 SSH Keypair", confirmText: "创建" },
    ))
  )
    return;
  button.disabled = true;
  button.textContent = "创建中…";
  try {
    const created = await request("/api/providers/hyperstack/keypairs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environment }),
    });
    await loadHyperstackResources({
      ...providerConfigStatus.find((x) => x.id === "hyperstack")
        ?.hyperstackConfig,
      environment,
      keyName: created.name,
    });
    toast(`已创建并安全保存 Keypair：${created.name}`);
  } catch (error) {
    toast("Keypair 创建失败：" + error.message);
  } finally {
    button.disabled = false;
    button.textContent = "＋ 平台创建";
  }
};
$("#hyperstackConfigForm").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]'),
    keypairOption = $("#hyperstackKeypair").selectedOptions[0];
  if (keypairOption?.dataset.managed !== "true")
    return toast(
      "当前 SSH Keypair 不是平台管理，不能用于平台创建 VM；请改选或创建平台管理的 Keypair",
    );
  button.disabled = true;
  try {
    await request("/api/providers/hyperstack/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        environment: $("#hyperstackEnvironment").value,
        keyName: $("#hyperstackKeypair").value,
        keypairId:
          $("#hyperstackKeypair").selectedOptions[0]?.dataset.keypairId,
        imageName: $("#hyperstackImage").value,
        imageUser: $("#hyperstackImageUser").value,
        agentCidr: $("#hyperstackAgentCidr").value,
      }),
    });
    await loadProviderConfig();
    await showBillingProvider("hyperstack");
    toast("Hyperstack 部署配置已保存，可以创建虚拟机");
  } catch (error) {
    toast("配置保存失败：" + error.message);
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
        if (o.provider === "ppio") {
          const loaded = Array.isArray(o.regionalOffers);
          return `<tr data-offer-row="${esc(o.id)}"><td><strong>${o.gpuCount || 1}× ${esc(o.gpu)}</strong><span class="sub">${esc(details)}</span></td><td><span class="provider"><i>P</i>${esc(o.providerName)}</span></td><td>${loaded ? o.regionalOffers.length : o.regions?.length || 0} 个地区</td><td class="sub">${loaded ? "展开后查看" : "按需查询库存"}</td><td><span class="score">${loaded ? "实时" : "待查询"}</span></td><td>${loaded ? "已加载" : "点击查看地区"}</td><td class="price"><strong>${esc(price)}</strong><span class="sub">参考价</span></td><td><button class="launch" data-regions="${esc(o.id)}">查看地区 ↓</button></td></tr>`;
        }
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
  $$("[data-regions]").forEach((b) => (b.onclick = () => toggleRegions(b)));
}

async function toggleRegions(button) {
  let offer = offers.find((o) => o.id === button.dataset.regions);
  const row = button.closest("tr"),
    existing = row.nextElementSibling;
  if (existing?.classList.contains("region-detail")) {
    existing.remove();
    button.textContent = "查看地区 ↓";
    return;
  }
  button.disabled = true;
  button.textContent = Array.isArray(offer?.regionalOffers)
    ? "展开中…"
    : "查询库存…";
  try {
    if (!Array.isArray(offer?.regionalOffers)) {
      const regional = await request("/api/providers/ppio/regional-inventory"),
        byId = new Map(regional.offers.map((x) => [x.id, x]));
      offers = offers.map((x) => byId.get(x.id) || x);
      applyInstancePrices(regional.offers);
      offer = offers.find((o) => o.id === button.dataset.regions);
    }
    const regions = offer?.regionalOffers || [];
    const detail = document.createElement("tr");
    detail.className = "region-detail";
    const labels = {
      none: "无库存",
      low: "库存紧张",
      normal: "库存一般",
      high: "库存充足",
      unknown: "查询失败",
    };
    detail.innerHTML = `<td colspan="8"><div class="region-grid">${
      regions
        .map((r, i) => {
          const key = `${offer.id}|${i}`,
            canLaunch = r.inventory !== "none" && r.inventory !== "unknown";
          regionalSelections.set(key, {
            ...offer,
            clusterId: r.clusterId,
            region: r.region,
            price: r.price,
            inventory: r.inventory,
            deployable: r.deployable,
          });
          const action = !canLaunch
            ? "无库存"
            : r.deployable
              ? "立即创建"
              : "尝试创建";
          return `<article><div><strong>${esc(r.region)}</strong><span class="availability ${r.inventory === "low" ? "limited" : canLaunch ? "" : "unavailable"}">● ${labels[r.inventory] || r.inventory}</span></div><div class="region-price">${formatPrice({ ...offer, ...r }, "价格未知")}</div><button class="launch" data-region-launch="${esc(key)}" ${canLaunch ? "" : "disabled"}>${action}</button></article>`;
        })
        .join("") || "没有可用地区数据"
    }</div></td>`;
    row.after(detail);
    detail.querySelectorAll("[data-region-launch]").forEach(
      (b) =>
        (b.onclick = () => {
          selected = regionalSelections.get(b.dataset.regionLaunch);
          showLaunch();
        }),
    );
    button.textContent = "收起地区 ↑";
  } catch (e) {
    toast(e.message);
    button.textContent = "重试展开";
  } finally {
    button.disabled = false;
  }
}
function applyInstancePrices(regionalOffers) {
  instancePricingOffers = regionalOffers || instancePricingOffers;
  const normalize = (value) =>
    String(value || "")
      .toLowerCase()
      .replace(/nvidia|geforce|\s|-/g, "");
  for (const instance of instances) {
    if (instance.provider !== "ppio") continue;
    const product =
      instancePricingOffers.find(
        (p) => String(p.productId) === String(instance.productId),
      ) ||
      instancePricingOffers.find(
        (p) => normalize(p.gpu) === normalize(instance.gpu),
      );
    const regional = product?.regionalOffers?.find(
        (r) =>
          String(r.clusterId) === String(instance.clusterId) ||
          r.region === instance.region,
      ),
      price = Number(regional?.price),
      fallback = Number(product?.price);
    instance.price =
      Number.isFinite(price) && price > 0
        ? price
        : Number.isFinite(fallback) && fallback > 0
          ? fallback
          : undefined;
    instance.priceSource =
      price > 0
        ? "regional-inventory"
        : fallback > 0
          ? "product-fallback"
          : "unavailable";
    const el = document.getElementById("price-" + String(instance.id));
    if (el) el.textContent = formatPrice(instance, "—");
  }
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
        try {
          const regional = await request(
              "/api/providers/ppio/regional-inventory?refresh=1",
            ),
            byId = new Map(regional.offers.map((x) => [x.id, x]));
          offers = offers.map((x) => byId.get(x.id) || x);
          renderOffers();
          applyInstancePrices(regional.offers);
        } catch (e) {
          toast(`PPIO 地区库存加载失败：${e.message}`);
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
  if(type==="docker")$("#cudaFallbackWrap").style.display=selected?.provider==="hyperstack"&&profile?.cudaMajor===13?"block":"none";
}
function profileOptions(type){return imageProfiles.filter(profile=>profile.profileType===type).map(profile=>`<option value="${esc(profile.id)}" ${profile.recommended&&profile.localFileExists!==false?"selected":""} ${profile.localFileExists===false?"disabled":""}>${esc(profile.name)}${profile.localFileExists===false?"（本地脚本不存在）":""}</option>`).join("");}
async function showLaunch() {
  $("#selectedOffer").innerHTML =
    `<div class="offer-summary"><strong>${selected.gpuCount || 1}× ${esc(selected.gpu)}</strong><div class="sub">${esc(selected.providerName)} · ${esc(selected.region || "自动调度")}${selected.vram ? " · " + selected.vram + " GB 显存" : ""}</div></div>`;
  $("#dialogPrice").textContent = formatPrice(
    selected,
    selected.priceEstimateUnavailable ? "无法预估" : "以供应商创建响应为准",
  );
  $("#dialogPrice").previousElementSibling.querySelector("small").textContent =
    selected.priceEstimated
      ? `其他厂商同型号中位数估价 · 来源：${(selected.estimateProviders || []).join("、")} · 创建后显示 AutoDL 真实价格`
      : selected.priceEstimateUnavailable
        ? "其他厂商没有同型号、同配置实例；创建后显示 AutoDL 真实价格"
      : "按实际运行时长计费";
  $("#cudaFallbackWrap").style.display =
    selected.provider === "hyperstack" ? "block" : "none";
  $("#allowCuda128Fallback").checked = false;
  const imageSelect=$("#imageVersion"),dockerSelect=$("#dockerProfile"),vmSelect=$("#vmProfile");
  $("#providerImageWrap").hidden=selected.provider!=="autodl";
  $("#dockerProfileWrap").hidden=selected.provider==="hyperstack";
  $("#vmProfileWrap").hidden=selected.provider!=="hyperstack";
  imageSelect.disabled=dockerSelect.disabled=vmSelect.disabled=true;
  dockerSelect.innerHTML="<option>正在加载 Docker 配置…</option>";
  vmSelect.innerHTML="<option>正在加载 VM 配置…</option>";
  if (selected.provider === "autodl") {
    $("#imageVersionHint").textContent =
      "可选择账号镜像（含已共享到账号的社区镜像）或官方基础镜像。";
  }
  $("#launchDialog").showModal();
  try {
    ({profiles:imageProfiles}=await request("/api/image-profiles"));
    dockerSelect.innerHTML=profileOptions("docker");
    vmSelect.innerHTML=profileOptions("vm");
    if(!dockerSelect.options.length)throw Error("没有可用的 Docker 开机行为");
    if(selected.provider==="hyperstack"&&!vmSelect.options.length)throw Error("没有可用的 VM 开机行为");
    dockerSelect.onchange=()=>behaviorHint("docker");
    vmSelect.onchange=()=>behaviorHint("vm");
    behaviorHint("docker");
    if(selected.provider==="hyperstack")behaviorHint("vm");
    if (selected.provider === "autodl") {
      const discovery = await request("/api/providers/autodl/discovery"),
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
          ? `<optgroup label="AutoDL 官方基础镜像">${options(official)}</optgroup>`
          : "");
      if (!account.length && !official.length)
        throw Error("AutoDL 没有返回可用镜像");
    }
    imageSelect.disabled=selected.provider!=="autodl";
    dockerSelect.disabled=false;
    vmSelect.disabled=selected.provider!=="hyperstack";
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
    old = button.textContent;
    if(selected.provider==="autodl"&&(!$("#imageVersion").value||$("#imageVersion").disabled))return toast("请先选择可用的厂商镜像");
    if(selected.provider!=="hyperstack"&&(!$("#dockerProfile").value||$("#dockerProfile").disabled))return toast("请先选择 Docker 开机行为");
    if(selected.provider==="hyperstack"&&(!$("#vmProfile").value||$("#vmProfile").disabled))return toast("请先选择 VM 开机行为");
    const launchProfile=imageProfiles.find(profile=>profile.id===$("#dockerProfile").value),vmLaunchProfile=imageProfiles.find(profile=>profile.id===$("#vmProfile").value);
    if(selected.provider!=="hyperstack"&&launchProfile?.localFileExists===false||selected.provider==="hyperstack"&&vmLaunchProfile?.localFileExists===false)return toast("本地启动脚本不存在，请到开机行为页重新选择文件");
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
        imageVersion:
          selected.provider === "autodl" ? undefined : $("#imageVersion").value,
            imageProfileId:
              selected.provider === "hyperstack" ? undefined : $("#dockerProfile").value,
        vmProfileId:
          selected.provider === "hyperstack" ? $("#vmProfile").value : undefined,
        imageUuid:
          selected.provider === "autodl" ? $("#imageVersion").value : undefined,
        cudaMin:
          selected.provider === "autodl"
            ? Number($("#imageVersion").selectedOptions[0]?.dataset.cudaMin) ||
              undefined
            : undefined,
        allowCuda128Fallback:
          selected.provider === "hyperstack" &&
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
    } else if (error.code === "autodl_no_compatible_host") {
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
