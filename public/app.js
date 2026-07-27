const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const hyperstackCidrDefaultTimer = setInterval(() => {
  const input = $("#hyperstackAgentCidr"),
    form = $("#hyperstackConfigForm"),
    status = $("#hyperstackConfigStatus");
  if (
    !input ||
    form?.hidden ||
    status?.textContent === "正在从 Hyperstack 读取资源…"
  )
    return;
  if (!input.value) input.value = "0.0.0.0/0";
  input.placeholder = "0.0.0.0/0 允许从任意 IPv4 地址连接";
  if (input.parentElement?.firstChild)
    input.parentElement.firstChild.nodeValue = "SSH 来源 CIDR";
  clearInterval(hyperstackCidrDefaultTimer);
}, 250);
let offers = [],
  selected = null,
  instances = [],
  streams = new Map(),
  regionalSelections = new Map(),
  instancePricingOffers = [],
  runtimeImages = [];
const telemetryCache = new Map(),
  reachabilityCache = new Map(),
  expandedInstances = new Set(),
  reachabilityLoads = new Set(),
  instanceBenchmarkRuns = new Map();
function decorateSshEntries() {
  document.querySelectorAll(".instance").forEach(function (card) {
    const el = card.querySelector(".instance-actions > .sub");
    if (!el || el.dataset.sshReady) return;
    const instance = instances.find(
      (i) => i.ip && i.ip === el.textContent.trim(),
    );
    if (!instance?.sshReady || (!instance?.sshHost && !instance?.ip)) return;
    const user = instance.sshUser || "ubuntu",
      host = instance.sshHost || instance.ip,
      port = instance.sshPort || 22,
      link = document.createElement("a");
    link.className = "sub ssh-entry";
    link.href = "ssh://" + user + "@" + host + ":" + port;
    link.textContent =
      "SSH " + user + "@" + host + (port === 22 ? "" : ":" + port);
    link.title = "打开 SSH 连接";
    link.dataset.sshReady = "1";
    el.replaceWith(link);
    const title = card.querySelector(".detail-head strong"),
      note = card.querySelector(".detail-head small");
    if (title) title.textContent = "SSH 外网可达性";
    if (note) note.textContent = "由平台直连云主机 SSH 端口，不依赖 Agent";
  });
}
new MutationObserver(decorateSshEntries).observe($("#instanceGrid"), {
  childList: true,
  subtree: true,
});
let offersLoading = null,
  inventoryNoticeTimer = null,
  instancePollTimer = null;
const pendingInstanceActions = new Map();
function formatInitializationElapsed(startedAt) {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(startedAt)) / 1000),
  );
  if (!Number.isFinite(seconds)) return "00:00";
  const hours = Math.floor(seconds / 3600),
    minutes = Math.floor((seconds % 3600) / 60),
    remaining = seconds % 60;
  return hours
    ? String(hours).padStart(2, "0") +
        ":" +
        String(minutes).padStart(2, "0") +
        ":" +
        String(remaining).padStart(2, "0")
    : String(minutes).padStart(2, "0") +
        ":" +
        String(remaining).padStart(2, "0");
}
function platformProvisioningLabel(instance) {
  if (instance?.lifecycleAction === "start") return "启动中";
  const phase = String(instance?.runtime?.phase || "");
  // SSH 安装完成前，平台无法通过 SSH 读取实例内的 profile.json，因此
  // starting_ssh 阶段可能天然不可观测。供应商已 running 且 SSH 尚未就绪
  // 时，应根据外部状态明确推断为 SSH 准备阶段，而不是退回笼统的初始化。
  if (
    instance?.providerState === "running" &&
    !instance?.sshReady &&
    (!phase || ["awaiting_bootstrap", "awaiting_ssh"].includes(phase))
  )
    // 具体错误只在下方 SSH 诊断框显示，状态标题保留阶段信息，避免同一
    // 条连接错误在卡片内重复出现。
    return instance?.sshDiagnostic?.state === "probing"
      ? "正在检测 SSH 是否就绪"
      : "正在等待 SSH 安装并就绪";
  if (
    [
      "checking_registry",
      "pulling_image",
      "image_pulled",
      "starting_runtime",
      "checking_runtime",
    ].includes(phase) ||
    /pull|image/i.test(String(instance?.providerStatus || ""))
  )
    return "初始化镜像中";
  if (
    [
      "installing_runtime_dependencies",
      "installing_dependencies",
      "installing_core",
      "installing_optional",
      "building_nvbandwidth",
    ].includes(phase)
  )
    return "正在安装构建工具与运行依赖";
  if (["installing_developer_tools", "installing_ai_tools"].includes(phase))
    return "正在安装开发工具";
  if (phase === "starting_ssh") return "正在安装并配置 SSH";
  if (["validating_cuda", "verifying_gpu"].includes(phase))
    return "正在验证 GPU";
  if (phase === "starting_agent") return "正在启动监控 Agent";
  if (phase === "syncing_data") return "正在同步数据";
  return "正在进行平台初始化";
}
function instanceConnectionRecoveryLabel(instance) {
  if (
    instance?.providerState !== "running" ||
    !instance?.platformManaged ||
    instance?.sshReady
  )
    return "";
  return instance?.sshDiagnostic?.state === "probing"
    ? "正在检测远端 SSH 与遥测连接是否恢复"
    : "远端 SSH 尚未就绪，正在等待 SSH 与遥测连接恢复";
}
function updateInitializationTimers() {
  $$("[data-initialization-started-at]").forEach(function (timer) {
    const card = timer.closest(".instance"),
      id = card?.querySelector("[data-action]")?.dataset.id,
      instance = instances.find(function (item) {
        return String(item.id) === String(id);
      });
    if (!card || !instance) return;
    timer.textContent =
      platformProvisioningLabel(instance) +
      " · " +
      formatInitializationElapsed(timer.dataset.initializationStartedAt);
    const shouldTimeout =
        Date.now() - Date.parse(timer.dataset.initializationStartedAt) >=
        15 * 60 * 1000,
      current = card.querySelector(".initialization-detail");
    if (!current || current.classList.contains("timed-out") !== shouldTimeout) {
      current?.remove();
      card
        .querySelector(".instance-top")
        ?.insertAdjacentHTML(
          "afterend",
          initializationDetailsMarkup(
            instance,
            timer.dataset.initializationStartedAt,
          ),
        );
    }
  });
}
setInterval(updateInitializationTimers, 1000);
function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes,
    index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index++;
  }
  return (
    (index ? size.toFixed(size >= 10 ? 1 : 2) : Math.round(size)) +
    " " +
    units[index]
  );
}
function initializationDetailsMarkup(instance, startedAt) {
  if (instance.status !== "provisioning") return "";
  const progress = instance.provisionProgress,
    elapsed = startedAt ? Date.now() - Date.parse(startedAt) : 0,
    timedOut = Number.isFinite(elapsed) && elapsed >= 15 * 60 * 1000;
  const percent = Number(progress?.percent),
    hasPercent = Number.isFinite(percent);
  const amount =
    progress?.loadedBytes !== undefined
      ? formatBytes(progress.loadedBytes) +
        (progress.totalBytes !== undefined
          ? " / " + formatBytes(progress.totalBytes)
          : "")
      : "";
  const label =
    progress?.label ||
    (/pull/i.test(instance.providerStatus || "")
      ? "正在拉取容器镜像"
      : "等待供应商完成初始化");
  const progressMarkup = hasPercent
    ? '<div class="initialization-progress-head"><strong>' +
      esc(label) +
      "</strong><span>" +
      esc(amount || Math.round(percent) + "%") +
      '</span></div><progress value="' +
      Math.max(0, Math.min(100, percent)) +
      '" max="100"></progress>' +
      (progress?.message ? "<small>" + esc(progress.message) + "</small>" : "")
    : "";
  const providerMarkup =
    '<div><strong>供应商状态：' +
    esc(instance.providerStatus || "unknown") +
    "</strong>" +
    (instance.providerSubStatus
      ? "<small>" + esc(instance.providerSubStatus) + "</small>"
      : "") +
    "</div>";
  const sshMarkup = instance.sshDiagnostic?.message
    ? '<div class="initialization-timeout"><strong>SSH 尚未就绪</strong><span>' +
      esc(instance.sshDiagnostic.message) +
      "</span></div>"
    : "";
  const timeoutMarkup = timedOut
    ? '<div class="initialization-timeout"><strong>初始化已超过大部分正常安装时间</strong><span>实例仍在持续计费，建议通过 SSH 排障；确认卡住后请删除实例以停止计费。</span><button type="button" data-timeout-delete="' +
      esc(instance.id) +
      '">删除并停止计费</button></div>'
    : "";
  return providerMarkup || progressMarkup || sshMarkup || timeoutMarkup
    ? '<div class="initialization-detail' +
        (timedOut ? " timed-out" : "") +
        '">' +
        providerMarkup +
        progressMarkup +
        sshMarkup +
        timeoutMarkup +
        "</div>"
    : "";
}
document.addEventListener("click", function (event) {
  const button = event.target.closest("[data-timeout-delete]");
  if (!button) return;
  const instance = instances.find(function (item) {
    return String(item.id) === String(button.dataset.timeoutDelete);
  });
  if (instance) instanceAction(instance.id, "delete", button);
});
const inventoryNotice = document.createElement("div");
inventoryNotice.id = "inventoryNotice";
inventoryNotice.className = "inventory-notice";
inventoryNotice.hidden = true;
inventoryNotice.setAttribute("role", "status");
inventoryNotice.setAttribute("aria-live", "assertive");
inventoryNotice.innerHTML =
  "<strong>库存已经变化，需要刷新</strong><span>正在重新获取各供应商的最新库存，请稍候。</span>";
document.body.append(inventoryNotice);
const inventoryNoticeStyle = document.createElement("style");
inventoryNoticeStyle.textContent =
  ".inventory-notice{position:fixed;z-index:10000;top:22px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:14px;min-width:min(620px,calc(100vw - 40px));padding:16px 20px;border:1px solid #e7a92d;border-left:5px solid #d78500;border-radius:9px;background:#fff4d8;color:#704b00;box-shadow:0 12px 36px #53370045}.inventory-notice[hidden]{display:none}.inventory-notice strong{font-size:15px}.inventory-notice span{color:#88651f}.inventory-notice.done{border-color:#50a874;border-left-color:#228653;background:#eaf8ef;color:#155b35}.inventory-notice.done span{color:#34704f}";
document.head.append(inventoryNoticeStyle);
function showInventoryNotice(done = false) {
  clearTimeout(inventoryNoticeTimer);
  inventoryNotice.hidden = false;
  inventoryNotice.classList.toggle("done", done);
  inventoryNotice.querySelector("strong").textContent = done
    ? "库存已刷新"
    : "库存已经变化，需要刷新";
  inventoryNotice.querySelector("span").textContent = done
    ? "最新库存已经载入，请重新选择资源。"
    : "正在重新获取各供应商的最新库存，请稍候。";
  if (done)
    inventoryNoticeTimer = setTimeout(
      () => (inventoryNotice.hidden = true),
      5000,
    );
}
const pages = {
  market: ["算力市场", "跨供应商比较并即时启动 GPU"],
  instances: ["我的实例", "SSH 文件上传与增量同步"],
  funds: ["供应商账户中心", "管理供应商充值与 API Key"],
  storage: ["S3 存储设置", "配置独立的 S3-compatible 对象存储"],
  settings: ["平台设置", "控制面地址与部署模式"],
};
function createPlatformSettingsUi() {
  const styles = document.createElement("link");
  styles.rel = "stylesheet";
  styles.href = "/platform-settings.css";
  document.head.append(styles);
  const button = document.createElement("button");
  button.dataset.view = "settings";
  button.innerHTML = "<span>⚙</span> 平台设置";
  document.querySelector(".sidebar nav").append(button);
  const section = document.createElement("section");
  section.id = "settings";
  section.className = "view";
  section.innerHTML =
    '<div class="platform-settings-head"><div><span class="eyebrow">TELEMETRY</span><h2>平台设置</h2><p>选择云实例 GPU 状态的采集通道。</p></div><span id="controlPlaneMode" class="pill stopped">正在读取…</span></div><form id="controlPlaneForm" class="table-card platform-settings-form"><fieldset class="telemetry-mode-options"><legend>遥测方式</legend><label><input type="radio" name="telemetryMode" value="ssh" checked><span><strong>SSH 长连接（默认）</strong><small>平台直连实例并持续采集，不需要公网控制面地址。</small></span></label><label><input type="radio" name="telemetryMode" value="named-tunnel"><span><strong>Cloudflare Named Tunnel</strong><small>实例通过固定 HTTPS 地址主动上报。</small></span></label></fieldset><div id="namedTunnelFields" hidden><div class="named-tunnel-heading"><strong>Cloudflare 认证</strong><button id="showNamedTunnelHelp" class="info-button" type="button" aria-label="查看 Named Tunnel 配置帮助">i</button></div><div id="cloudflareLoginStatus" class="platform-settings-status">正在检测 Cloudflare 登录状态…</div><div id="cloudflareActions" class="platform-settings-actions"><button id="installCloudflared" type="button" hidden>安装 cloudflared</button><button id="loginCloudflare" type="button" hidden>登录 Cloudflare</button></div><label>固定公网 URL（BASE_URL）<input id="controlPlaneBaseUrl" type="url" placeholder="https://gpu.example.com"><small>请使用当前 Cloudflare 账户中尚未占用的专用域名；保存时平台会创建或复用 Named Tunnel、配置 DNS 并进行公网回探。</small></label><button id="openCloudflareNamedTunnel" type="button">打开 Cloudflare Tunnel 控制台</button></div><div id="controlPlaneStatus" class="platform-settings-status">正在读取后端配置…</div><div class="platform-settings-actions"><button id="saveControlPlane" class="primary" type="submit">保存并测试</button></div></form>';
  section.insertAdjacentHTML(
    "beforeend",
    '<div id="cliPathCard" class="table-card local-tool-card" hidden><div class="local-tool-card-head"><div><h3>命令行与 PATH</h3><p id="cliPathStatus">正在读取用户 PATH…</p></div><button type="button" id="registerCliPath">注册到 PATH</button></div><small class="tool-note">注册后可在新打开的 CMD 或 PowerShell 中运行 <code>fast-gpu</code> 唤起客户端。只修改当前 Windows 用户的 PATH。</small></div>',
  );
  section.insertAdjacentHTML(
    "beforeend",
    '<div id="localToolsCard" class="table-card local-tool-card"><div class="local-tool-card-head"><div><h3>本地工具</h3><p>统一检查文件传输和远程连接所需的本机依赖。</p></div><button type="button" id="refreshLocalTools">重新检测</button></div><div id="localToolsList" class="local-tools-list" aria-live="polite"><div class="local-tool-row"><div><strong>正在检测…</strong><small>请稍候</small></div></div></div><small class="tool-note">Named Tunnel 由 Cloudflare 独立管理，平台只保存固定 URL。</small></div>',
  );
  document.querySelector("main").append(section);
  const help=document.createElement("dialog");help.id="namedTunnelHelpDialog";help.innerHTML='<form method="dialog"><button class="close" value="cancel" aria-label="关闭">×</button><span class="eyebrow">NAMED TUNNEL HELP</span><h2>Cloudflare Named Tunnel 如何工作</h2><ol class="named-tunnel-steps"><li><strong>准备域名</strong><span>先拥有一个域名，并把该域名的 DNS 托管到 Cloudflare。</span></li><li><strong>安装并登录</strong><span>本机需要 cloudflared。点击“登录 Cloudflare”后在浏览器中授权；授权会在本机生成账户证书 cert.pem。</span></li><li><strong>填写固定地址</strong><span>填写当前账户名下的 HTTPS 域名，例如 https://gpu.example.com。</span></li><li><strong>保存并验证</strong><span>平台创建或复用专用 Named Tunnel，将域名路由到本机平台端口，然后从公网回探专属校验接口。只有验证成功才会保存。</span></li></ol><p class="security-note">cert.pem 可以管理该 Cloudflare 账户的 Tunnel，请仅保存在可信电脑上；平台不会上传该证书。</p><menu><button value="cancel">我知道了</button></menu></form>';document.body.append(help);
}
createPlatformSettingsUi();
const UI_STATE_KEY = "gpu-fleet-console-state-v1";
const WINDOW_STATE_KEY = "gpu-fleet-client-window-v1";
function setupDesktopTitlebar() {
  if (!window.gpuFleetWindow) return;
  const styles = document.createElement("link");
  styles.rel = "stylesheet";
  styles.href = "/electron-titlebar.css";
  document.head.append(styles);
  const titlebar = document.createElement("div");
  titlebar.className = "desktop-titlebar";
  titlebar.setAttribute("aria-label", "应用窗口标题栏");
  titlebar.innerHTML =
    '<div class="desktop-title"><span class="desktop-title-logo">G</span><strong>Fast GPU</strong></div><div class="desktop-window-controls"><button type="button" data-window-action="minimize" aria-label="最小化">—</button><button type="button" data-window-action="maximize" aria-label="最大化">□</button><button type="button" data-window-action="close" aria-label="关闭">×</button></div>';
  document.body.prepend(titlebar);
  document.body.classList.add("electron-client");
  const maximizeButton = $('[data-window-action="maximize"]');
  const showMaximized = (maximized) => {
    maximizeButton.textContent = maximized ? "❐" : "□";
    maximizeButton.setAttribute(
      "aria-label",
      maximized ? "还原窗口" : "最大化",
    );
  };
  $('[data-window-action="minimize"]').onclick = () =>
    window.gpuFleetWindow.minimize();
  maximizeButton.onclick = async () =>
    showMaximized(await window.gpuFleetWindow.toggleMaximize());
  $('[data-window-action="close"]').onclick = () =>
    window.gpuFleetWindow.close();
  window.gpuFleetWindow.isMaximized().then(showMaximized);
  window.gpuFleetWindow.onMaximizedChange(showMaximized);
}
setupDesktopTitlebar();
function readUiState() {
  try {
    return JSON.parse(localStorage.getItem(UI_STATE_KEY) || "{}");
  } catch {
    return {};
  }
}
function saveUiState(patch = {}) {
  try {
    localStorage.setItem(
      UI_STATE_KEY,
      JSON.stringify({ ...readUiState(), ...patch }),
    );
  } catch {}
}
function restoreClientWindow() {
  if (new URLSearchParams(location.search).get("client") !== "1") return;
  try {
    const state = JSON.parse(localStorage.getItem(WINDOW_STATE_KEY) || "null");
    if (!state) return;
    const width = Math.max(
      900,
      Math.min(Number(state.width) || 1200, screen.availWidth),
    );
    const height = Math.max(
      650,
      Math.min(Number(state.height) || 800, screen.availHeight),
    );
    const availLeft = Number(screen.availLeft) || 0,
      availTop = Number(screen.availTop) || 0;
    const left = Math.max(
      availLeft,
      Math.min(
        Number(state.left) || availLeft,
        availLeft + screen.availWidth - width,
      ),
    );
    const top = Math.max(
      availTop,
      Math.min(
        Number(state.top) || availTop,
        availTop + screen.availHeight - height,
      ),
    );
    setTimeout(() => {
      window.resizeTo(width, height);
      window.moveTo(left, top);
    }, 100);
  } catch {}
  const save = () => {
    try {
      localStorage.setItem(
        WINDOW_STATE_KEY,
        JSON.stringify({
          width: outerWidth,
          height: outerHeight,
          left: screenX,
          top: screenY,
        }),
      );
    } catch {}
  };
  let timer;
  addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(save, 250);
  });
  addEventListener("pagehide", save);
}
restoreClientWindow();
function restoreUiState() {
  const state = readUiState();
  for (const id of ["search", "gpuFilter", "providerFilter"])
    if (typeof state[id] === "string" && $("#" + id))
      $("#" + id).value = state[id];
  return pages[state.view] ? state.view : "market";
}
function formatPrice(item, fallback = "创建前确认") {
  if (!Number.isFinite(item?.price) || item.price <= 0) return fallback;
  const [currency = "CNY", period = "hour"] = String(
    item.priceUnit ||
      { ppio: "CNY/hour", hyperstack: "USD/hour", runpod: "USD/hour" }[
        item.provider
      ] ||
      "CNY/hour",
  ).split("/");
  const periodLabel = { hour: "小时", month: "月" }[period] || period;
  return `${currency} ${item.price.toFixed(2)} / ${periodLabel}`;
}
function formatEstimatedCost(item) {
  const billing = item?.billing;
  if (!billing) return "";
  if (Number.isFinite(billing.amount) && billing.currency)
    return `预估已花费 ${billing.currency} ${billing.amount.toFixed(2)}`;
  const parts = Object.entries(billing.totals || {}).map(
    ([currency, amount]) => `${currency} ${Number(amount).toFixed(2)}`,
  );
  return parts.length
    ? `预估已花费 ${parts.join(" + ")}`
    : "预估已花费：价格未知";
}
function updateInstanceTotalSpend() {
  const badge = $("#instanceTotalSpend"),
    totals = {},
    unknownCount = instances.filter(function (item) {
      const billing = item?.billing,
        entries = Object.entries(billing?.totals || {}).filter(function (
          entry,
        ) {
          return Number.isFinite(Number(entry[1]));
        });
      for (const [currency, amount] of entries)
        totals[currency] = (totals[currency] || 0) + Number(amount);
      return !entries.length || Number(billing?.unknownSeconds) > 0;
    }).length,
    parts = Object.entries(totals)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, amount]) => `${currency} ${amount.toFixed(2)}`);
  badge.textContent = `总花销 ${parts.length ? parts.join(" + ") : "0.00"}${unknownCount ? ` · ${unknownCount} 台价格未知` : ""}`;
  badge.title = "所有当前实例的预估累计花销；不同币种分别统计";
}
function decorateEstimatedCosts() {
  document.querySelectorAll(".instance").forEach(function (card) {
    const cost = card.querySelector('[id^="price-"] small'),
      title = card.querySelector(".instance-top>div>strong");
    if (!cost || !title) return;
    let badge = title.parentElement.querySelector(".estimated-spend");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "estimated-spend";
      title.insertAdjacentElement("afterend", badge);
    }
    badge.textContent = cost.textContent;
    cost.remove();
  });
}
new MutationObserver(decorateEstimatedCosts).observe($("#instanceGrid"), {
  childList: true,
  subtree: true,
});
function decorateNicknameEditors() {
  document.querySelectorAll(".instance").forEach(function (card) {
    const action = card.querySelector("[data-action]"),
      title = card.querySelector(".instance-top>div>strong");
    if (!action || !title) return;
    const instance = instances.find(function (item) {
      return String(item.id) === String(action.dataset.id);
    });
    if (!instance) return;
    const metadata = card.querySelector(".instance-top>div>.sub");
    const metadataText =
      "供应商：" + instance.provider + " · 实例 ID：" + instance.id;
    if (metadata && metadata.textContent !== metadataText)
      metadata.textContent = metadataText;
    title.classList.add("editable-nickname");
    title.dataset.nicknameInstance = String(instance.id);
    title.title = "双击修改昵称";
    if (!card.querySelector(".provider-original-name")) {
      const note = document.createElement("span");
      note.className = "provider-original-name";
      note.textContent =
        "供应商侧：" + (instance.providerNameOriginal || instance.name);
      if (instance.providerRenameSupported) {
        note.classList.add("editable-provider-name");
        note.dataset.providerNameInstance = String(instance.id);
        note.title = "双击修改供应商侧名称";
      } else note.title = "该供应商没有公开的实例改名 API";
      title.insertAdjacentElement("afterend", note);
    }
  });
}
new MutationObserver(decorateNicknameEditors).observe($("#instanceGrid"), {
  childList: true,
  subtree: true,
});
document.addEventListener("dblclick", function (event) {
  const target = event.target.closest(
    "[data-nickname-instance],[data-provider-name-instance]",
  );
  if (!target || target.parentElement.querySelector(".nickname-editor")) return;
  const providerSide = target.hasAttribute("data-provider-name-instance"),
    id = providerSide
      ? target.dataset.providerNameInstance
      : target.dataset.nicknameInstance;
  const instance = instances.find(function (item) {
    return String(item.id) === String(id);
  });
  if (!instance) return;
  const editor = document.createElement("span");
  editor.className = "nickname-editor";
  editor.dataset.editTarget = providerSide ? "provider" : "nickname";
  editor.dataset.instanceId = String(instance.id);
  editor.innerHTML =
    '<input maxlength="80"><button type="button" data-confirm-instance-name>确认修改</button><button type="button" data-cancel-instance-name>取消</button>';
  editor
    .querySelector("input")
    .setAttribute("aria-label", providerSide ? "供应商侧名称" : "实例昵称");
  editor.querySelector("input").value = providerSide
    ? instance.providerNameOriginal || instance.name
    : instance.name;
  target.hidden = true;
  target.insertAdjacentElement("beforebegin", editor);
  editor.querySelector("input").focus();
  editor.querySelector("input").select();
});
document.addEventListener("click", async function (event) {
  const cancel = event.target.closest("[data-cancel-instance-name]");
  if (cancel) {
    const editor = cancel.closest(".nickname-editor"),
      selector =
        editor.dataset.editTarget === "provider"
          ? "[data-provider-name-instance]"
          : "[data-nickname-instance]";
    editor.parentElement.querySelector(selector).hidden = false;
    editor.remove();
    return;
  }
  const button = event.target.closest("[data-confirm-instance-name]");
  if (!button) return;
  const editor = button.closest(".nickname-editor"),
    providerSide = editor.dataset.editTarget === "provider";
  const instance = instances.find(function (item) {
    return String(item.id) === String(editor.dataset.instanceId);
  });
  if (!instance) return;
  const name = editor.querySelector("input").value.trim(),
    providerName = instance.providerNameOriginal || instance.name;
  if (name === (providerSide ? providerName : instance.name)) {
    await loadInstances();
    return;
  }
  setButtonBusy(button, "保存中…");
  try {
    if (providerSide) {
      const syncNickname = confirm(
        (instance.providerRenameWarning
          ? instance.providerRenameWarning + "\n\n"
          : "") +
          "是否同时把平台昵称也修改为“" +
          name +
          "”？",
      );
      await request(
        "/api/instances/" + encodeURIComponent(instance.id) + "/provider-name",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: instance.provider, name }),
        },
      );
      await request(
        "/api/instances/" + encodeURIComponent(instance.id) + "/name",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider: instance.provider,
            name: syncNickname ? name : instance.name,
          }),
        },
      );
    } else {
      const syncProvider =
        instance.providerRenameSupported &&
        confirm(
          (instance.providerRenameWarning
            ? instance.providerRenameWarning + "\n\n"
            : "") +
            "是否同时把供应商侧名称也修改为“" +
            name +
            "”？",
        );
      if (syncProvider)
        await request(
          "/api/instances/" +
            encodeURIComponent(instance.id) +
            "/provider-name",
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ provider: instance.provider, name }),
          },
        );
      await request(
        "/api/instances/" + encodeURIComponent(instance.id) + "/name",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: instance.provider, name }),
        },
      );
    }
    await loadInstances();
    toast(providerSide ? "供应商侧名称已更新" : "实例昵称已更新");
  } catch (error) {
    toast("修改名称失败：" + error.message);
  } finally {
    clearButtonBusy(button);
  }
});
async function request(url, options) {
  const r = await fetch(url, options),
    data = await r.json();
  if (!r.ok) {
    const error = new Error(data.error || `HTTP ${r.status}`);
    Object.assign(error, {
      status: r.status,
      code: data.code,
      provider: data.provider,
    });
    throw error;
  }
  return data;
}
async function loadSignedInUser() {
  try {
    const { user, mode } = await request("/api/auth/me"),
      container = document.querySelector(".sidefoot .user"),
      sidefoot = container?.closest(".sidefoot");
    if (!container || !user) return;
    if (mode === "local") {
      sidefoot.hidden = true;
      return;
    }
    sidefoot.hidden = false;
    const initials = String(user.displayName || user.email || "U")
      .trim()
      .slice(0, 2)
      .toUpperCase();
    container.innerHTML = `<span>${esc(initials)}</span><div>${esc(user.displayName || "用户")}<small>${esc(user.email)}</small></div><button id="logoutUser" type="button">退出</button>`;
    const logout = $("#logoutUser");
    if (logout)
      logout.onclick = async () => {
        await request("/api/auth/logout", { method: "POST" });
        location.replace("/auth.html");
      };
  } catch (error) {
    if (error.status === 401) location.replace("/auth.html");
  }
}
loadSignedInUser();
async function loadPlatformSettings() {
  const mode = $("#controlPlaneMode"),
    statusText = $("#controlPlaneStatus"),
    input = $("#controlPlaneBaseUrl"),
    button = $("#saveControlPlane");
  try {
    const status = await request("/api/config/status"),
      editable = status.canConfigureControlPlane;
    input.value = status.controlPlane?.baseUrl || "";
    const selected = document.querySelector(
      `input[name="telemetryMode"][value="${status.telemetryMode || "ssh"}"]`,
    );
    if (selected) selected.checked = true;
    document
      .querySelectorAll('input[name="telemetryMode"]')
      .forEach((item) => (item.disabled = !editable));
    input.disabled = !editable;
    button.hidden = !editable;
    updateTelemetryModeFields();
    if (status.telemetryMode === "named-tunnel")
      await loadCloudflareConnectionSettings();
    mode.className = "pill ready";
    mode.textContent =
      status.telemetryMode === "named-tunnel" ? "Named Tunnel" : "SSH 长连接";
    statusText.className = "platform-settings-status configured";
    statusText.textContent =
      status.telemetryMode === "named-tunnel"
        ? `实例将向 ${status.controlPlane?.baseUrl || "尚未配置的固定 URL"} 主动上报。`
        : "平台将通过托管 SSH 长连接采集 GPU 状态。";
    await loadCliPathSettings();
    await loadLocalToolsSettings();
  } catch (error) {
    statusText.textContent = "读取失败：" + error.message;
  }
}
function localToolSource(source) {
  return source === "application"
    ? "软件内"
    : source === "system"
      ? "电脑（由 Fast GPU 管理）"
      : source === "existing"
        ? "电脑"
        : "未安装";
}
async function loadLocalToolsSettings() {
  const card = $("#localToolsCard"),
    list = $("#localToolsList");
  if (!card || !list) return;
  try {
    const status = await request("/api/client/capabilities"),
      local = status.mode === "local";
    card.classList.toggle("unavailable", !local);
    const tools = [
      {
        name: "SSH",
        description: "远程终端与连接检查",
        installed: status.ssh,
        source: status.sshSource,
        install: "ssh",
      },
      {
        name: "SCP",
        description: "上传文件到实例（随 OpenSSH 安装）",
        installed: status.scp,
        source: status.scpSource,
        install: "ssh",
      },
      {
        name: "rsync",
        description: "目录增量同步",
        installed: status.rsync,
        source: status.rsyncSource,
        install: "rsync",
      },
    ];
    list.innerHTML = tools
      .map(
        (tool) =>
          '<div class="local-tool-row"><div><strong>' +
          tool.name +
          "</strong><small>" +
          tool.description +
          '</small></div><span class="local-tool-state ' +
          (tool.installed ? "ready" : "missing") +
          '">' +
          (local
            ? tool.installed
              ? "已安装 · " + localToolSource(tool.source)
              : "未安装"
            : "仅本地客户端可检测") +
          "</span>" +
          (!local || tool.installed
            ? ""
            : '<div class="local-tool-actions"><button type="button" data-settings-install="' +
              tool.install +
              '" data-scope="system">安装到电脑</button><button type="button" data-settings-install="' +
              tool.install +
              '" data-scope="application">安装到软件内</button></div>') +
          "</div>",
      )
      .join("");
  } catch (error) {
    list.innerHTML =
      '<div class="platform-settings-status missing">本地工具状态读取失败：' +
      esc(error.message) +
      "</div>";
  }
}
async function loadCliPathSettings() {
  const card = $("#cliPathCard"),
    text = $("#cliPathStatus"),
    button = $("#registerCliPath");
  if (!card) return;
  const state = (await request("/api/client/capabilities")).cliPath;
  card.hidden = !state?.available;
  if (!state?.available) return;
  text.textContent = state.registered
    ? `已注册 · ${state.directory}`
    : `尚未注册 · ${state.directory}`;
  button.disabled = state.registered;
  button.textContent = state.registered ? "已注册" : "注册到 PATH";
}
$("#registerCliPath").onclick = async function () {
  setButtonBusy(this, "注册中…");
  try {
    await request("/api/client/path/register", { method: "POST" });
    await loadCliPathSettings();
    toast("已注册到用户 PATH；请新开一个终端运行 fast-gpu");
  } catch (error) {
    toast("PATH 注册失败：" + error.message);
  } finally {
    clearButtonBusy(this);
  }
};
function updateTelemetryModeFields() {
  const selected =
    document.querySelector('input[name="telemetryMode"]:checked')?.value ||
    "ssh";
  $("#namedTunnelFields").hidden = selected !== "named-tunnel";
  $("#controlPlaneBaseUrl").required = selected === "named-tunnel";
  if (selected === "named-tunnel") void loadCloudflareConnectionSettings();
}
document
  .querySelectorAll('input[name="telemetryMode"]')
  .forEach((item) => (item.onchange = updateTelemetryModeFields));
$("#openCloudflareNamedTunnel").onclick = () =>
  window.open(
    "https://one.dash.cloudflare.com/?to=/:account/networks/connectors/cloudflare-tunnels",
    "_blank",
    "noopener",
  );
$("#showNamedTunnelHelp").onclick = () =>
  $("#namedTunnelHelpDialog").showModal();
async function loadCloudflareConnectionSettings() {
  const text = $("#cloudflareLoginStatus"),
    install = $("#installCloudflared"),
    login = $("#loginCloudflare");
  if (!text || $("#namedTunnelFields").hidden) return;
  try {
    const status = await request("/api/client/cloudflare/status");
    install.hidden = status.installed;
    login.hidden = !status.installed || status.loggedIn;
    text.className =
      "platform-settings-status " +
      (status.loggedIn ? "configured" : "missing");
    if (!status.installed)
      text.textContent = "尚未安装 cloudflared；请先安装再登录 Cloudflare。";
    else if (!status.loggedIn)
      text.textContent =
        status.login?.state === "waiting_browser"
          ? "等待浏览器完成 Cloudflare 授权…"
          : status.login?.error
            ? "Cloudflare 尚未登录：" + status.login.error
            : "Cloudflare 尚未登录。";
    else
      text.textContent = `Cloudflare 已登录${status.certificateDirectory ? " · 凭据目录：" + status.certificateDirectory : ""}`;
    if (
      status.login?.state === "waiting_browser" &&
      status.login?.url &&
      !login.dataset.openedUrl
    ) {
      login.dataset.openedUrl = status.login.url;
      window.open(status.login.url, "_blank", "noopener");
    }
    if (status.login?.state === "waiting_browser")
      setTimeout(loadCloudflareConnectionSettings, 1200);
  } catch (error) {
    text.className = "platform-settings-status missing";
    text.textContent = "Cloudflare 状态检测失败：" + error.message;
  }
}
$("#installCloudflared").onclick = async function () {
  setButtonBusy(this, "安装中…");
  try {
    await request("/api/client/cloudflare/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "application" }),
    });
    toast("cloudflared 已安装");
    await loadCloudflareConnectionSettings();
  } catch (error) {
    toast("cloudflared 安装失败：" + error.message);
  } finally {
    clearButtonBusy(this);
  }
};
$("#loginCloudflare").onclick = async function () {
  delete this.dataset.openedUrl;
  setButtonBusy(this, "等待登录…");
  try {
    await request("/api/client/cloudflare/login", { method: "POST" });
    toast("请在浏览器中完成 Cloudflare 授权");
    await loadCloudflareConnectionSettings();
  } catch (error) {
    toast("Cloudflare 登录启动失败：" + error.message);
  } finally {
    clearButtonBusy(this);
  }
};
$("#controlPlaneForm").onsubmit = async (event) => {
  event.preventDefault();
  const button = $("#saveControlPlane");
  setButtonBusy(button, "配置并测试 Tunnel…");
  try {
    const telemetryMode =
      document.querySelector('input[name="telemetryMode"]:checked')?.value ||
      "ssh";
    await request("/api/config/control-plane", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        telemetryMode,
        baseUrl:
          telemetryMode === "named-tunnel"
            ? $("#controlPlaneBaseUrl").value
            : "",
      }),
    });
    await loadPlatformSettings();
    await loadProviderConfig();
    toast(
      telemetryMode === "ssh"
        ? "已切换到 SSH 长连接遥测"
        : "Named Tunnel 公网回探通过，固定 URL 已保存",
    );
    setTimeout(
      () =>
        loadInstances().catch((error) =>
          console.warn("读取 BASE_URL 更新状态失败", error),
        ),
      1500,
    );
  } catch (error) {
    toast(error.message);
  } finally {
    clearButtonBusy(button);
  }
};
async function setupControlPlaneConfiguration() {
  try {
    await loadPlatformSettings();
  } catch (error) {
    toast("读取遥测配置失败：" + error.message);
  }
}
setupControlPlaneConfiguration();
function downloadPrivateKey(filename, privateKey) {
  const url = URL.createObjectURL(
      new Blob([privateKey], { type: "application/x-pem-file" }),
    ),
    link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function base64Bytes(value) {
  const binary = atob(value),
    bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function bytesBase64(value) {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
async function secureKeyDownload(url, filename) {
  if (!crypto?.subtle) throw Error("当前浏览器不支持安全密钥下载");
  const pair = await crypto.subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["encrypt", "decrypt"],
    ),
    publicKey = bytesBase64(
      await crypto.subtle.exportKey("spki", pair.publicKey),
    );
  const envelope = await request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicKey }),
  });
  const aesRaw = await crypto.subtle.decrypt(
      { name: "RSA-OAEP" },
      pair.privateKey,
      base64Bytes(envelope.wrappedKey),
    ),
    aesKey = await crypto.subtle.importKey(
      "raw",
      aesRaw,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
  const ciphertext = base64Bytes(envelope.ciphertext),
    tag = base64Bytes(envelope.tag),
    combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);
  const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64Bytes(envelope.iv), tagLength: 128 },
      aesKey,
      combined,
    ),
    downloadUrl = URL.createObjectURL(
      new Blob([plaintext], {
        type: envelope.contentType || "application/octet-stream",
      }),
    ),
    link = document.createElement("a");
  link.href = downloadUrl;
  link.download = envelope.filename || filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
}
function go(view) {
  $$(".view").forEach((x) => x.classList.toggle("active", x.id === view));
  $$("nav button").forEach((x) =>
    x.classList.toggle("active", x.dataset.view === view),
  );
  $("#pageTitle").textContent = pages[view][0];
  $("#pageSub").textContent = pages[view][1];
  $("#instanceTotalSpend").hidden = view !== "instances";
  $("#instanceAccessInfo").hidden = view !== "instances";
  saveUiState({ view });
  updateProviderConnectionSummary(view);
  if (view === "funds")
    loadProviderConfig().then(() => showBillingProvider(activeBillingProvider));
  if (view === "storage") {
    loadS3Config();
  } else {
    setPageTitleAlert(null);
  }
  if (view === "settings") loadPlatformSettings();
}
$$("nav button").forEach((b) => (b.onclick = () => go(b.dataset.view)));
$$("[data-go-market]").forEach((b) => (b.onclick = () => go("market")));
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
  const incomplete = providerConfigStatus.filter(
    (item) => item.configured && !item.provisioningReady,
  );
  if (disconnected.length) {
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
  $("#providerKeyStatus").textContent = keys.length
    ? `已添加 ${keys.length} 个 Key`
    : "尚未配置 API Key";
  $("#providerKeyList").innerHTML = keys
    .map(
      (key) =>
        `<div class="provider-key-item ${key.active ? "active" : ""}"><span><strong class="provider-key-label">${esc(key.label || "未命名 Key")}</strong><code>•••• ${esc(key.keySuffix)}</code><small>${key.active ? "当前使用" : "备用"} · ${new Date(key.createdAt).toLocaleDateString()}</small></span><div>${key.active ? "<b>使用中</b>" : `<button type="button" data-activate-provider-key="${esc(key.id)}">切换使用</button>`}<button type="button" data-rename-provider-key="${esc(key.id)}">重命名</button><button type="button" data-download-provider-key="${esc(key.id)}">安全下载</button><button type="button" data-delete-provider-key="${esc(key.id)}">删除</button></div></div>`,
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
          !confirm(
            `确定删除末四位 ${button.closest(".provider-key-item").querySelector("code").textContent.slice(-4)} 的 Key？`,
          )
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
      (button.onclick = async () => {
        const item = button.closest(".provider-key-item");
        const current = item.querySelector(".provider-key-label").textContent.trim();
        const label = prompt("为这个 Key 起个名字（备注）：", current === "未命名 Key" ? "" : current);
        if (label === null) return;
        button.disabled = true;
        try {
          await request(
            `/api/providers/${encodeURIComponent(provider.id)}/api-keys/${encodeURIComponent(button.dataset.renameProviderKey)}/rename`,
            { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: label.trim() }) },
          );
          await loadProviderConfig();
          await showBillingProvider(provider.id);
          toast(label.trim() ? `已更新名称为「${label.trim()}」` : "已清空 Key 名称");
        } catch (error) {
          button.disabled = false;
          toast("重命名失败：" + error.message);
        }
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
        openProviderWindow(provider.url, "gpu-fleet-provider-balance");
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
          : keyCount
            ? keyCount + " 个 Key"
            : status.provisioningReady
              ? "可部署"
              : "需要 Key";
      return `<button class="${x.id === provider.id ? "active" : ""}" data-billing-provider="${esc(x.id)}"><strong>${esc(x.name)}</strong><small>${esc(x.currency)} · ${stateText}</small></button>`;
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
      ? "保存 API Key 后，平台会自动读取 Environment、SSH Keypair 和系统镜像。"
      : "余额不足时可先充值；Key 缺失或需要更换时，可打开官方页面获取并粘贴到下方。";
  billingButton.disabled = false;
  billingButton.textContent = "打开充值页面 ↗";
  keyButton.disabled = false;
  keyButton.textContent = "获取 API Key ↗";
  $("#providerApiKey").value = "";
  renderProviderKeys(provider, status);
  billingButton.onclick = () =>
    openProviderWindow(provider.url, "gpu-fleet-provider-billing");
  keyButton.onclick = () =>
    openProviderWindow(
      status?.keyUrl || provider.keyUrl,
      "gpu-fleet-provider-api-key",
    );
  await renderProviderBalance(provider, status, isCurrent);
  if (!isCurrent()) return;
  $("#hyperstackConfigForm").hidden =
    provider.id !== "hyperstack" || !status?.configured;
  $("#openAutoDLImageImport").hidden =
    provider.id !== "autodl" || !status?.configured;
  if (provider.id === "hyperstack" && status?.configured) {
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
    imageUserLabel = document.createElement("label"),
    tailscaleLabel = document.createElement("label"),
    tailscaleStatus = document.createElement("small");
  imageUserLabel.innerHTML =
    '镜像 SSH 用户 <span class="default-value-tag">默认值，可选修改</span><input id="hyperstackImageUser" autocomplete="username" placeholder="例如 ubuntu、debian">';
  tailscaleLabel.innerHTML =
    'Tailscale Auth Key<input id="hyperstackTailscaleAuthKey" type="password" autocomplete="new-password" placeholder="粘贴 tskey-auth-…">';
  const tailscaleInput = tailscaleLabel.querySelector("input"),
    tailscaleTitle = document.createElement("span"),
    tailscaleLink = document.createElement("button"),
    tailscaleHint = document.createElement("small"),
    tailscaleMeta = document.createElement("div");
  tailscaleTitle.className = "hyperstack-field-title";
  tailscaleTitle.textContent = "Tailscale Auth Key";
  tailscaleLink.type = "button";
  tailscaleLink.className = "field-link-button";
  tailscaleLink.textContent = "申请 Key ↗";
  tailscaleLink.onclick = () =>
    openProviderWindow(
      "https://console.tailscale.com/admin/settings/keys",
      "gpu-fleet-tailscale-auth-key",
    );
  tailscaleLabel.firstChild.remove();
  tailscaleTitle.append(tailscaleLink);
  tailscaleLabel.insertBefore(tailscaleTitle, tailscaleInput);
  tailscaleHint.className = "tailscale-auth-key-hint";
  tailscaleHint.innerHTML =
    '<strong>请选择 Auth keys → Generate auth key…</strong><span>需要的是设备认证密钥（以 <code>tskey-auth-</code> 开头），不是下方的 API access token。创建多台 VM 时必须开启 Reusable。</span>';
  tailscaleLabel.append(tailscaleHint);
  tailscaleMeta.className = "tailscale-key-meta";
  tailscaleMeta.innerHTML =
    '<span class="tailscale-reusable-confirm"><input id="hyperstackTailscaleReusable" type="checkbox">我已在 Tailscale 开启 Reusable</span><span class="tailscale-expiry-field"><span>Key 到期日期</span><input id="hyperstackTailscaleExpiresAt" type="date"></span>';
  tailscaleLabel.append(tailscaleMeta);
  tailscaleStatus.id = "hyperstackTailscaleKeyStatus";
  tailscaleStatus.textContent = "尚未配置 Tailscale Auth Key";
  submit.before(imageUserLabel, tailscaleLabel, tailscaleStatus);
  const obsoleteCidr = $("#hyperstackAgentCidr");
  if (obsoleteCidr?.parentElement) obsoleteCidr.parentElement.hidden = true;
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
    keypair.innerHTML = (data.keypairs || [])
      .map(
        (x) =>
          `<option value="${esc(x.name)}" data-environment="${esc(x.environmentName || "")}">${esc(x.name)}${x.environmentName ? " · " + esc(x.environmentName) : ""}</option>`,
      )
      .join("");
    image.innerHTML = (data.images || [])
      .map((x) => `<option value="${esc(x.name)}">${esc(x.name)}</option>`)
      .join("");
    if (saved.environment) environment.value = saved.environment;
    if (saved.keyName) keypair.value = saved.keyName;
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
    const tailscaleAuthKeyInput = $("#hyperstackTailscaleAuthKey"),
      savedTailscaleMask = "••••••••••••";
    tailscaleAuthKeyInput.value = saved.tailscaleAuthKeyConfigured
      ? savedTailscaleMask
      : "";
    tailscaleAuthKeyInput.dataset.savedMask = saved.tailscaleAuthKeyConfigured
      ? "true"
      : "";
    tailscaleAuthKeyInput.onfocus = () => {
      if (tailscaleAuthKeyInput.dataset.savedMask === "true") {
        tailscaleAuthKeyInput.value = "";
        tailscaleAuthKeyInput.dataset.savedMask = "";
      }
    };
    tailscaleAuthKeyInput.onblur = () => {
      if (!tailscaleAuthKeyInput.value && saved.tailscaleAuthKeyConfigured) {
        tailscaleAuthKeyInput.value = savedTailscaleMask;
        tailscaleAuthKeyInput.dataset.savedMask = "true";
      }
    };
    $("#hyperstackTailscaleReusable").checked = false;
    $("#hyperstackTailscaleExpiresAt").value =
      saved.tailscaleAuthKeyExpiresAt || "";
    $("#hyperstackTailscaleKeyStatus").textContent =
      saved.tailscaleAuthKeyStatus === "expired"
        ? `Tailscale Auth Key 已于 ${saved.tailscaleAuthKeyExpiresAt} 过期，请更换`
        : saved.tailscaleAuthKeyStatus === "expiring"
          ? `Tailscale Auth Key 将于 ${saved.tailscaleAuthKeyExpiresAt} 过期（剩余 ${saved.tailscaleAuthKeyDaysRemaining} 天）`
          : saved.tailscaleAuthKeyConfigured
            ? `已加密保存 Tailscale Auth Key${saved.tailscaleAuthKeyExpiresAt ? `；有效期至 ${saved.tailscaleAuthKeyExpiresAt}` : "；到期时间未知"}`
            : "尚未配置 Tailscale Auth Key";
    $("#hyperstackTailscaleKeyStatus").dataset.state =
      saved.tailscaleAuthKeyStatus || "";
    const filterKeypairs = () => {
      const selected = environment.value;
      [...keypair.options].forEach(
        (option) =>
          (option.hidden = Boolean(
            option.dataset.environment &&
            option.dataset.environment !== selected,
          )),
      );
      if (keypair.selectedOptions[0]?.hidden)
        keypair.value =
          [...keypair.options].find((option) => !option.hidden)?.value || "";
    };
    environment.onchange = filterKeypairs;
    image.onchange = () => {
      $("#hyperstackImageUser").value = inferHyperstackImageUser();
    };
    filterKeypairs();
    status.textContent = `已读取 ${data.environments?.length || 0} 个 Environment、${data.keypairs?.length || 0} 个 Keypair、${data.images?.length || 0} 个镜像`;
  } catch (error) {
    status.textContent = "资源读取失败：" + error.message;
    toast(status.textContent);
  } finally {
    for (const id of [
      "hyperstackEnvironment",
      "hyperstackKeypair",
      "hyperstackImage",
    ])
      $("#" + id).disabled = false;
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
}
$("#createHyperstackKeypair").onclick = async () => {
  const button = $("#createHyperstackKeypair"),
    environment = $("#hyperstackEnvironment").value;
  if (!environment) return toast("请先选择 Environment");
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
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await request("/api/providers/hyperstack/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        environment: $("#hyperstackEnvironment").value,
        keyName: $("#hyperstackKeypair").value,
        imageName: $("#hyperstackImage").value,
        imageUser: $("#hyperstackImageUser").value,
        tailscaleAuthKey:
          $("#hyperstackTailscaleAuthKey").dataset.savedMask === "true"
            ? ""
            : $("#hyperstackTailscaleAuthKey").value,
        tailscaleAuthKeyExpiresAt: $("#hyperstackTailscaleExpiresAt").value,
        tailscaleReusableConfirmed: $("#hyperstackTailscaleReusable").checked,
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
function updateImageVersionHint() {
  const image = runtimeImages.find(
      (item) => item.id === $("#imageVersion").value,
    ),
    modeSelect = $("#imageBuildMode");
  if (!image) return;
  const previous = modeSelect.value;
  modeSelect.innerHTML = image.availableBuildModes
    .map(
      (mode) =>
        `<option value="${esc(mode)}">${esc(image.buildModes[mode].label)}</option>`,
    )
    .join("");
  modeSelect.value = image.availableBuildModes.includes(previous)
    ? previous
    : image.buildMode;
  const details = image.buildModes[modeSelect.value];
  $("#imageVersionHint").textContent =
    `${details.description} Codex 与 Claude Code 仍会在开机时安装最新版。`;
}
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
  const imageSelect = $("#imageVersion"),
    modeSelect = $("#imageBuildMode");
  imageSelect.disabled = true;
  modeSelect.disabled = true;
  $("#imageBuildModeWrap").style.display =
    selected.provider === "autodl" ? "none" : "grid";
  imageSelect.innerHTML = "<option>正在加载镜像…</option>";
  $("#imageVersionHint").textContent =
    selected.provider === "autodl"
      ? "可选择账号镜像（含已共享到账号的社区镜像）或官方基础镜像。"
      : "正在读取镜像构建方式…";
  $("#launchDialog").showModal();
  try {
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
    } else {
      if (!runtimeImages.length)
        ({ images: runtimeImages } = await request("/api/runtime-images"));
      imageSelect.innerHTML = runtimeImages
        .map(
          (image) =>
            `<option value="${esc(image.id)}" ${image.recommended ? "selected" : ""}>${esc(image.label)}</option>`,
        )
        .join("");
      imageSelect.onchange = updateImageVersionHint;
      modeSelect.onchange = updateImageVersionHint;
      updateImageVersionHint();
      modeSelect.disabled = false;
    }
    imageSelect.disabled = false;
  } catch (error) {
    imageSelect.innerHTML = '<option value="">镜像加载失败</option>';
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
  if ($("#imageVersion").disabled || !$("#imageVersion").value)
    return toast("请先选择可用镜像版本");
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
        imageBuildMode:
          selected.provider === "autodl"
            ? undefined
            : $("#imageBuildMode").value,
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
    if (error.code === "autodl_no_compatible_host") {
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
function formatVram(used, total) {
  const gb = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    const result = n / 1024;
    return n > 0 && result < 0.1 ? "<0.1" : result.toFixed(1);
  };
  return `${gb(used)} / ${gb(total)} GB`;
}
function countBandwidthResults(value) {
  let count = 0;
  const visit = (x) => {
    if (x && typeof x === "object") Object.values(x).forEach(visit);
    else if (x !== undefined && x !== null) count++;
  };
  visit(value);
  return count;
}
function metricsMarkup(m) {
  if (!m?.gpus?.length)
    return '<span class="telemetry-wait">等待实例上报检测数据…</span>';
  return `<table class="gpu-metrics-table"><thead><tr><th>GPU</th><th>利用率</th><th>显存</th><th>温度</th><th>功耗</th></tr></thead><tbody>${m.gpus.map((g) => `<tr><td title="${esc(g.name)}"><strong>GPU ${g.index}</strong><small>${esc(g.name)}</small></td><td>${g.util ?? "—"}%</td><td>${formatVram(g.memoryUsed, g.memoryTotal)}</td><td>${g.temperature ?? "—"}°C</td><td>${g.power ?? "—"} W</td></tr>`).join("")}</tbody></table>`;
}
function instanceMetricsMarkup(i) {
  return i.status === "stopped"
    ? '<span class="telemetry-wait">实例已停止，GPU 遥测已暂停</span>'
    : metricsMarkup(telemetryCache.get(String(i.id)));
}
function updateInstanceBadge() {
  const running = instances.filter(
      (i) => i.providerState === "running" && !i.lifecycleAction,
    ).length,
    badge = $("#instanceBadge");
  badge.textContent = `${running}/${instances.length}`;
  badge.title = `${running} 个运行中，共 ${instances.length} 个实例`;
  badge.setAttribute("aria-label", badge.title);
}
function updateInstanceEmptyState() {
  const empty = $("#emptyInstances");
  empty.style.display = instances.length ? "none" : "block";
  if (instances.length) return;
  empty.querySelector("h2").textContent = "还没有实例";
  empty.querySelector("p").textContent =
    "从算力市场选择配置，一键启动你的第一个 GPU 实例。";
  empty.querySelector("button").hidden = false;
}
function syncTelemetryStreams() {
  const active = new Set(
    instances
      .filter((i) => i.status === "running" || i.status === "provisioning")
      .map((i) => String(i.id)),
  );
  for (const [id, stream] of streams)
    if (!active.has(String(id))) {
      stream.close();
      streams.delete(id);
      telemetryCache.delete(String(id));
    }
}
function telemetryProblemMarkup(message) {
  return `<span class="telemetry-message"><strong>GPU 遥测异常</strong><small>${esc(message)}</small></span>`;
}
async function loadInstances() {
  ({ instances } = await request("/api/instances"));
  syncTelemetryStreams();
  updateInstanceBadge();
  updateInstanceTotalSpend();
  updateInstanceEmptyState();
  $("#instanceGrid").innerHTML = instances
    .map(
      (i) =>
        `<article class="instance"><div class="instance-top"><div><strong>${i.name}</strong><div class="sub">${i.provider} · ${i.id}</div>${i.runtime?.phaseLabel ? `<div class="provision-phase">${esc(i.runtime.phaseLabel)}${i.runtime.message ? ` · ${esc(i.runtime.message)}` : ""}</div>` : ""}</div><span class="pill ${i.status}">${{ running: "运行中", provisioning: "初始化中", stopped: "已停止", failed: "初始化失败" }[i.status] || i.status}</span></div><dl><div><dt>GPU</dt><dd>${i.gpuCount}× ${i.gpu}</dd></div><div><dt>环境</dt><dd id="env-${i.id}">${esc(i.cudaProfile || "CUDA 13")}</dd></div><div><dt>费用</dt><dd>${formatPrice(i, "价格未知")}</dd></div></dl><div class="metrics" id="m-${i.id}">${instanceMetricsMarkup(i)}</div><div class="instance-actions"><span class="sub">${i.ip || ""}</span><div><button data-action="${i.status === "stopped" ? "start" : "stop"}" data-id="${i.id}">${i.status === "stopped" ? "启动" : "停止"}</button> <button data-action="delete" data-id="${i.id}">删除</button></div></div></article>`,
    )
    .join("");
  $$("[data-action]").forEach(
    (b) => (b.onclick = () => instanceAction(b.dataset.id, b.dataset.action)),
  );
  instances
    .filter((i) => i.status === "running" || i.status === "provisioning")
    .forEach(connectTelemetry);
}
function showTransitionStates() {
  for (const [id, pending] of pendingInstanceActions) {
    const i = instances.find((x) => String(x.id) === String(id));
    if (
      (!i && pending.action === "delete") ||
      (i && pending.action === "stop" && i.status === "stopped") ||
      (i && pending.action === "start" && i.status === "running")
    ) {
      pendingInstanceActions.delete(id);
      continue;
    }
    if (Date.now() - pending.at > 120000) {
      pendingInstanceActions.delete(id);
      continue;
    }
  }
  for (const i of instances) {
    const metrics = $(`#m-${CSS.escape(String(i.id))}`),
      article = metrics?.closest(".instance"),
      warnings = i.runtime?.warnings || [],
      telemetryGraceActive =
        Date.now() < Date.parse(i.telemetryGraceUntil || 0);
    if (
      article &&
      warnings.length &&
      !article.querySelector(".provision-warning")
    ) {
      const warning = document.createElement("div");
      warning.className = "provision-warning";
      warning.innerHTML = `<strong>初始化警告</strong>${warnings.map((w) => `<div><b>${esc(w.component)}</b>：${esc(w.reason)}</div>`).join("")}`;
      article.querySelector(".instance-top")?.after(warning);
    }
    if (
      metrics &&
      i.status === "running" &&
      i.telemetryStatus !== "connected" &&
      !["awaiting_ssh", "uploading_bootstrap"].includes(i.runtime?.phase) &&
      !telemetryGraceActive
    ) {
      const messages = {
        auth_failed: "Agent 实例凭证与平台不一致，请重新创建实例",
        invalid_payload: "Agent 上报的数据格式不正确",
      };
      const message = i.telemetryError?.message
        ? `${i.telemetryError.component || "Agent"}：${i.telemetryError.message}`
        : i.statusError?.message
          ? `Agent 安装失败：${i.statusError.message}`
          : messages[i.telemetryStatus] ||
            (i.telemetryLastSeen
              ? `Agent 上报已中断，最后数据：${new Date(i.telemetryLastSeen).toLocaleString()}`
              : "平台未收到 Agent 的 GPU 遥测上报");
      metrics.classList.add("telemetry-error");
      metrics.innerHTML = telemetryProblemMarkup(message);
    }
    const pending = pendingInstanceActions.get(String(i.id)),
      state =
        pending?.action === "stop"
          ? "stopping"
          : pending?.action === "start"
            ? "starting"
            : pending?.action === "delete"
              ? "terminating"
              : i.status;
    if (!["stopping", "starting", "terminating"].includes(state)) continue;
    const button = $(`[data-action][data-id="${CSS.escape(String(i.id))}"]`),
      pill = button?.closest(".instance")?.querySelector(".pill"),
      label =
        state === "stopping"
          ? "停止中"
          : state === "starting"
            ? "启动中"
            : "删除中";
    if (button) {
      button.disabled = true;
      // “正在停止”已经由右上角状态标识表达；按钮保留“启动”文案，
      // 让用户明确停止完成后的可用动作，同时在过渡期禁用以避免竞态。
      button.textContent = state === "stopping" ? "启动" : `${label}…`;
    }
    if (pill) pill.textContent = label;
  }
}
async function pollInstances() {
  try {
    await loadInstances();
    showTransitionStates();
  } catch (error) {
    console.warn("实例状态自动更新失败", error);
  } finally {
    clearTimeout(instancePollTimer);
    const transitioning =
      pendingInstanceActions.size > 0 ||
      instances.some((i) =>
        [
          "provisioning",
          "stopping",
          "terminating",
          "pending",
          "creating",
          "pulling",
          "starting",
        ].includes(i.status),
      );
    instancePollTimer = setTimeout(pollInstances, transitioning ? 2000 : 15000);
  }
}
function connectTelemetry(i) {
  if (streams.has(i.id)) return;
  const s = new EventSource(`/api/instances/${i.id}/telemetry`);
  s.onmessage = (e) => {
    const m = JSON.parse(e.data),
      el = $(`#m-${i.id}`),
      env = $(`#env-${i.id}`),
      current = instances.find((item) => String(item.id) === String(i.id)),
      telemetryGraceActive =
        Date.now() < Date.parse(current?.telemetryGraceUntil || 0);
    telemetryCache.set(String(i.id), m);
    if (env && m.runtime?.cudaLabel) env.textContent = m.runtime.cudaLabel;
    if (el) {
      const showError = Boolean(m.error?.message) && !telemetryGraceActive;
      el.classList.toggle("telemetry-error", showError);
      el.innerHTML = showError
        ? telemetryProblemMarkup(
            `${m.error.component || "Agent"}：${m.error.message}`,
          )
        : metricsMarkup(m);
      el.title = `最后更新 ${new Date(m.ts || Date.now()).toLocaleTimeString()}`;
    }
  };
  s.addEventListener("error", (event) => {
    const el = $(`#m-${i.id}`);
    if (!el) return;
    const current = instances.find((item) => String(item.id) === String(i.id)),
      telemetryGraceActive =
        Date.now() < Date.parse(current?.telemetryGraceUntil || 0);
    if (current?.status === "provisioning" || telemetryGraceActive) {
      el.classList.remove("telemetry-error");
      el.innerHTML = metricsMarkup();
      return;
    }
    let message = "GPU 遥测连接中断";
    try {
      message = JSON.parse(event.data).error || message;
    } catch {}
    el.classList.add("telemetry-error");
    el.innerHTML = telemetryProblemMarkup(message);
  });
  streams.set(i.id, s);
}
function setButtonBusy(button, label) {
  button = button || window.event?.currentTarget;
  if (!button) return;
  button.dataset.oldText = button.textContent;
  button.disabled = true;
  button.classList.add("busy");
  button.textContent = label;
}
function clearButtonBusy(button) {
  button =
    button ||
    window.event?.currentTarget ||
    document.querySelector("button.busy");
  if (!button) return;
  button.disabled = false;
  button.classList.remove("busy");
  button.textContent = button.dataset.oldText || button.textContent;
}
async function instanceAction(id, action, button) {
  const i = instances.find((x) => x.id === id);
  pendingInstanceActions.set(String(id), { action, at: Date.now() });
  setButtonBusy(
    button,
    action === "delete" ? "删除中…" : action === "stop" ? "停止中…" : "启动中…",
  );
  showTransitionStates();
  try {
    await request(`/api/instances/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: i.provider }),
    });
    if (streams.has(id)) {
      streams.get(id).close();
      streams.delete(id);
    }
    toast(
      action === "delete"
        ? "删除请求已提交"
        : "操作请求已提交，正在等待供应商完成",
    );
    clearTimeout(instancePollTimer);
    await pollInstances();
  } catch (error) {
    pendingInstanceActions.delete(String(id));
    clearButtonBusy(button);
    toast(`操作失败：${error.message}`);
  }
}
const fmt = (n, d = 1) =>
  Number.isFinite(Number(n)) ? Number(n).toFixed(d) : "失败";
function reachabilityMarkup(report) {
  if (!report)
    return '<div class="reachability-empty">尚未从平台测试 SSH 公网入口</div>';
  return (
    '<div class="reachability-summary ' +
    (report.reachable ? "pass" : "fail") +
    '"><strong>' +
    (report.reachable ? "SSH 公网可达" : "SSH 公网不可达") +
    "</strong><span>" +
    esc(report.host) +
    ":" +
    esc(report.port) +
    " · " +
    new Date(report.generatedAt).toLocaleString() +
    '</span></div><div class="reachability-targets"><div class="reachability-target"><span>SSH TCP</span><b class="' +
    (report.reachable ? "pass" : "fail") +
    '">' +
    (report.reachable ? "可连接" : "连接失败") +
    "</b><small>" +
    fmt(report.latencyMs, 0) +
    " ms" +
    (report.error ? " · " + esc(report.error) : "") +
    '</small></div></div><p class="direct-note">由平台控制面直接连接云主机 SSH 端口，不依赖实例 Agent。</p>'
  );
}
function instanceBenchmarkMarkup(instance) {
  const run = instanceBenchmarkRuns.get(String(instance.id)),
    running = run?.status === "running" || run?.status === "stopping",
    state =
      run?.message ||
      (instance.benchmarkReady
        ? "启动前会通过 SSH 实时检查 GPU 利用率。"
        : instance.benchmarkMessage || "测试通道尚未就绪。");
  return `<section class="instance-benchmark"><div class="detail-head"><div><strong>性能测试</strong><small>FP32/TF32/FP16/BF16 算力、带宽、NCCL、磁盘与网络</small></div><div class="instance-benchmark-actions"><select data-benchmark-mode="${esc(instance.id)}" ${running ? "disabled" : ""}><option value="quick">快速测试</option><option value="full">完整测试</option></select><button data-instance-benchmark="${esc(instance.id)}" ${!instance.benchmarkReady || running ? "disabled" : ""}>开始测试</button><button class="danger" data-stop-benchmark="${esc(instance.id)}" ${running ? "" : "disabled"}>${run?.status === "stopping" ? "正在停止…" : "停止测试"}</button></div></div><div class="instance-benchmark-state" id="b-${esc(instance.id)}">${esc(state)}</div>${run?.report ? instanceBenchmarkResultMarkup(run.report) : ""}</section>`;
}
function instanceBenchmarkResultMarkup(report) {
  const gpuCount = report.gpus?.length || 0,
    disk = report.disk,
    internet = report.internet,
    computeResults = (report.compute?.gpus || []).flatMap(
      (gpu) => gpu.results || [],
    ),
    compute = computeResults
      .filter((result) => result.ok)
      .map(
        (result) =>
          `${String(result.precision).toUpperCase()} ${fmt(result.tflops, 1)}`,
      )
      .join(" / ");
  return `<div class="instance-benchmark-result"><span>${gpuCount} 张 GPU</span><span>算力 ${compute || "不可用"} TFLOPS</span><span>磁盘 ${fmt(disk?.readMBps)} / ${fmt(disk?.writeMBps)} MB/s</span><span>网络 ${fmt(internet?.downloadMbps)} / ${fmt(internet?.uploadMbps)} Mbps</span></div>`;
}
function updateInstanceBenchmarkCard(id) {
  const instance = instances.find((item) => String(item.id) === String(id)),
    current = document.querySelector(
      `[data-instance-id="${CSS.escape(String(id))}"] .instance-benchmark`,
    );
  if (instance && current)
    current.outerHTML = instanceBenchmarkMarkup(instance);
  bindInstanceBenchmarkButtons();
}
async function startInstanceBenchmark(id) {
  const instance = instances.find((item) => String(item.id) === String(id));
  if (!instance?.benchmarkReady) return;
  const preflight = await request(
    `/api/instances/${encodeURIComponent(id)}/benchmark-preflight`,
  );
  if (
    preflight.highUtilization &&
    !confirm(
      `当前 GPU 利用率最高为 ${preflight.maxUtilization}%，实例可能正在运行任务。\n\n性能测试会占用 GPU、磁盘和网络资源，仍要继续吗？`,
    )
  )
    return;
  const mode =
    document.querySelector(`[data-benchmark-mode="${CSS.escape(String(id))}"]`)
      ?.value || "quick";
  instanceBenchmarkRuns.set(String(id), {
    status: "running",
    message: "正在通过 SSH 运行性能测试，可随时停止。",
  });
  updateInstanceBenchmarkCard(id);
  try {
    const response = await request(
      `/api/instances/${encodeURIComponent(id)}/benchmark`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      },
    );
    instanceBenchmarkRuns.set(String(id), {
      status: "completed",
      message: "测试完成。",
      report: response.report || response,
    });
    toast(`${instance.name} 性能测试完成`);
  } catch (error) {
    const stopped =
      instanceBenchmarkRuns.get(String(id))?.status === "stopping";
    instanceBenchmarkRuns.set(String(id), {
      status: stopped ? "cancelled" : "failed",
      message: stopped ? "测试已停止。" : `测试失败：${error.message}`,
    });
    if (!stopped) toast(`性能测试失败：${error.message}`);
  }
  updateInstanceBenchmarkCard(id);
}
async function stopInstanceBenchmark(id) {
  const run = instanceBenchmarkRuns.get(String(id));
  if (!run || !["running", "stopping"].includes(run.status)) return;
  run.status = "stopping";
  run.message = "正在停止远端测试进程…";
  updateInstanceBenchmarkCard(id);
  try {
    await request(`/api/instances/${encodeURIComponent(id)}/benchmark`, {
      method: "DELETE",
    });
    run.status = "cancelled";
    run.message = "测试已停止。";
  } catch (error) {
    run.status = "failed";
    run.message = `停止失败：${error.message}`;
  }
  updateInstanceBenchmarkCard(id);
}
function bindInstanceBenchmarkButtons() {
  $$("[data-instance-benchmark]").forEach((button) => {
    button.onclick = () =>
      startInstanceBenchmark(button.dataset.instanceBenchmark).catch((error) =>
        toast(`无法开始测试：${error.message}`),
      );
  });
  $$("[data-stop-benchmark]").forEach((button) => {
    button.onclick = () => stopInstanceBenchmark(button.dataset.stopBenchmark);
  });
}
async function loadReachability(i, force) {
  const id = String(i.id);
  if (reachabilityLoads.has(id) || (!force && reachabilityCache.has(id)))
    return;
  reachabilityLoads.add(id);
  const button = document.querySelector(
    '[data-reachability="' + CSS.escape(id) + '"]',
  );
  if (button && force) setButtonBusy(button, "测试中…");
  try {
    const report = await request(
      "/api/instances/" + encodeURIComponent(id) + "/reachability",
      force ? { method: "POST" } : undefined,
    );
    reachabilityCache.set(id, report);
    const el = document.getElementById("r-" + id);
    if (el) el.innerHTML = reachabilityMarkup(report);
    if (force)
      toast(report.reachable ? "SSH 公网入口可达" : "SSH 公网入口不可达");
  } catch (error) {
    if (force) toast("SSH 公网可达性测试失败：" + error.message);
  } finally {
    reachabilityLoads.delete(id);
    if (button && force) clearButtonBusy(button);
  }
}
let pendingAdoption = null;
async function openInstanceAdoption(button) {
  setButtonBusy(button, "准备中…");
  try {
    pendingAdoption = await request(
      "/api/instances/" +
        encodeURIComponent(button.dataset.adoptInstance) +
        "/adoption/prepare",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: button.dataset.provider }),
      },
    );
    $("#adoptionHost").value = pendingAdoption.host || "";
    $("#adoptionPort").value = pendingAdoption.port || 22;
    $("#adoptionUsername").value = pendingAdoption.username || "root";
    $("#adoptionPublicKey").value = pendingAdoption.publicKey;
    $("#adoptionCommand").value = pendingAdoption.installCommand;
    $("#adoptionAutomaticWrap").hidden = !pendingAdoption.automaticAvailable;
    $("#adoptionSavedWrap").hidden = !pendingAdoption.savedCredentialAvailable;
    const manual = document.querySelector(
      'input[name="adoptionMethod"][value="manual"]',
    );
    manual.checked = true;
    manual.dispatchEvent(new Event("change", { bubbles: true }));
    $("#adoptionStatus").textContent =
      "校验成功后凭据会加密保存；校验失败不会写入数据库。";
    $("#instanceAdoptionDialog").showModal();
  } catch (error) {
    toast("准备接入失败：" + error.message);
  } finally {
    clearButtonBusy(button);
  }
}
document.querySelectorAll('input[name="adoptionMethod"]').forEach(function (input) {
  input.onchange = function () {
    if (!input.checked) return;
    $("#adoptionPrivateKeyWrap").hidden = input.value !== "privateKey";
    $("#adoptionPasswordWrap").hidden = input.value !== "password";
    $("#adoptionManualWrap").hidden = input.value !== "manual";
  };
});
$("#instanceAccessInfo").onclick = function () {
  $("#instanceAccessInfoDialog").showModal();
};
$("#copyAdoptionCommand").onclick = async function () {
  await navigator.clipboard.writeText($("#adoptionCommand").value);
  toast("安装命令已复制");
};
$("#instanceAdoptionForm").onsubmit = async function (event) {
  event.preventDefault();
  if (!pendingAdoption) return;
  const button = $("#verifyInstanceAdoption"),
    method = document.querySelector('input[name="adoptionMethod"]:checked').value;
  setButtonBusy(button, "正在校验…");
  $("#adoptionStatus").textContent = "正在验证 SSH 并安装实例专属密钥…";
  try {
    const result = await request(
      "/api/instances/" +
        encodeURIComponent(pendingAdoption.id) +
        "/adoption/verify",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: pendingAdoption.token,
          method,
          host: $("#adoptionHost").value.trim(),
          port: Number($("#adoptionPort").value),
          username: $("#adoptionUsername").value.trim(),
          privateKey:
            method === "privateKey" ? $("#adoptionPrivateKey").value : undefined,
          password:
            method === "password" ? $("#adoptionPassword").value : undefined,
        }),
      },
    );
    $("#adoptionPrivateKey").value = "";
    $("#adoptionPassword").value = "";
    pendingAdoption = null;
    $("#instanceAdoptionDialog").close();
    toast(result.message || "实例已接入平台");
    await loadInstances();
  } catch (error) {
    $("#adoptionStatus").textContent =
      "校验失败，未保存平台密钥：" + error.message;
  } finally {
    clearButtonBusy(button);
  }
};
loadInstances = async function () {
  ({ instances } = await request("/api/instances"));
  instances.forEach(function (instance) {
    if (instance.accessType !== "tailscale") return;
    instance.ip =
      "无公网 IP · 请到 Tailscale 管理后台获取 100.x.x.x · " +
      (instance.sshCommand ||
        "ssh -i <private-key> " +
          (instance.sshUser || "<image-user>") +
          "@<tailscale-ip>");
  });
  syncTelemetryStreams();
  applyInstancePrices();
  updateInstanceBadge();
  updateInstanceTotalSpend();
  $("#emptyInstances").style.display = instances.length ? "none" : "block";
  $("#instanceGrid").innerHTML = instances
    .map(function (i) {
      const id = esc(i.id),
        expanded = expandedInstances.has(String(i.id)),
        initializationStartedAt =
          i.status === "provisioning" && i.billing?.runningSince
            ? i.billing.runningSince
            : null,
        // 状态展示约定：
        // 1. 绿色状态条只表达供应商实例已经完成镜像准备并进入 running，
        //    不应被平台自己的 SSH、依赖、开发工具或 Agent 初始化状态覆盖。
        // 2. 平台初始化必须作为独立进度文字继续展示，并尽量标明当前阶段；
        //    即使初始化失败，仍需保留供应商真实运行状态，避免用户误判计费状态。
        // 3. 停止、启动、删除等用户操作中的临时状态优先于供应商运行状态。
        //    特别是删除开始后，右上角状态必须一直使用红色 terminating
        //    状态并显示“正在删除”，直到供应商确认实例消失、卡片被移除；
        //    不得因供应商最后一次仍返回 running 而重新变绿。
        visualStatus =
          i.lifecycleAction === "delete"
            ? "terminating"
            : i.lifecycleAction === "stop"
              ? "stopping"
              : i.lifecycleAction === "start"
                ? "provisioning"
                : i.providerState === "running"
                  ? "running"
                  : i.status,
        statusLabel = {
          running: "供应商运行中",
          provisioning: "供应商准备中",
          stopped: "已停止",
          stopping: "正在停止",
          terminating: "正在删除",
          failed: "初始化失败",
        }[visualStatus] || visualStatus,
        // 生命周期按钮必须跟右上角的派生状态使用同一口径。供应商进入
        // stopping 后，下一次可执行的动作已经是“启动”，不能因为原始
        // status 还不是 stopped 又渲染成“停止”。
        canStart = ["stopped", "stopping"].includes(visualStatus),
        connectionRecoveryLabel = instanceConnectionRecoveryLabel(i),
        initializationMarkup = ["stopped", "stopping", "terminating"].includes(
          visualStatus,
        )
          ? ""
          : connectionRecoveryLabel
            ? '<div class="provision-phase connection-recovery">' +
              esc(connectionRecoveryLabel) +
              "</div>"
            : initializationStartedAt
              ? '<div class="provision-phase" data-initialization-started-at="' +
                esc(initializationStartedAt) +
                '">' +
                esc(platformProvisioningLabel(i)) +
                " · " +
                esc(formatInitializationElapsed(initializationStartedAt)) +
                "</div>"
              : i.runtime?.phaseLabel
                ? '<div class="provision-phase">' +
                  esc(i.runtime.phaseLabel) +
                  (i.runtime.message ? " · " + esc(i.runtime.message) : "") +
                  "</div>"
                : "";
      return (
        '<article data-instance-id="' +
        id +
        '" class="instance ' +
        (expanded ? "expanded" : "") +
        '"><div class="instance-top"><div><strong>' +
        esc(i.name) +
        '</strong><div class="sub">' +
        esc(i.provider) +
        " · " +
        id +
        "</div>" +
        initializationMarkup +
        '</div><span class="pill ' +
        esc(visualStatus) +
        '">' +
        esc(statusLabel) +
        "</span></div><dl><div><dt>GPU</dt><dd>" +
        esc(i.gpuCount) +
        "× " +
        esc(i.gpu) +
        '</dd></div><div><dt>环境</dt><dd id="env-' +
        id +
        '">' +
        esc(i.cudaProfile || "CUDA 13") +
        '</dd></div><div><dt>费用</dt><dd id="price-' +
        id +
        '">' +
        esc(formatPrice(i, "—")) +
        '<small class="sub">' +
        esc(formatEstimatedCost(i)) +
        '</small></dd></div></dl><div class="instance-panels"><div class="metrics" id="m-' +
        id +
        '">' +
       instanceMetricsMarkup(i) +
       '</div><div class="instance-detail"><div class="instance-detail-inner"><div class="detail-head"><div><strong>外网可达性</strong><small>直连 Hugging Face、Cloudflare、AWS、OpenAI、Google</small></div><button data-reachability="' +
       id +
       '" ' +
       (i.status === "running" ? "" : "disabled") +
       '>手动测试</button></div><div id="r-' +
       id +
       '">' +
       reachabilityMarkup(reachabilityCache.get(String(i.id))) +
       "</div>" +
       instanceBenchmarkMarkup(i) +
       '</div></div></div><div class="instance-actions"><span class="sub">' +
        esc(
          i.accessType === "tailscale"
            ? "无公网 IP · 请到 Tailscale 管理后台获取 100.x.x.x"
            : i.ip || "",
        ) +
        (i.accessType === "tailscale"
          ? "<small><code>" +
            esc(
              i.sshCommand ||
                "ssh -i <private-key> " +
                  (i.sshUser || "<image-user>") +
                  "@<tailscale-ip>",
            ) +
            "</code></small>"
          : "") +
        '</span><div><button data-expand="' +
        id +
        '" aria-expanded="' +
        expanded +
        '">' +
        (expanded ? "收起详情 ↑" : "展开详情 ↓") +
        "</button> " +
        (i.platformAttachable
          ? '<button data-adopt-instance="' +
            id +
            '" data-provider="' +
            esc(i.provider) +
            '">接入平台</button> '
          : "") +
        '<button data-storage-settings="' +
        id +
        '">S3 设置</button> <button data-action="' +
        (canStart ? "start" : "stop") +
        '" data-id="' +
        id +
        '">' +
        (canStart ? "启动" : "停止") +
        '</button> <button data-action="delete" data-id="' +
        id +
        '">删除</button></div></div></article>'
      );
    })
    .join("");
  $$("[data-action]").forEach(function (b) {
    b.onclick = function () {
      instanceAction(b.dataset.id, b.dataset.action, b);
    };
  });
  $$("[data-adopt-instance]").forEach(function (b) {
    b.onclick = function () {
      openInstanceAdoption(b);
    };
  });
  $$("[data-storage-settings]").forEach(function (b) {
    b.onclick = async function () {
      go("storage");
      await loadS3Config();
      $("#existingStorageInstance").value = b.dataset.storageSettings;
      $("#existingStorageInstance").dispatchEvent(new Event("change"));
      $("#existingStorageForm").scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    };
  });
  $$("[data-expand]").forEach(function (b) {
    b.onclick = function () {
      const id = String(b.dataset.expand),
        card = b.closest(".instance"),
        expanded = !card.classList.contains("expanded");
      const updateExpandedState = function () {
        card.classList.toggle("expanded", expanded);
        b.setAttribute("aria-expanded", String(expanded));
        b.textContent = expanded ? "收起详情 ↑" : "展开详情 ↓";
        if (expanded) expandedInstances.add(id);
        else expandedInstances.delete(id);
      };
      card.style.viewTransitionName =
        "instance-card-" + id.replace(/[^a-zA-Z0-9_-]/g, "-");
      if (document.startViewTransition) {
        const grid = card.closest(".instance-grid");
        grid?.classList.add("layout-transitioning");
        const transition = document.startViewTransition(updateExpandedState);
        transition.finished.finally(function () {
          grid?.classList.remove("layout-transitioning");
        });
      } else updateExpandedState();
    };
  });
  $$("[data-reachability]").forEach(function (b) {
    b.onclick = function () {
      const i = instances.find(function (x) {
        return String(x.id) === String(b.dataset.reachability);
      });
      if (i) loadReachability(i, true);
    };
  });
  instances
    .filter(function (i) {
      return i.status === "running" || i.status === "provisioning";
    })
    .forEach(connectTelemetry);
  instances
    .filter(function (i) {
      return i.status === "running";
    })
    .forEach(function (i) {
      loadReachability(i, false);
    });
  updateInitializationTimers();
};
const loadInstancesWithDetails = loadInstances;
loadInstances = async function () {
  await loadInstancesWithDetails();
  updateInstanceEmptyState();
};
$("#refreshInstances").onclick = async function () {
  setButtonBusy(this, "刷新中…");
  try {
    await loadInstances();
    toast("已同步供应商实例");
  } catch (error) {
    toast("刷新实例失败：" + error.message);
  } finally {
    clearButtonBusy(this);
  }
};
let toastTimer;
function toast(s) {
  const element = $("#toast");
  clearTimeout(toastTimer);
  element.textContent = s;
  if (
    typeof element.showPopover === "function" &&
    !element.matches(":popover-open")
  )
    element.showPopover();
  element.classList.add("show");
  toastTimer = setTimeout(() => {
    element.classList.remove("show");
    if (
      typeof element.hidePopover === "function" &&
      element.matches(":popover-open")
    )
      element.hidePopover();
  }, 2200);
}
go(restoreUiState());
Promise.allSettled([loadProviderConfig(), loadOffers(), pollInstances()]);

const sshDialog = document.createElement("dialog");
sshDialog.id = "sshDialog";
sshDialog.innerHTML =
  '<form method="dialog"><button class="close" value="cancel">×</button><span class="eyebrow">SSH & FILES</span><h2>连接与文件传输</h2><p class="ssh-security-note">直接上传会保留文件夹名称和内部结构；需要断点续传时，请在本地运行 rsync。</p><div id="sshConnectionDetails"></div><div class="transfer-panel"><h3>直接 SCP 上传</h3><div id="scpDropZone" class="drop-zone"><input id="scpFile" type="file" multiple><input id="scpFolder" type="file" webkitdirectory multiple><strong>拖拽文件或文件夹到这里</strong><small id="scpFileLabel">尚未选择内容</small><div class="picker-actions"><button type="button" id="pickScpFiles">选择文件</button><button type="button" id="pickScpFolder">选择文件夹</button></div></div><div class="transfer-row transfer-destination"><label class="remote-path-field"><span>云主机目标路径</span><input id="scpRemoteDir" value="/data/uploads" aria-label="云主机目标路径"></label><progress id="scpProgress" value="0" max="100" hidden aria-label="SCP 上传进度"></progress><button type="button" id="uploadScpFile">上传全部</button></div><h3>可断点续传 / 增量同步</h3><div class="transfer-row"><select id="syncTool"><option value="rsync">rsync（推荐）</option><option value="rclone">rclone sync</option></select><label class="remote-path-field"><span>云主机目标路径</span><input id="syncRemoteDir" value="/data/sync" aria-label="云主机目标路径"></label><button type="button" id="copySyncCommand">复制命令</button></div><code id="syncCommand" class="sync-command"></code></div><menu><button value="cancel">关闭</button><button type="button" id="downloadSshKey">下载私钥</button><button type="button" id="openSshTerminal">打开平台终端</button><button type="button" id="copySshCommand" class="primary">复制 SSH 命令</button></menu></form>';
document.body.append(sshDialog);
const showSshDialogModal = sshDialog.showModal.bind(sshDialog);
sshDialog.showModal = function () {
  return document.body.classList.contains("electron-client")
    ? sshDialog.show()
    : showSshDialogModal();
};
sshDialog.querySelector("form").innerHTML =
  '<button class="close" value="cancel">×</button><span class="eyebrow">SSH & FILES</span><h2>SSH 与文件传输</h2><div class="ssh-transfer-columns"><section class="ssh-column"><h3>SSH</h3><p class="ssh-security-note">查看连接信息、复制命令或直接进入平台终端。</p><div id="sshConnectionDetails"></div><div id="sshKeyDownload" class="ssh-key-download" hidden><strong>实例专属私钥</strong><small>通过临时密钥加密下载，仅对当前实例有效。</small><button type="button" id="downloadSshKey">⇩ 下载私钥</button></div></section><section class="files-column"><div class="transfer-heading"><div><h3>传输文件</h3><small>选择一种传输方式</small></div><div class="transfer-tabs" role="tablist"><button type="button" class="active" data-transfer-tab="scp">SCP</button><button type="button" data-transfer-tab="rsync">rsync</button></div></div><div class="transfer-panel active" data-transfer-panel="scp"><p class="transfer-help">可反复添加多个文件或文件夹；展开文件夹可配置上传内容，默认全选。</p><div id="scpDropZone" class="drop-zone"><input id="scpFile" type="file" multiple><input id="scpFolder" type="file" webkitdirectory multiple><strong>拖拽文件或文件夹到这里</strong><small id="scpFileLabel">尚未选择内容</small><div class="picker-actions"><button type="button" id="pickScpFiles">选择文件</button><button type="button" id="pickScpFolder">选择文件夹</button></div></div><div id="scpSelectionTree" class="selection-tree" hidden></div><div class="transfer-row transfer-destination"><label class="remote-path-field"><span>云主机目标路径</span><input id="scpRemoteDir" value="/data/uploads" aria-label="云主机目标路径"></label><progress id="scpProgress" value="0" max="100" hidden aria-label="SCP 上传进度"></progress><button type="button" id="uploadScpFile">上传所选</button></div></div><div class="transfer-panel" data-transfer-panel="rsync"><p class="transfer-help">适合断点续传和增量同步。</p><div class="transfer-row sync-options"><select id="syncTool"><option value="rsync">rsync（推荐）</option><option value="rclone">rclone sync</option></select><label class="remote-path-field"><span>云主机目标路径</span><input id="syncRemoteDir" value="/data/sync" aria-label="云主机目标路径"></label><button type="button" id="copySyncCommand">复制命令</button></div><code id="syncCommand" class="sync-command"></code></div></section></div><menu><button value="cancel">关闭</button><button type="button" id="copySshCommand">复制 SSH 命令</button><button type="button" id="openSshTerminal" class="terminal-primary">打开平台终端</button></menu>';
sshDialog
  .querySelector("form")
  .insertAdjacentHTML(
    "afterbegin",
    '<div class="ssh-window-bar"><strong>SSH 与文件传输</strong><div><button type="button" data-ssh-window="minimize" aria-label="最小化">—</button><button type="button" data-ssh-window="maximize" aria-label="最大化">□</button><button type="button" data-ssh-window="close" aria-label="关闭">×</button></div></div><div id="sshLayerNotice" class="ssh-layer-notice" hidden></div>',
  );
$("#scpRemoteDir").closest(".remote-path-field").insertAdjacentHTML(
  "afterend",
  '<small id="scpRemoteDirHint" class="remote-directory-hint"></small>',
);
$("#syncRemoteDir").closest(".remote-path-field").insertAdjacentHTML(
  "afterend",
  '<small id="syncRemoteDirHint" class="remote-directory-hint"></small>',
);
let sshTerminalWorkingDirectory = "";
function isAbsoluteRemotePath(value) {
  return value.startsWith("/");
}
function isAbsoluteLocalPath(value) {
  return /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/.test(value);
}
function normalizedRemotePath(value) {
  const parts = [];
  for (const part of value.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}
function resolvedUploadDirectory() {
  const value = $("#scpRemoteDir").value.trim();
  if (isAbsoluteRemotePath(value)) return normalizedRemotePath(value);
  if (!terminalDialog?.open) return "";
  if (!sshTerminalWorkingDirectory) return "";
  return normalizedRemotePath(`${sshTerminalWorkingDirectory}/${value}`);
}
function resolvedSyncDirectory() {
  const value = $("#syncRemoteDir").value.trim();
  if (isAbsoluteRemotePath(value)) return normalizedRemotePath(value);
  if (!terminalDialog?.open) return "";
  if (!sshTerminalWorkingDirectory) return "";
  return normalizedRemotePath(`${sshTerminalWorkingDirectory}/${value}`);
}
function updateRemoteDirectoryHint() {
  const input = $("#scpRemoteDir"),
    hint = $("#scpRemoteDirHint"),
    value = input.value.trim();
  if (!value || isAbsoluteRemotePath(value)) {
    hint.className = "remote-directory-hint";
    hint.innerHTML = value
      ? `<span>绝对路径：</span><span>${esc(normalizedRemotePath(value))}</span>`
      : "<span>请输入上传目标路径</span><span>&nbsp;</span>";
    return true;
  }
  if (!terminalDialog?.open) {
    hint.className = "remote-directory-hint invalid";
    hint.textContent =
      "当前不允许相对路径；请打开平台 SSH 终端后，在 SSH 界面中上传。";
    return false;
  }
  if (!sshTerminalWorkingDirectory) {
    hint.className = "remote-directory-hint invalid";
    hint.textContent = "SSH 暂未连接成功，无法评估相对地址。";
    return false;
  }
  hint.className = "remote-directory-hint relative";
  hint.innerHTML = `<span>相对于左侧工作路径：${esc(sshTerminalWorkingDirectory)}</span><span>完整路径：${esc(resolvedUploadDirectory())}</span>`;
  return true;
}
$("#scpRemoteDir").addEventListener("input", updateRemoteDirectoryHint);
updateRemoteDirectoryHint();
function updateSyncDirectoryHint() {
  const hint = $("#syncRemoteDirHint"),
    value = $("#syncRemoteDir").value.trim();
  if (!value || isAbsoluteRemotePath(value)) {
    hint.className = "remote-directory-hint";
    hint.innerHTML = value
      ? `<span>绝对路径：</span><span>${esc(normalizedRemotePath(value))}</span>`
      : "<span>请输入同步目标路径</span><span>&nbsp;</span>";
    return Boolean(value);
  }
  if (!terminalDialog?.open) {
    hint.className = "remote-directory-hint invalid";
    hint.innerHTML =
      "<span>当前不允许相对路径</span><span>请打开平台 SSH 终端后使用相对路径</span>";
    return false;
  }
  if (!sshTerminalWorkingDirectory) {
    hint.className = "remote-directory-hint invalid";
    hint.innerHTML =
      "<span>SSH 暂未连接成功</span><span>无法解析相对工作路径</span>";
    return false;
  }
  hint.className = "remote-directory-hint relative";
  hint.innerHTML = `<span>相对于左侧工作路径：${esc(sshTerminalWorkingDirectory)}</span><span>完整路径：${esc(resolvedSyncDirectory())}</span>`;
  return true;
}
$("#sshConnectionDetails").insertAdjacentHTML(
  "afterend",
  '<div id="sshInstallChoices" class="rsync-install-choices" hidden><strong>未找到 OpenSSH 客户端</strong><button type="button" data-install-ssh="system">安装到电脑<small>通过系统包管理器安装，删除软件后仍保留</small></button><button type="button" data-install-ssh="application">安装到软件内<small>仅供 Fast GPU 使用，删除软件时一起删除</small></button></div>',
);
function sshLayerNotice(message, type = "error") {
  const notice = $("#sshLayerNotice");
  notice.textContent = message;
  notice.className = `ssh-layer-notice ${type}`;
  notice.hidden = !message;
}
const sshWindowBar = $(".ssh-window-bar");
sshWindowBar.onclick = (event) => {
  const action = event.target.closest("[data-ssh-window]")?.dataset.sshWindow;
  if (!action) return;
  if (action === "close") sshDialog.close();
  if (action === "minimize") sshDialog.classList.toggle("ssh-window-minimized");
  if (action === "maximize") {
    sshDialog.classList.remove("ssh-window-minimized");
    sshDialog.classList.toggle("ssh-window-maximized");
    sshDialog.style.left = "";
    sshDialog.style.top = "";
  }
};
let sshDrag = null;
sshWindowBar.onpointerdown = (event) => {
  if (
    event.target.closest("button") ||
    sshDialog.classList.contains("ssh-window-maximized")
  )
    return;
  const rect = sshDialog.getBoundingClientRect();
  sshDrag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  sshWindowBar.setPointerCapture(event.pointerId);
};
sshWindowBar.onpointermove = (event) => {
  if (!sshDrag) return;
  sshDialog.style.left = `${Math.max(0, Math.min(innerWidth - 240, event.clientX - sshDrag.x))}px`;
  sshDialog.style.top = `${Math.max(42, Math.min(innerHeight - 42, event.clientY - sshDrag.y))}px`;
  sshDialog.style.margin = "0";
};
sshWindowBar.onpointerup = () => {
  sshDrag = null;
};
$("#uploadScpFile").addEventListener(
  "click",
  async (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (scpUploadInProgress) {
      scpUploadController?.abort();
      event.currentTarget.disabled = true;
      event.currentTarget.textContent = "正在取消…";
      return;
    }
    const items = selectedScpFiles.filter((item) => item.selected),
      dir = resolvedUploadDirectory(),
      button = $("#uploadScpFile"),
      progress = $("#scpProgress");
    if (!updateRemoteDirectoryHint() || !dir) {
      sshLayerNotice(
        terminalDialog?.open
          ? "SSH 暂未连接成功，无法评估相对地址。"
          : "相对上传路径只有在平台 SSH 终端打开后才能使用。",
      );
      return;
    }
    if (!items.length) {
      sshLayerNotice(
        selectedScpFiles.length
          ? "请至少勾选一个要上传的文件"
          : "请先选择或拖入文件或文件夹",
      );
      return;
    }    if ($("#scpCompress")?.checked) {
      let summary = $("#scpUploadSummary");
      if (!summary) {
        progress.parentElement.insertAdjacentHTML(
          "afterend",
          '<div id="scpUploadSummary" class="ssh-upload-summary"></div>',
        );
        summary = $("#scpUploadSummary");
      }
      scpUploadInProgress = true;
      scpUploadController = new AbortController();
      const uploadController = scpUploadController;
      sshLayerNotice("");
      progress.hidden = false;
      progress.removeAttribute("value");
      setButtonBusy(button, "取消上传");
      button.disabled = false;
      button.classList.add("cancel-upload");
      summary.className = "ssh-upload-summary";
      summary.textContent = "正在压缩并上传 " + items.length + " 个文件…";
      try {
        await uploadScpCompressed(items, dir, uploadController.signal);
        summary.className = "ssh-upload-summary success";
        summary.textContent = "上传完成：已打包上传 " + items.length + " 个文件到 " + dir;
        sshLayerNotice("已压缩上传 " + items.length + " 个文件到 " + dir, "success");
        selectedScpFiles.forEach((item) => {
          if (items.includes(item)) {
            item.selected = false;
            item.uploaded = true;
          }
        });
        showScpSelection();
      } catch (error) {
        if (error.name === "AbortError" || uploadController.signal.aborted) {
          summary.className = "ssh-upload-summary";
          summary.textContent = "上传已取消。";
          sshLayerNotice("上传已取消。");
        } else {
          summary.className = "ssh-upload-summary failure";
          summary.textContent = scpFailureMessage(error);
          sshLayerNotice(scpFailureMessage(error));
        }
      } finally {
        progress.hidden = true;
        progress.value = 0;
        scpUploadInProgress = false;
        scpUploadController = null;
        button.classList.remove("cancel-upload");
        clearButtonBusy(button);
      }
      return;
    }
    let summary = $("#scpUploadSummary");
    if (!summary) {
      progress.parentElement.insertAdjacentHTML(
        "afterend",
        '<div id="scpUploadSummary" class="ssh-upload-summary"></div>',
      );
      summary = $("#scpUploadSummary");
    }
    scpUploadInProgress = true;
    scpUploadController = new AbortController();
    const uploadController = scpUploadController;
    sshLayerNotice("");
    progress.hidden = false;
    progress.value = 0;
    const total = items.reduce((sum, item) => sum + item.file.size, 0);
    let succeeded = 0,
      failed = 0,
      lastError = "",
      failedPaths = [],
      successfulItems = new Set();
    setButtonBusy(button, "取消上传");
    button.disabled = false;
    button.classList.add("cancel-upload");
    summary.className = "ssh-upload-summary";
    summary.textContent = `正在准备 ${items.length} 个文件…`;
    let preparationTimer = null;
    try {
      summary.textContent = `开始上传：成功 0 · 失败 0 · 剩余 ${items.length}`;
      let nextIndex = 0,
        completedBytes = 0;
      const markCompleted = (index) => {
        completedBytes += items[index].file.size;
        progress.value = total
          ? Math.round((completedBytes / total) * 100)
          : 100;
        summary.textContent = `已写入云主机 ${formatBytes(completedBytes)} / ${formatBytes(total)} · 成功 ${succeeded} · 失败 ${failed} · 剩余 ${items.length - succeeded - failed}`;
      };
      const worker = async () => {
        while (true) {
          if (uploadController.signal.aborted) return;
          const index = nextIndex++;
          if (index >= items.length) return;
          const item = items[index];
          try {
            await uploadScpItem(
              item,
              dir,
              () => {},
              () => {},
              uploadController.signal,
            );
            succeeded++;
            successfulItems.add(item);
            markCompleted(index);
          } catch (error) {
            if (error.code === "upload_cancelled") return;
            failed++;
            lastError = scpFailureMessage(error);
            failedPaths.push(item.relativePath);
          }
          summary.textContent = `成功 ${succeeded} · 失败 ${failed} · 剩余 ${items.length - succeeded - failed}`;
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(3, items.length) }, worker),
      );
      selectedScpFiles.forEach((item) => {
        if (successfulItems.has(item)) {
          item.selected = false;
          item.uploaded = true;
        }
      });
      showScpSelection();
      if (uploadController.signal.aborted) {
        const untouched = items.length - succeeded - failed;
        summary.className = "ssh-upload-summary";
        summary.textContent = `上传已取消：成功 ${succeeded} 个，失败 ${failed} 个，待上传 ${untouched} 个。未完成项已保留。`;
        sshLayerNotice("上传已取消，未完成的文件仍保留在选择列表中。");
        return;
      }
      summary.className = `ssh-upload-summary ${failed ? "failure" : "success"}`;
      summary.textContent = `上传完成：成功 ${succeeded} 个，失败 ${failed} 个，未上传 0 个。${failed ? "失败项已保留，可直接重试。" : ""}`;
      if (failed)
        sshLayerNotice(
          `${lastError}\n失败文件：${failedPaths.slice(0, 5).join("、")}${failedPaths.length > 5 ? ` 等 ${failedPaths.length} 个` : ""}`,
        );
      else sshLayerNotice(`已成功上传 ${succeeded} 个文件到 ${dir}`, "success");
    } catch (error) {
      const untouched = items.length - succeeded - failed;
      if (uploadController.signal.aborted) {
        summary.className = "ssh-upload-summary";
        summary.textContent = `上传已取消：成功 ${succeeded} 个，失败 ${failed} 个，待上传 ${untouched} 个。未完成项已保留。`;
        sshLayerNotice("上传已取消，未完成的文件仍保留在选择列表中。");
        return;
      }
      summary.className = "ssh-upload-summary failure";
      summary.textContent = `上传中断：成功 ${succeeded} 个，失败 ${failed} 个，未上传 ${untouched} 个。当前选择已保留，可重试。`;
      sshLayerNotice(scpFailureMessage(error));
    } finally {
      clearInterval(preparationTimer);
      progress.hidden = true;
      progress.value = 0;
      scpUploadInProgress = false;
      scpUploadController = null;
      button.classList.remove("cancel-upload");
      clearButtonBusy(button);
    }
  },
  true,
);
$$("[data-transfer-tab]").forEach(
  (button) =>
    (button.onclick = () => {
      $$("[data-transfer-tab]").forEach((item) =>
        item.classList.toggle("active", item === button),
      );
      $$("[data-transfer-panel]").forEach((panel) =>
        panel.classList.toggle(
          "active",
          panel.dataset.transferPanel === button.dataset.transferTab,
        ),
      );
    }),
);
const scpPickerActions = $("#scpDropZone .picker-actions");
scpPickerActions.insertAdjacentHTML(
  "afterbegin",
  '<div class="unified-picker"><button type="button" id="openScpPicker">选择文件或文件夹</button><div id="scpPickerMenu" class="picker-menu" hidden><button type="button" data-pick-scp="files">选择文件</button><button type="button" data-pick-scp="folder">选择文件夹</button></div></div>',
);
$("#pickScpFiles").hidden = true;
$("#pickScpFolder").hidden = true;
$("#scpProgress").hidden = true;
$("#openScpPicker").onclick = (event) => {
  event.stopPropagation();
  $("#scpPickerMenu").hidden = !$("#scpPickerMenu").hidden;
};
$$("[data-pick-scp]").forEach(
  (button) =>
    (button.onclick = () => {
      $("#scpPickerMenu").hidden = true;
      $(
        button.dataset.pickScp === "files" ? "#pickScpFiles" : "#pickScpFolder",
      ).click();
    }),
);
document.addEventListener("click", (event) => {
  if (!event.target.closest(".unified-picker"))
    $("#scpPickerMenu").hidden = true;
});
$("#scpRemoteDir").closest(".remote-path-field").insertAdjacentHTML(
  "afterend",
  '<label class="compress-toggle"><input type="checkbox" id="scpCompress"><span>上传前压缩（打包为 .tar.gz，单次传输）</span></label>',
);
// SCP compress remembers the last choice (stored in UI state).
(function () {
  const stored = restoreUiState();
  if (typeof stored.scpCompress === "boolean")
    $("#scpCompress").checked = stored.scpCompress;
  $("#scpCompress").addEventListener("change", () =>
    saveUiState({ scpCompress: $("#scpCompress").checked }),
  );
})();
const localSyncRow = document.createElement("div");
localSyncRow.className = "local-sync";
localSyncRow.innerHTML =
  '<div id="localClientNotice" class="local-client-notice">正在检测本地客户端…</div><div id="rsyncInstallChoices" class="rsync-install-choices" hidden><button type="button" id="downloadSystemRsync">安装到电脑<small>调用系统包管理器，不打开网页；删除软件后仍保留</small></button><button type="button" id="downloadManagedRsync">安装到软件内<small>仅供 Fast GPU 使用，删除软件时会一起删除</small></button></div><div class="sync-direction" role="group" aria-label="同步方向"><button type="button" class="active" data-sync-direction="upload">本地 → 云端</button><button type="button" data-sync-direction="download">云端 → 本地</button></div><div id="localSyncControls" class="sync-paths"><label><span>本地路径</span><div class="sync-path-input"><input id="localSyncPath" placeholder="请选择本地文件夹" aria-label="本地路径" readonly><button type="button" id="browseLocalSyncPath" class="sync-browse-button" aria-label="浏览本地文件夹">浏览</button></div></label><div class="sync-path-arrow" aria-hidden="true">→</div><label><span>云端路径</span><input id="localSyncRemotePath" value="/data/sync" aria-label="云端路径"></label><button type="button" id="runLocalSync" class="sync-run-button">同步到云端</button></div><pre id="localSyncOutput" class="local-sync-output" hidden></pre>';
$("#syncCommand").after(localSyncRow);
$("#localSyncRemotePath").closest("label").insertAdjacentHTML(
  "afterend",
  '<label class="compress-toggle"><input type="checkbox" id="syncCompress"><span>传输前压缩（本地打包 → 传输 → 云端解压，自动清理临时压缩包）</span></label>',
);
// rsync/rclone compress remembers the last choice (stored in UI state).
(function () {
  const stored = restoreUiState();
  if (typeof stored.syncCompress === "boolean")
    $("#syncCompress").checked = stored.syncCompress;
  $("#syncCompress").addEventListener("change", () =>
    saveUiState({ syncCompress: $("#syncCompress").checked }),
  );
})();
$("#browseLocalSyncPath").onclick = async function () {
  const localPath = await window.gpuFleetWindow?.pickDirectory?.();
  if (localPath) $("#localSyncPath").value = localPath;
};
let syncDirection = "upload";
function updateSyncDirection(direction) {
  syncDirection = direction;
  $$("[data-sync-direction]").forEach((button) =>
    button.classList.toggle("active", button.dataset.syncDirection === direction),
  );
  $(".sync-path-arrow").textContent = direction === "upload" ? "→" : "←";
  $("#runLocalSync").textContent =
    direction === "upload" ? "同步到云端" : "同步到本地";
  updateSyncCommand();
}
$$("[data-sync-direction]").forEach(
  (button) =>
    (button.onclick = () => updateSyncDirection(button.dataset.syncDirection)),
);
let currentSshCommand = "",
  currentSshConnection = null;
let clientCapabilities = { mode: "web", localFilesystem: false, rsync: false };
async function loadClientCapabilities() {
  try {
    clientCapabilities = await request("/api/client/capabilities");
  } catch {}
  const local = clientCapabilities.mode === "local",
    ready = local && clientCapabilities.rsync;
  $("#localClientNotice").className =
    "local-client-notice " + (ready ? "ready" : "required");
  $("#localClientNotice").textContent = ready
    ? "本地客户端已连接，可以直接运行 rsync。"
    : local
      ? "本地客户端已连接，但本机未找到 rsync。"
      : "此功能需要本地客户端；网页端只能复制命令。";
  $("#localSyncPath").disabled = !ready;
  $("#localSyncRemotePath").disabled = !ready;
  $("#browseLocalSyncPath").disabled = !ready;
  $("#runLocalSync").disabled = !ready;
  $("#runLocalSync").textContent = ready
    ? syncDirection === "upload"
      ? "同步到云端"
      : "同步到本地"
    : local
      ? "缺少 rsync"
      : "需要本地客户端";
}
loadClientCapabilities();
const loadClientCapabilitiesBase = loadClientCapabilities;
loadClientCapabilities = async function () {
  await loadClientCapabilitiesBase();
  const local = clientCapabilities.mode === "local",
    ready = local && clientCapabilities.rsync;
  $("#localClientNotice").textContent = ready
    ? `rsync 已就绪（${clientCapabilities.rsyncSource === "application" ? "应用内" : "本机"}），可以直接同步。`
    : local
      ? "尚未找到 rsync，请选择下载位置。"
      : "网页端不能读取本机目录；你仍可复制命令手动运行。";
  $("#rsyncInstallChoices").hidden = !local || ready;
  $("#localSyncControls").hidden = !ready;
  const sshReady = !local || clientCapabilities.ssh;
  $("#sshInstallChoices").hidden = !local || sshReady;
  const connectionReady = Boolean(
    currentSshConnection?.instance?.sshReady &&
      currentSshConnection?.terminalAvailable,
  );
  $("#openSshTerminal").disabled = !sshReady || !connectionReady;
  $("#uploadScpFile").disabled =
    !sshReady || !currentSshConnection?.instance?.sshReady;
};
loadClientCapabilities();
async function installRsync(scope, button) {
  setButtonBusy(button, "安装中…");
  try {
    await request("/api/client/rsync/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope }),
    });
    await loadClientCapabilities();
    toast(
      scope === "system"
        ? "rsync 已安装到电脑，删除软件后仍会保留"
        : "rsync 已安装到软件内，删除软件时会一起删除",
    );
  } catch (error) {
    toast("rsync 安装失败：" + error.message);
  } finally {
    clearButtonBusy(button);
  }
}
async function installSsh(scope, button) {
  setButtonBusy(button, "安装中…");
  try {
    await request("/api/client/ssh/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope }),
    });
    await loadClientCapabilities();
    toast(
      scope === "system" ? "OpenSSH 已安装到电脑" : "OpenSSH 已安装到软件内",
    );
  } catch (error) {
    toast("OpenSSH 安装失败：" + error.message);
  } finally {
    clearButtonBusy(button);
  }
}
$$("[data-install-ssh]").forEach(
  (button) =>
    (button.onclick = function () {
      installSsh(button.dataset.installSsh, button);
    }),
);
$("#downloadSystemRsync").onclick = function () {
  installRsync("system", this);
};
$("#downloadManagedRsync").onclick = function () {
  installRsync("application", this);
};
$("#refreshLocalTools").onclick = loadLocalToolsSettings;
$("#localToolsList").onclick = async function (event) {
  const button = event.target.closest("[data-settings-install]");
  if (!button) return;
  const tool = button.dataset.settingsInstall,
    scope = button.dataset.scope;
  if (tool === "ssh") await installSsh(scope, button);
  else if (tool === "rsync") await installRsync(scope, button);
  await loadLocalToolsSettings();
};
async function waitForSshConnection(instance) {
  const url =
      "/api/instances/" +
      encodeURIComponent(instance.id) +
      "/ssh?provider=" +
      encodeURIComponent(instance.provider),
    deadline = Date.now() + 30000;
  while (true) {
    try {
      return await request(url);
    } catch (error) {
      if (error.code !== "ssh_pending") throw error;
      if (Date.now() >= deadline)
        throw Object.assign(
          Error(
            "SSH 连接超时：实例已运行，但厂商在 30 秒内仍未返回公网 SSH 凭据",
          ),
          { code: "ssh_timeout" },
        );
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}
function decorateSshButtons() {
  document.querySelectorAll(".instance").forEach(function (card) {
    const id = card.querySelector("[data-action]")?.dataset.id,
      instance = instances.find(function (item) {
        return String(item.id) === String(id);
      }),
      actions = card.querySelector(".instance-actions > div");
    if (!instance || !actions) return;
    let button = actions.querySelector("[data-ssh]");
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.dataset.ssh = String(instance.id);
      actions.prepend(button, document.createTextNode(" "));
    }
    actions.querySelector("[data-ssh-key]")?.remove();
    const accessible = Boolean(instance.sshReady),
      powered = ["provisioning", "running"].includes(instance.providerState),
      title = accessible
        ? "SSH 公网入口已就绪，可以登录或传输文件"
        : powered
          ? "正在等待 SSH 安装完成并通过公网连接检查"
          : "实例未开机，开机后即可连接 SSH";
    if (button.textContent !== "SSH / 文件") button.textContent = "SSH / 文件";
    button.disabled = false;
    // 只有实例已经开机、SSH 还在就绪时才显示呼吸等待动画；
    // 关机状态下保持静止，避免在无法连接时持续闪光。
    button.classList.toggle("ssh-loading", !accessible && powered);
    button.classList.toggle("ssh-dormant", !accessible && !powered);
    button.setAttribute("aria-busy", String(!accessible && powered));
    button.title = title;
  });
  bindInstanceBenchmarkButtons();
}
function applyInstanceLifecycleLabels() {
  document.querySelectorAll(".instance").forEach((card) => {
    const id = card.querySelector("[data-action]")?.dataset.id,
      instance = instances.find((item) => String(item.id) === String(id));
    if (
      instance?.status !== "provisioning" ||
      instance.lifecycleAction !== "start"
    )
      return;
    const pill = card.querySelector(".pill");
    if (pill) {
      // 注意：此函数由 MutationObserver 调用。修改实例状态相关 DOM 时必须先比较现值，禁止无条件重写或重复渲染，否则会自触发 Observer 并造成页面死循环卡死。
      if (pill.textContent !== "启动中") pill.textContent = "启动中";
    }
  });
}
new MutationObserver(() => {
  decorateSshButtons();
  applyInstanceLifecycleLabels();
}).observe($("#instanceGrid"), { childList: true, subtree: true });
decorateSshButtons();
applyInstanceLifecycleLabels();
document.addEventListener("click", async function (event) {
  const button = event.target.closest("[data-ssh]");
  if (!button) return;
  const instance = instances.find(function (item) {
    return String(item.id) === String(button.dataset.ssh);
  });
  if (!instance) return;
  if (!instance.sshReady) {
    const keyDownloadUrl = instance.platformManaged
        ? `/api/instances/${encodeURIComponent(instance.id)}/ssh/key?provider=${encodeURIComponent(instance.provider)}`
        : "",
      identityFile =
        `gpu-fleet-${instance.provider}-${instance.id}`.replace(
          /[^a-z0-9._-]/gi,
          "_",
        ) + ".pem";
    currentSshCommand = "";
    currentSshConnection = {
      instance,
      keyDownloadUrl,
      identityFile,
     terminalAvailable: false,
   };
   $("#sshConnectionDetails").innerHTML =
     '<div class="ssh-pending-state"><strong>SSH 正在准备中</strong><small>实例入口就绪后即可打开平台终端，请稍候。</small></div>';
   $("#sshKeyDownload").hidden = !keyDownloadUrl;
   $("#copySshCommand").disabled = true;
   $("#openSshTerminal").hidden = false;
   $("#openSshTerminal").disabled = true;
   $("#uploadScpFile").disabled = true;
   sshDialog.showModal();
   return;
 }
 setButtonBusy(button, "等待 SSH…");
 try {
   const ssh = await waitForSshConnection(instance);
   currentSshCommand = ssh.command;
   currentSshConnection = { ...ssh, instance };
   const credential = ssh.managed
     ? '<div class="ssh-field"><span>认证</span><code>托管私钥（已加密保存）</code></div>'
     : '<div class="ssh-field"><span>密码</span><code>' +
       esc(ssh.password) +
       "</code></div>";
   $("#sshConnectionDetails").innerHTML =
     '<div class="ssh-field"><span>地址</span><strong>' +
     esc(ssh.host) +
     ":" +
     esc(ssh.port) +
     '</strong></div><div class="ssh-field"><span>账号</span><strong>' +
     esc(ssh.username) +
     "</strong></div>" +
     credential +
     '<div class="ssh-command"><code>' +
     esc(ssh.command) +
     "</code></div>";
   $("#sshKeyDownload").hidden = !ssh.keyDownloadUrl;
   $("#copySshCommand").disabled = false;
    $("#openSshTerminal").hidden = false;
    $("#openSshTerminal").disabled =
      !ssh.terminalAvailable ||
      (clientCapabilities.mode === "local" && !clientCapabilities.ssh);
    $("#uploadScpFile").disabled =
      clientCapabilities.mode === "local" && !clientCapabilities.ssh;
    updateSyncCommand();
    sshDialog.showModal();
  } catch (error) {
    toast(
      error.code === "ssh_timeout"
        ? error.message
        : "SSH 登录信息获取失败：" + error.message,
    );
  } finally {
    clearButtonBusy(button);
  }
});
function updateSyncCommand() {
  if (!currentSshConnection) return;
  const s = currentSshConnection,
    validDirectory = updateSyncDirectoryHint(),
    dir = resolvedSyncDirectory(),
    key = s.identityFile;
  if (!validDirectory || !dir) {
    $("#syncCommand").textContent =
      "相对路径只能在平台 SSH 终端内使用。";
    return;
  }
  const local = $("#localSyncPath").value.trim();
  if (!local || !isAbsoluteLocalPath(local)) {
    $("#syncCommand").textContent = "";
    return;
  }
  const
    remote = `${s.username}@${s.host}:${dir}/`;
  if ($("#syncTool").value === "rclone")
    $("#syncCommand").textContent =
      syncDirection === "upload"
        ? `rclone sync "${local}" :sftp:${dir} --sftp-host ${s.host} --sftp-user ${s.username} --sftp-port ${s.port} --sftp-key-file "${key}" --progress --retries 10`
        : `rclone sync :sftp:${dir} "${local}" --sftp-host ${s.host} --sftp-user ${s.username} --sftp-port ${s.port} --sftp-key-file "${key}" --progress --retries 10`;
  else
    $("#syncCommand").textContent =
      `rsync -avz --partial --append-verify --progress -e "ssh -i \\"${key}\\" -p ${s.port}" ${syncDirection === "upload" ? `"${local}/" ${remote}` : `${remote} "${local}/"`}`;
}
$("#syncTool").onchange = updateSyncCommand;
$("#syncRemoteDir").oninput = updateSyncCommand;
$("#localSyncPath").oninput = updateSyncCommand;
$("#localSyncRemotePath").oninput = function () {
  $("#syncRemoteDir").value = this.value;
  updateSyncCommand();
};
updateSyncDirectoryHint();
$("#copySyncCommand").onclick = async function () {
  if (!updateSyncDirectoryHint() || !resolvedSyncDirectory()) {
    toast("相对同步路径只能在平台 SSH 终端内使用");
    return;
  }
  try {
    await navigator.clipboard.writeText($("#syncCommand").textContent);
    toast("增量同步命令已复制；请先下载私钥并在本地运行");
  } catch {
    toast("复制失败");
  }
};
$("#runLocalSync").onclick = async function () {
  if (!currentSshConnection) return;
  const button = $("#runLocalSync"),
    output = $("#localSyncOutput"),
    localPath = $("#localSyncPath").value.trim(),
    remoteDir = resolvedSyncDirectory();
  if (!localPath) return toast("请输入本地目录");
  if (!isAbsoluteLocalPath(localPath))
    return toast("请重新选择本地目录");
  if (!updateSyncDirectoryHint() || !remoteDir)
    return toast("平台终端外云端路径必须是绝对路径");
  if (!/^\/[a-zA-Z0-9._/-]+$/.test(remoteDir) || remoteDir.includes(".."))
    return toast("云端路径必须是安全路径");
  setButtonBusy(button, "同步中…");
  output.hidden = false;
  output.textContent = "正在运行 rsync，请勿关闭本地客户端…";
  try {
    const result = await request(
      "/api/instances/" +
        encodeURIComponent(currentSshConnection.instance.id) +
        "/local-sync",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: currentSshConnection.instance.provider,
          localPath,
          remoteDir,
          direction: syncDirection,
          compress: Boolean($("#syncCompress")?.checked),
        }),
      },
    );
    output.textContent = result.output || "同步完成";
    toast(syncDirection === "upload" ? "已同步到云端" : "已同步到本地");
  } catch (error) {
    output.textContent = error.message;
    toast("同步失败：" + error.message);
  } finally {
    clearButtonBusy(button);
  }
};
let selectedScpFiles = [],
  collapsedScpFolders = new Set(),
  nextScpBatchId = 1;
function scpTree(indexes = selectedScpFiles.map((item, index) => index)) {
  const root = { children: new Map() };
  indexes.forEach((index) => {
    const item = selectedScpFiles[index];
    let node = root;
    const parts = item.relativePath.split("/");
    parts.forEach((part, partIndex) => {
      if (!node.children.has(part))
        node.children.set(part, {
          name: part,
          path: parts.slice(0, partIndex + 1).join("/"),
          children: new Map(),
          index: null,
        });
      node = node.children.get(part);
    });
    node.index = index;
  });
  return root;
}
function renderScpNodes(node, batchId) {
  return [...node.children.values()]
    .map((child) => {
      if (child.index != null) {
        const item = selectedScpFiles[child.index];
        return `<div class="selection-file ${item.uploaded ? "uploaded" : ""}"><label><input type="checkbox" data-scp-file="${child.index}" ${item.selected ? "checked" : ""}><span>${esc(child.name)}</span></label><small>${item.uploaded ? "<b>已上传</b> · " : ""}${(item.file.size / 1024 / 1024).toFixed(1)} MB</small><button type="button" class="selection-remove" data-scp-remove-file="${child.index}">移除</button></div>`;
      }
      const indexes = selectedScpFiles
          .map((item, index) =>
            item.batchId === batchId &&
            item.relativePath.startsWith(child.path + "/")
              ? index
              : -1,
          )
          .filter((index) => index >= 0),
        checked = indexes.every((index) => selectedScpFiles[index].selected),
        partial =
          !checked && indexes.some((index) => selectedScpFiles[index].selected),
        folderPath = esc(child.path),
        detailsKey = `${batchId}:${child.path}`,
        open = !collapsedScpFolders.has(detailsKey);
      return `<details data-scp-details="${esc(detailsKey)}" ${open ? "open" : ""}><summary><span class="selection-folder-chevron" aria-hidden="true"></span><input type="checkbox" data-scp-folder="${folderPath}" data-scp-batch="${batchId}" ${checked ? "checked" : ""} ${partial ? 'data-indeterminate="true"' : ""}><span>📁 ${esc(child.name)}</span><span class="selection-folder-state"><b class="expanded-label">已展开</b><b class="collapsed-label">已折叠</b></span><small>${indexes.length} 项</small><span class="selection-actions"><button type="button" data-scp-select-folder="${folderPath}" data-scp-batch="${batchId}">全选</button><button type="button" data-scp-unselect-folder="${folderPath}" data-scp-batch="${batchId}">全不选</button><button type="button" class="selection-remove" data-scp-remove-folder="${folderPath}" data-scp-batch="${batchId}">移除</button></span></summary><div>${renderScpNodes(child, batchId)}</div></details>`;
    })
    .join("");
}
function scpBatchLabel(position) {
  const numerals = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  return numerals[position] || String(position + 1);
}
function showScpSelection() {
  const chosen = selectedScpFiles.filter((item) => item.selected),
    bytes = chosen.reduce((sum, item) => sum + item.file.size, 0),
    tree = $("#scpSelectionTree"),
    batchIds = [...new Set(selectedScpFiles.map((item) => item.batchId))],
    batches = batchIds
      .map((batchId, position) => {
        const indexes = selectedScpFiles
            .map((item, index) => (item.batchId === batchId ? index : -1))
            .filter((index) => index >= 0),
          selectedCount = indexes.filter(
            (index) => selectedScpFiles[index].selected,
          ).length;
        return `<section class="selection-batch" aria-label="批次${scpBatchLabel(position)}"><div class="selection-batch-head"><strong><span class="selection-batch-number">${position + 1}</span>批次${scpBatchLabel(position)}</strong><small>已选 ${selectedCount}/${indexes.length} 个文件</small></div><div class="selection-batch-content">${renderScpNodes(scpTree(indexes), batchId)}</div></section>`;
      })
      .join("");
  $("#scpFileLabel").textContent = selectedScpFiles.length
    ? `已选 ${chosen.length}/${selectedScpFiles.length} 个文件 · ${(bytes / 1024 / 1024).toFixed(1)} MB`
    : "尚未选择内容";
  tree.hidden = !selectedScpFiles.length;
  tree.innerHTML = selectedScpFiles.length
    ? `<div class="selection-tree-head"><strong>上传内容 · ${batchIds.length} 个批次</strong><span class="selection-actions"><button type="button" data-scp-select-all>全选</button><button type="button" data-scp-unselect-all>全不选</button><button type="button" class="selection-remove" data-scp-clear>清空</button></span></div><div class="selection-batches">${batches}</div>`
    : "";
  tree
    .querySelectorAll('[data-indeterminate="true"]')
    .forEach((input) => (input.indeterminate = true));
}
function addScpFiles(files) {
  const batchId = nextScpBatchId++;
  const additions = files
    .filter((item) => item?.file)
    .map((item) => ({
      ...item,
      relativePath: item.relativePath.replaceAll("\\", "/"),
      batchId,
      selected: true,
      uploaded: false,
    }));
  for (const item of additions) {
    const existing = selectedScpFiles.findIndex(
      (current) => current.relativePath === item.relativePath,
    );
    if (existing >= 0) selectedScpFiles[existing] = item;
    else selectedScpFiles.push(item);
  }
  showScpSelection();
}
$("#scpSelectionTree").onchange = (event) => {
  const fileIndex = event.target.dataset.scpFile,
    folder = event.target.dataset.scpFolder,
    batchId = Number(event.target.dataset.scpBatch);
  if (fileIndex != null) {
    const item = selectedScpFiles[Number(fileIndex)];
    item.selected = event.target.checked;
    if (item.selected) item.uploaded = false;
  } else if (folder != null)
    selectedScpFiles.forEach((item) => {
      if (
        item.batchId === batchId &&
        item.relativePath.startsWith(folder + "/")
      ) {
        item.selected = event.target.checked;
        if (item.selected) item.uploaded = false;
      }
    });
  showScpSelection();
};
$("#scpSelectionTree").addEventListener(
  "toggle",
  (event) => {
    const path = event.target.dataset.scpDetails;
    if (path == null) return;
    if (event.target.open) collapsedScpFolders.delete(path);
    else collapsedScpFolders.add(path);
  },
  true,
);
$("#scpSelectionTree").onclick = (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  if (button.hasAttribute("data-scp-select-all"))
    selectedScpFiles.forEach((item) => {
      item.selected = true;
      item.uploaded = false;
    });
  else if (button.hasAttribute("data-scp-unselect-all"))
    selectedScpFiles.forEach((item) => (item.selected = false));
  else if (button.hasAttribute("data-scp-clear")) {
    selectedScpFiles = [];
    $("#scpFile").value = "";
    $("#scpFolder").value = "";
  } else if (button.dataset.scpSelectFolder != null)
    selectedScpFiles.forEach((item) => {
      if (
        item.batchId === Number(button.dataset.scpBatch) &&
        item.relativePath.startsWith(button.dataset.scpSelectFolder + "/")
      ) {
        item.selected = true;
        item.uploaded = false;
      }
    });
  else if (button.dataset.scpUnselectFolder != null)
    selectedScpFiles.forEach((item) => {
      if (
        item.batchId === Number(button.dataset.scpBatch) &&
        item.relativePath.startsWith(button.dataset.scpUnselectFolder + "/")
      )
        item.selected = false;
    });
  else if (button.dataset.scpRemoveFolder != null)
    selectedScpFiles = selectedScpFiles.filter(
      (item) =>
        item.batchId !== Number(button.dataset.scpBatch) ||
        !item.relativePath.startsWith(button.dataset.scpRemoveFolder + "/"),
    );
  else if (button.dataset.scpRemoveFile != null)
    selectedScpFiles.splice(Number(button.dataset.scpRemoveFile), 1);
  showScpSelection();
};
$("#pickScpFiles").onclick = () => $("#scpFile").click();
$("#pickScpFolder").onclick = () => $("#scpFolder").click();
$("#scpFile").onchange = (event) => {
  addScpFiles(
    [...event.target.files].map((file) => ({ file, relativePath: file.name })),
  );
  event.target.value = "";
};
$("#scpFolder").onchange = (event) => {
  addScpFiles(
    [...event.target.files].map((file) => ({
      file,
      relativePath: file.webkitRelativePath || file.name,
    })),
  );
  event.target.value = "";
};
async function filesFromEntry(entry, prefix = "") {
  if (entry.isFile)
    return new Promise((resolve) =>
      entry.file(
        (file) => resolve([{ file, relativePath: prefix + file.name }]),
        () => resolve([]),
      ),
    );
  if (!entry.isDirectory) return [];
  const reader = entry.createReader(),
    children = [];
  while (true) {
    const batch = await new Promise((resolve) =>
      reader.readEntries(resolve, () => resolve([])),
    );
    if (!batch.length) break;
    children.push(...batch);
  }
  const nested = await Promise.all(
    children.map((child) => filesFromEntry(child, `${prefix}${entry.name}/`)),
  );
  return nested.flat();
}
const scpDropZone = $("#scpDropZone");
for (const name of ["dragenter", "dragover"])
  scpDropZone.addEventListener(name, (event) => {
    event.preventDefault();
    scpDropZone.classList.add("dragging");
  });
for (const name of ["dragleave", "drop"])
  scpDropZone.addEventListener(name, (event) => {
    event.preventDefault();
    scpDropZone.classList.remove("dragging");
  });
scpDropZone.addEventListener("drop", async (event) => {
  const entries = [...event.dataTransfer.items]
    .map((item) => item.webkitGetAsEntry?.())
    .filter(Boolean);
  if (entries.length)
    addScpFiles(
      (await Promise.all(entries.map((entry) => filesFromEntry(entry)))).flat(),
    );
  else
    addScpFiles(
      [...event.dataTransfer.files].map((file) => ({
        file,
        relativePath: file.name,
      })),
    );
});
// Stream a .tar.gz of the selected files to the server, which extracts on the
// remote. Pure browser, no dependencies. Kept as a standalone snippet so the
// patch script can inject it verbatim (no quote escaping headaches).
function buildTarGzStream(items) {
  const encoder = new TextEncoder();
  function ustarHeader(name, size) {
    const block = new Uint8Array(512);
    const nameBytes = encoder.encode(name);
    block.set(nameBytes.subarray(0, Math.min(100, nameBytes.length)), 0);
    const oct = (value, offset, width, term) => {
      const str = value.toString(8).padStart(width - 1, "0");
      encoder.encode(str).forEach((b, i) => (block[offset + i] = b));
      block[offset + width - 1] = term ? 0x20 : 0;
      if (!term) block[offset + width - 2] = 0x20;
    };
    oct(0o644, 100, 8);   // mode
    oct(0, 108, 8);       // uid
    oct(0, 116, 8);       // gid
    oct(size, 124, 12);   // size
    oct(0, 136, 12);      // mtime
    block[156] = 0x30;    // typeflag '0' (regular file)
    encoder.encode("ustar").forEach((b, i) => (block[257 + i] = b));
    block[263] = 0x20;    // version
    let checksum = 256;
    for (let i = 0; i < 512; i++) checksum += block[i];
    oct(checksum, 148, 8, true);
    return block;
  }
  const zero = () => new Uint8Array(512);
  return new ReadableStream({
    async start(controller) {
      try {
        for (const item of items) {
          const name = item.relativePath;
          const file = item.file;
          controller.enqueue(ustarHeader(name, file.size));
          const reader = file.stream().getReader();
          let written = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
            written += value.byteLength;
          }
          const rem = written % 512;
          if (rem) controller.enqueue(new Uint8Array(512 - rem));
        }
        controller.enqueue(zero());
        controller.enqueue(zero());
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}
async function uploadScpCompressed(items, dir, signal) {
  const conn = currentSshConnection;
  const gz = buildTarGzStream(items).pipeThrough(new CompressionStream("gzip"));
  const url = "/api/instances/" + encodeURIComponent(conn.instance.id) + "/files?provider=" + encodeURIComponent(conn.instance.provider);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/gzip",
      "x-file-name": encodeURIComponent("upload.tar.gz"),
      "x-relative-path": encodeURIComponent("upload.tar.gz"),
      "x-remote-directory": dir,
      "x-extract-archive": "1",
    },
    body: gz,
    signal,
    duplex: "half",
  });
  if (!response.ok) {
    let detail = "HTTP " + response.status;
    try {
      const result = await response.json();
      if (result.error) detail = result.error;
    } catch {}
    throw Error("压缩上传失败：" + detail);
  }
  return await response.json();
}
function uploadScpItem(item, dir, onProgress, onBrowserUploaded, signal) {
  return new Promise((resolve, reject) => {
    const url = `/api/instances/${encodeURIComponent(currentSshConnection.instance.id)}/files?provider=${encodeURIComponent(currentSshConnection.instance.provider)}`,
      xhr = new XMLHttpRequest(),
      cancel = () => xhr.abort();
    if (signal?.aborted)
      return reject(
        Object.assign(Error("上传已取消"), { code: "upload_cancelled" }),
      );
    signal?.addEventListener("abort", cancel, { once: true });
    xhr.open("POST", url);
    xhr.timeout = Math.max(
      120000,
      Math.min(
        30 * 60 * 1000,
        120000 + Math.ceil(item.file.size / 1024 / 1024) * 5000,
      ),
    );
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(item.file.name));
    xhr.setRequestHeader(
      "x-relative-path",
      encodeURIComponent(item.relativePath),
    );
    xhr.setRequestHeader("x-remote-directory", dir);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    xhr.upload.onload = onBrowserUploaded;
    const finish = (callback) => {
      signal?.removeEventListener("abort", cancel);
      callback();
    };
    xhr.onload = () =>
      finish(() => {
        let result = {};
        try {
          result = JSON.parse(xhr.responseText || "{}");
        } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(result);
        else {
          const error = Error(result.error || `HTTP ${xhr.status}`);
          Object.assign(error, { status: xhr.status, code: result.code });
          reject(error);
        }
      });
    xhr.onerror = () =>
      finish(() =>
        reject(Object.assign(Error("网络连接中断"), { code: "network_error" })),
      );
    xhr.onabort = () =>
      finish(() =>
        reject(
          Object.assign(Error("上传已取消"), { code: "upload_cancelled" }),
        ),
      );
    xhr.ontimeout = () =>
      finish(() =>
        reject(
          Object.assign(Error(`文件上传超时：${item.relativePath}`), {
            code: "upload_timeout",
          }),
        ),
      );
    xhr.send(item.file);
  });
}
let scpUploadInProgress = false,
  scpUploadController = null;
function scpFailureMessage(error) {
  const connectionCodes = [
    "ssh_unreachable",
    "ssh_pending",
    "ssh_provider_error",
    "ssh_credentials_unavailable",
  ];
  return (
    (connectionCodes.includes(error.code) ? "SSH 连接失败：" : "上传失败：") +
    error.message
  );
}
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
// padded card, and give each provider card its own save button.
function normalizeStorageCards() {
  document.querySelectorAll("[data-storage-provider]").forEach((card) => {
    const legend = card.querySelector(":scope > legend");
    if (legend) {
      const head = document.createElement("div");
      head.className = "s3-legend" + (legend.className ? " " + legend.className : "");
      while (legend.firstChild) head.append(legend.firstChild);
      legend.replaceWith(head);
    }
    if (!card.querySelector(":scope > .s3-card-actions")) {
      const footer = document.createElement("div");
      footer.className = "s3-card-actions";
      const save = document.createElement("button");
      save.type = "submit";
      save.className = "primary";
      save.textContent = "保存";
      footer.append(save);
      card.append(footer);
    }
  });
}
normalizeStorageCards();

for (const provider of [
  {
    id: "r2",
    url: "https://dash.cloudflare.com/?to=/:account/r2",
    windowName: "gpu-fleet-cloudflare-r2",
    label: "前往 Cloudflare R2 获取 Access Key",
  },
  {
    id: "oss",
    url: "https://oss.console.aliyun.com/overview",
    windowName: "gpu-fleet-aliyun-oss",
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
$("#s3Form").insertAdjacentHTML(
  "afterend",
  '<form id="existingStorageForm" class="table-card existing-storage"><div><span class="eyebrow">EXISTING INSTANCE</span><h3>应用到已有实例</h3><p>选择 Bucket 内的 Prefix，同步到实例目录，或在实例支持 FUSE 时只读挂载。</p></div><label>运行中的实例<select id="existingStorageInstance" required><option value="">正在加载…</option></select></label><label>存储源<select id="existingStorageProvider"><option value="r2">Cloudflare R2</option><option value="oss">阿里云 OSS</option></select></label><label>Prefix（留空使用已保存值）<input id="existingStoragePrefix" placeholder="datasets/project-a"></label><label>目标目录<input id="existingStorageTarget" value="/data/datasets"></label><label>操作<select id="existingStorageMode"><option value="copy">选择性同步（不删除目标中多余文件）</option><option value="mount">只读自动挂载（需要 FUSE）</option></select></label><button class="primary" type="submit">应用到实例</button><small id="existingStorageHint">同步内容保留到实例磁盘；挂载在实例重启后需要重新应用。</small></form>',
);
let existingStorageInstances = new Map();
async function loadExistingStorageInstances() {
  const response = await request("/api/instances");
  const available = response.instances || [];
  existingStorageInstances = new Map(available.map((item) => [String(item.id), item]));
  $("#existingStorageInstance").innerHTML =
    '<option value="">请选择实例</option>' +
    available
      .map((item) => `<option value="${esc(item.id)}">${esc(item.name)} · ${esc(item.provider)} · ${item.status === "running" ? "运行中" : "需先启动"}</option>`)
      .join("");
}
$("#existingStorageMode").onchange = function () {
  $("#existingStorageTarget").value =
    this.value === "mount" ? `/data/object-storage/${$("#existingStorageProvider").value}` : "/data/datasets";
};
$("#existingStorageProvider").onchange = function () {
  if ($("#existingStorageMode").value === "mount")
    $("#existingStorageTarget").value = `/data/object-storage/${this.value}`;
};
$("#existingStorageForm").onsubmit = async function (event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button"),
    id = $("#existingStorageInstance").value,
    instance = existingStorageInstances.get(id);
  if (!instance) return toast("请选择一个运行中的实例");
  if (instance.status !== "running")
    return toast("请先启动实例，再应用或挂载 S3 配置");
  setButtonBusy(button, "正在应用…");
  $("#existingStorageHint").textContent = "实例正在连接对象存储，请勿关闭应用…";
  try {
    const result = await request(`/api/instances/${encodeURIComponent(id)}/object-storage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instanceProvider: instance.provider,
        provider: $("#existingStorageProvider").value,
        prefix: $("#existingStoragePrefix").value || undefined,
        target: $("#existingStorageTarget").value,
        mode: $("#existingStorageMode").value,
      }),
    });
    $("#existingStorageHint").textContent = result.output || `已应用到 ${result.target}`;
    toast(result.mode === "mount" ? "对象存储已只读挂载" : "对象存储同步完成");
  } catch (error) {
    $("#existingStorageHint").textContent = error.message;
    toast("应用对象存储失败：" + error.message);
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
    $("#existingStorageTarget").value = state.target || "/data/datasets";
    $("#existingStorageMode").value = state.mode || "copy";
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
function updateStoragePrimaryOptions() {
  const select = $("#storagePrimary");
  const valid = [];
  for (const [provider, fields] of Object.entries(storageProviderFields)) {
    // 只有「已配置并且启用」的供应商才能作为新实例默认读取源。
    const selectable =
      storageProviderConfigured[provider] && $(fields.enabled).checked;
    $(`#storagePrimary option[value="${provider}"]`).disabled = !selectable;
    if (selectable) valid.push(provider);
  }
  // 清理上次无可用源时插入的占位项。
  select.querySelector('option[data-empty]')?.remove();
  if (!valid.length) {
    // 没有可读取的存储源：锁定选择器，避免选到读不到数据的供应商。
    const placeholder = new Option("暂无已配置并启用的存储源", "");
    placeholder.disabled = true;
    placeholder.dataset.empty = "";
    select.prepend(placeholder);
    select.selectedIndex = 0;
    select.disabled = true;
    return;
  }
  select.disabled = false;
  if (!valid.includes(select.value)) select.value = valid[0];
}
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
async function loadS3Config() {
  let c;
  try {
    c = await request("/api/storage/providers");
  } catch (error) {
    // 无法读取存储配置属于真正的异常，仍然提示；但不打扰未配置的正常状态
    toast("读取对象存储设置失败：" + error.message);
    setPageTitleAlert("存储配置读取失败");
    return;
  }
  // 实例列表加载失败不应阻塞存储设置页面（例如尚未配置任何算力供应商时）
  try {
    await loadExistingStorageInstances();
  } catch (_instanceError) {
    $("#existingStorageInstance").innerHTML = '<option value="">请先启动实例</option>';
  }
  for (const [provider, fields] of Object.entries(storageProviderFields)) {
    const item = c.providers?.[provider] || {};
    $(fields.enabled).checked = Boolean(item.enabled);
    $(fields.endpoint).value = item.endpoint || "";
    $(fields.bucket).value = item.bucket || "";
    $(fields.prefix).value = item.prefix || "";
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
    $(fields.region).value = item.region || (provider === "r2" ? "auto" : "");
   $(fields.accessKey).value = item.accessKeyId || "";
   $(fields.secretKey).value = item.secretAccessKey || "";
  $(fields.accessKey).placeholder = "S3 Access Key ID";
 $(fields.hint).textContent = item.configured
     ? `已保存 Bucket：${item.bucket}`
     : "尚未配置";
    storageProviderConfigured[provider] = Boolean(item.configured);
  }
 $("#storagePrimary").value = c.primaryProvider || "r2";
 updateStoragePrimaryOptions();
 updateStorageUploadProviders(c.providers || {});
 const enabled = Object.values(c.providers || {}).filter(
    (item) => item.enabled && item.configured,
  ).length;
  $("#s3Status").className = "pill " + (enabled ? "ready" : "warning");
  $("#s3Status").textContent = enabled ? `已启用 ${enabled} 个` : "尚未配置";
  setPageTitleAlert(enabled ? null : "注意：未配置");
  $("#s3Hint").textContent = enabled
    ? "两套配置都会下发，主存储负责首次数据同步。"
    : "尚未配置任何对象存储供应商，下方可随时填写并保存。";
  for (const [provider, fields] of Object.entries(storageProviderFields))
    $(`#existingStorageProvider option[value="${provider}"]`).disabled = !$(fields.enabled).checked;
}
for (const fields of Object.values(storageProviderFields))
  $(fields.enabled).onchange = updateStoragePrimaryOptions;
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
  new MutationObserver(syncTrigger).observe(select, {
    childList: true,
    subtree: true,
  });
  syncTrigger();
}
createSearchableSelect($("#ossRegion"));
$("#s3Form").onsubmit = async function (event) {
  event.preventDefault();
  const button =
    event.submitter || event.currentTarget.querySelector("button[type=submit]");
  setButtonBusy(button, "保存中…");
  try {
    const providers = Object.fromEntries(
      Object.entries(storageProviderFields).map(([provider, fields]) => [
        provider,
        {
          enabled: $(fields.enabled).checked,
          endpoint: $(fields.endpoint).value,
          bucket: $(fields.bucket).value,
          prefix: $(fields.prefix).value,
          region: $(fields.region).value,
          accessKeyId: $(fields.accessKey).value,
          secretAccessKey: $(fields.secretKey).value,
        },
      ]),
    );
    await request("/api/storage/providers", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        primaryProvider: $("#storagePrimary").value,
        providers,
      }),
    });
    await loadS3Config();
    toast("对象存储设置已加密保存并立即生效");
  } catch (error) {
    toast("保存失败：" + error.message);
  } finally {
    clearButtonBusy(button);
  }
};
$("#copySshCommand").onclick = async function () {
  try {
    await navigator.clipboard.writeText(currentSshCommand);
    toast("SSH 命令已复制");
  } catch {
    toast("复制失败，请手动复制");
  }
};
$("#downloadSshKey").onclick = async function () {
  if (!currentSshConnection?.keyDownloadUrl) return;
  const button = this;
  button.disabled = true;
  try {
    await secureKeyDownload(
      currentSshConnection.keyDownloadUrl,
      currentSshConnection.identityFile,
    );
    toast("SSH 私钥已通过临时密钥加密下载");
  } catch (error) {
    toast("私钥下载失败：" + error.message);
  } finally {
    button.disabled = false;
  }
};
const terminalDialog = document.createElement("dialog");
terminalDialog.id = "sshTerminalDialog";
terminalDialog.innerHTML =
  '<div class="terminal-shell"><div class="terminal-head terminal-window-bar"><div><span class="eyebrow">MANAGED SSH</span><h2>平台终端</h2></div><div class="terminal-head-actions"><button type="button" id="showTerminalShortcuts" class="terminal-help" aria-label="查看终端快捷键">快捷键</button><button type="button" class="terminal-close" aria-label="关闭平台终端">×</button></div></div><div class="terminal-workspace"><div id="sshTerminalOutput" aria-label="SSH 终端"></div><aside id="terminalTransferPanel" class="terminal-transfer-panel"><button type="button" id="toggleTerminalTransfer" aria-expanded="true" title="展开或收起文件传输"><span>文件传输</span><b>›</b></button><div id="terminalTransferMount"></div></aside></div></div>';
document.body.append(terminalDialog);
const terminalShortcutDialog = document.createElement("dialog");
terminalShortcutDialog.id = "terminalShortcutDialog";
terminalShortcutDialog.innerHTML =
  '<form method="dialog"><button class="close" value="cancel" aria-label="关闭">×</button><span class="eyebrow">TERMINAL SHORTCUTS</span><h2>终端快捷键</h2><label class="terminal-mode-setting">键盘模式<select id="terminalKeyboardMode"><option value="terminal">终端模式（推荐）</option><option value="desktop">桌面编辑模式</option></select></label><p id="terminalModeHint"></p><dl class="terminal-shortcut-list"><div><dt><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd></dt><dd>复制选中文本</dd></div><div><dt><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd></dt><dd>粘贴；多行内容会先确认</dd></div><div><dt>右键</dt><dd>打开复制、粘贴菜单</dd></div><div><dt><kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd></dt><dd>在普通 Shell 中按视觉行上下移动</dd></div><div data-desktop-shortcut><dt><kbd>Ctrl</kbd>+<kbd>C</kbd></dt><dd>有选区时复制，否则中断命令</dd></div><div data-desktop-shortcut><dt><kbd>Ctrl</kbd>+<kbd>V</kbd></dt><dd>粘贴；多行内容会先确认</dd></div><div data-desktop-shortcut><dt><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd></dt><dd>撤销 Shell 的上一次输入操作；一次粘贴通常算一次操作</dd></div><div><dt><kbd>Ctrl</kbd>+<kbd>Z</kbd></dt><dd>发送终端原生挂起信号</dd></div></dl><menu><button value="cancel">关闭</button></menu></form>';
document.body.append(terminalShortcutDialog);
const terminalContextMenu = document.createElement("div");
terminalContextMenu.id = "terminalContextMenu";
terminalContextMenu.hidden = true;
terminalContextMenu.innerHTML =
  '<button type="button" data-terminal-copy>复制</button><button type="button" data-terminal-paste>粘贴</button>';
terminalDialog.append(terminalContextMenu);
const XtermTerminal = globalThis.Terminal,
  XtermFitAddon = globalThis.FitAddon?.FitAddon;
let terminalSessionId = "",
  terminalEvents = null,
  xterm = null,
  terminalFit = null,
  terminalResizeObserver = null,
  terminalConnectController = null,
  terminalConnectAttempt = 0;
let terminalKeyboardMode =
  readUiState().terminalKeyboardMode === "desktop" ? "desktop" : "terminal";
function sendTerminalInput(input) {
  if (!terminalSessionId || !input) return;
  fetch("/api/ssh/sessions/" + terminalSessionId + "/input", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input }),
  }).catch(() => toast("终端输入发送失败"));
}
function updateTerminalModeUi() {
  $("#terminalKeyboardMode").value = terminalKeyboardMode;
  $("#terminalModeHint").textContent =
    terminalKeyboardMode === "desktop"
      ? "桌面模式会接管 Ctrl+C/V 和 Ctrl+Shift+Z；Ctrl+Z 始终保留给远端终端挂起进程。"
      : "终端模式保留 Ctrl+C 中断、Ctrl+Z 挂起和 Ctrl+V 原样输入。";
  terminalShortcutDialog
    .querySelectorAll("[data-desktop-shortcut]")
    .forEach((row) => (row.hidden = terminalKeyboardMode !== "desktop"));
}
async function copyTerminalSelection() {
  const selection = xterm?.getSelection() || "";
  if (!selection) {
    toast("请先选择要复制的终端文本");
    return;
  }
  try {
    await navigator.clipboard.writeText(selection);
    toast("终端文本已复制");
  } catch {
    toast("复制失败，请检查剪贴板权限");
  }
}
let lastTerminalPaste = { text: "", time: 0 };
function pasteTerminalText(text) {
  if (!xterm || !terminalSessionId || !text) return;
  const normalized = String(text).replace(/\r\n/g, "\n");
  const now = performance.now();
  if (
    normalized === lastTerminalPaste.text &&
    now - lastTerminalPaste.time < 500
  )
    return;
  lastTerminalPaste = { text: normalized, time: now };
  const lineCount = normalized.split("\n").length;
  if (
    lineCount > 1 &&
    !confirm(
      `即将向远端终端粘贴 ${lineCount} 行内容，其中的命令可能立即执行。是否继续？`,
    )
  )
    return;
  sendTerminalInput(normalized);
  xterm.focus();
}
async function pasteFromClipboard() {
  try {
    pasteTerminalText(await navigator.clipboard.readText());
  } catch {
    toast("无法读取剪贴板，请检查浏览器权限");
  }
}
function terminalUsesAlternateScreen() {
  return xterm?.buffer?.active?.type === "alternate";
}
function moveTerminalVisualLine(direction) {
  if (!xterm || terminalUsesAlternateScreen()) return false;
  const sequence = direction < 0 ? "\x1b[D" : "\x1b[C";
  sendTerminalInput(sequence.repeat(Math.max(1, xterm.cols)));
  return true;
}
function handleTerminalKey(event) {
  if (!xterm) return true;
  const key = event.key.toLowerCase();
  if (event.ctrlKey && event.shiftKey && key === "c") {
    copyTerminalSelection();
    return false;
  }
  if (event.ctrlKey && event.shiftKey && key === "v") {
    pasteFromClipboard();
    return false;
  }
  if (
    terminalKeyboardMode === "desktop" &&
    event.ctrlKey &&
    event.shiftKey &&
    !event.altKey &&
    key === "z"
  ) {
    sendTerminalInput("\x1f");
    return false;
  }
  if (
    event.altKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    (event.key === "ArrowUp" || event.key === "ArrowDown")
  ) {
    return !moveTerminalVisualLine(event.key === "ArrowUp" ? -1 : 1);
  }
  if (
    terminalKeyboardMode === "desktop" &&
    event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  ) {
    if (key === "c" && xterm.hasSelection()) {
      copyTerminalSelection();
      return false;
    }
    if (key === "v") {
      pasteFromClipboard();
      return false;
    }
  }
  return true;
}
$("#showTerminalShortcuts").onclick = () => {
  updateTerminalModeUi();
  terminalShortcutDialog.showModal();
};
$("#terminalKeyboardMode").onchange = (event) => {
  terminalKeyboardMode =
    event.target.value === "desktop" ? "desktop" : "terminal";
  saveUiState({ terminalKeyboardMode });
  updateTerminalModeUi();
  xterm?.focus();
};
terminalContextMenu.querySelector("[data-terminal-copy]").onclick = () => {
  terminalContextMenu.hidden = true;
  copyTerminalSelection();
};
terminalContextMenu.querySelector("[data-terminal-paste]").onclick = () => {
  terminalContextMenu.hidden = true;
  pasteFromClipboard();
};
$("#sshTerminalOutput").addEventListener("contextmenu", (event) => {
  event.preventDefault();
  terminalContextMenu.querySelector("[data-terminal-copy]").disabled =
    !xterm?.hasSelection();
  terminalContextMenu.style.left = `${Math.min(event.clientX, innerWidth - 150)}px`;
  terminalContextMenu.style.top = `${Math.min(event.clientY, innerHeight - 100)}px`;
  terminalContextMenu.hidden = false;
});
$("#sshTerminalOutput").addEventListener(
  "paste",
  (event) => {
    const text = event.clipboardData?.getData("text");
    if (text == null) return;
    event.preventDefault();
    event.stopPropagation();
    pasteTerminalText(text);
  },
  { capture: true },
);
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest("#terminalContextMenu"))
    terminalContextMenu.hidden = true;
});
let sshCwdIntegrationTimer = null;
function beginSshWorkingDirectoryTracking() {
  clearInterval(sshCwdIntegrationTimer);
  let attempts = 0,
    installedFor = null;
  sshCwdIntegrationTimer = setInterval(() => {
    if (++attempts > 200 || !terminalDialog.open) {
      clearInterval(sshCwdIntegrationTimer);
      return;
    }
    if (xterm && installedFor !== xterm) {
      installedFor = xterm;
      xterm.attachCustomKeyEventHandler(handleTerminalKey);
      xterm.parser.registerOscHandler(7, (value) => {
        const match = String(value).match(/^file:\/\/[^/]*(\/.*)$/);
        if (match) {
          try {
            sshTerminalWorkingDirectory = decodeURIComponent(match[1]);
          } catch {
            sshTerminalWorkingDirectory = match[1];
          }
          updateRemoteDirectoryHint();
          updateSyncCommand();
        }
        return true;
      });
    }
    if (terminalSessionId && installedFor === xterm) {
      clearInterval(sshCwdIntegrationTimer);
      fetch("/api/ssh/sessions/" + terminalSessionId + "/input", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: `export PROMPT_COMMAND='printf "\\033]7;file://localhost%s\\007" "$PWD"'\r`,
        }),
      }).catch(() => {});
    }
  }, 50);
}
$("#openSshTerminal").addEventListener(
  "click",
  beginSshWorkingDirectoryTracking,
);
terminalDialog.addEventListener("close", () => {
  clearInterval(sshCwdIntegrationTimer);
  sshTerminalWorkingDirectory = "";
  updateRemoteDirectoryHint();
  updateSyncCommand();
});
function restoreTransferPanel() {
  const panel = $("#terminalTransferMount .files-column");
  if (panel) $("#sshDialog .ssh-transfer-columns").append(panel);
}
async function closeTerminal() {
  terminalConnectAttempt++;
  if (terminalConnectController) {
    terminalConnectController.abort();
    terminalConnectController = null;
  }
  clearButtonBusy($("#openSshTerminal"));
  if (terminalEvents) {
    terminalEvents.close();
    terminalEvents = null;
  }
  if (terminalResizeObserver) {
    terminalResizeObserver.disconnect();
    terminalResizeObserver = null;
  }
  if (xterm) {
    xterm.dispose();
    xterm = null;
    terminalFit = null;
  }
  $("#sshTerminalOutput").replaceChildren();
  restoreTransferPanel();
  if (terminalSessionId) {
    fetch("/api/ssh/sessions/" + terminalSessionId, { method: "DELETE" }).catch(
      () => {},
    );
    terminalSessionId = "";
  }
  if (terminalDialog.open) terminalDialog.close();
}
terminalDialog.querySelector(".terminal-close").onclick = closeTerminal;
terminalDialog.addEventListener("cancel", function (event) {
  event.preventDefault();
  closeTerminal();
});
const terminalWindowBar = terminalDialog.querySelector(".terminal-window-bar");
let terminalDrag = null;
terminalWindowBar.onpointerdown = (event) => {
  if (event.button !== 0 || event.target.closest("button")) return;
  const rect = terminalDialog.getBoundingClientRect();
  terminalDrag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  terminalWindowBar.setPointerCapture(event.pointerId);
  event.preventDefault();
};
terminalWindowBar.onpointermove = (event) => {
  if (!terminalDrag) return;
  terminalDialog.style.left = `${Math.max(0, Math.min(innerWidth - 240, event.clientX - terminalDrag.x))}px`;
  terminalDialog.style.top = `${Math.max(0, Math.min(innerHeight - 42, event.clientY - terminalDrag.y))}px`;
  terminalDialog.style.margin = "0";
};
terminalWindowBar.onpointerup = terminalWindowBar.onpointercancel = () => {
  terminalDrag = null;
};
function setTerminalTransferCollapsed(collapsed) {
  const panel = $("#terminalTransferPanel"),
    button = $("#toggleTerminalTransfer");
  panel.classList.toggle("collapsed", collapsed);
  button.setAttribute("aria-expanded", String(!collapsed));
  button.setAttribute(
    "aria-label",
    collapsed ? "展开文件传输" : "收起文件传输",
  );
  button.title = collapsed ? "展开文件传输" : "收起文件传输";
  button.querySelector("span").textContent = collapsed ? "展开" : "收起";
  setTimeout(() => {
    if (xterm && terminalDialog.open) terminalFit?.fit();
  }, 220);
}
$("#toggleTerminalTransfer").onclick = function () {
  setTerminalTransferCollapsed(
    !$("#terminalTransferPanel").classList.contains("collapsed"),
  );
};
window.addEventListener("pagehide", function () {
  if (terminalSessionId)
    navigator.sendBeacon?.(
      "/api/ssh/sessions/" + terminalSessionId + "/close",
      "",
    );
});
$("#openSshTerminal").addEventListener("click", function () {
  const filesPanel = $("#sshDialog .files-column");
  if (filesPanel) $("#terminalTransferMount").append(filesPanel);
  setTerminalTransferCollapsed(false);
});
$("#openSshTerminal").onclick = async function () {
  if (!currentSshConnection) return;
  const button = $("#openSshTerminal"),
    attempt = ++terminalConnectAttempt,
    controller = new AbortController();
  terminalConnectController = controller;
  setButtonBusy(button, "连接中…");
  try {
    if (!XtermTerminal || !XtermFitAddon)
      throw new Error("终端组件未加载，请强制刷新页面");
    $("#sshTerminalOutput").replaceChildren();
    sshDialog.close();
    terminalDialog.showModal();
    xterm = new XtermTerminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
      fontSize: 13,
      theme: {
        background: "#050907",
        foreground: "#d9e7df",
        cursor: "#43dc83",
      },
      scrollback: 5000,
    });
    terminalFit = new XtermFitAddon();
    xterm.loadAddon(terminalFit);
    xterm.open($("#sshTerminalOutput"));
    terminalFit.fit();
    xterm.writeln("正在建立 SSH 连接…");
    const result = await request(
      "/api/instances/" +
        encodeURIComponent(currentSshConnection.instance.id) +
        "/ssh/terminal",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: currentSshConnection.instance.provider,
          cols: xterm.cols,
          rows: xterm.rows,
        }),
        signal: controller.signal,
      },
    );
    if (attempt !== terminalConnectAttempt) {
      fetch("/api/ssh/sessions/" + result.sessionId, {
        method: "DELETE",
      }).catch(() => {});
      return;
    }
    terminalSessionId = result.sessionId;
    terminalEvents = new EventSource(result.streamUrl);
    terminalEvents.onmessage = function (event) {
      let chunk = event.data;
      try {
        chunk = JSON.parse(chunk);
      } catch {}
      xterm?.write(chunk);
    };
    xterm.onData(function (input) {
      if (!terminalSessionId) return;
      fetch("/api/ssh/sessions/" + terminalSessionId + "/input", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input }),
      }).catch(() => {});
    });
    const resize = function () {
      if (!xterm || !terminalSessionId) return;
      terminalFit.fit();
      fetch("/api/ssh/sessions/" + terminalSessionId + "/resize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cols: xterm.cols, rows: xterm.rows }),
      }).catch(() => {});
    };
    terminalResizeObserver = new ResizeObserver(resize);
    terminalResizeObserver.observe($("#sshTerminalOutput"));
    xterm.focus();
  } catch (error) {
    if (error.name !== "AbortError" && attempt === terminalConnectAttempt) {
      if (xterm && terminalDialog.open) {
        xterm.writeln(`\r\n\x1b[31m平台终端连接失败：${error.message}\x1b[0m`);
        xterm.writeln("\x1b[90m终端窗口已保留，请关闭后重试。\x1b[0m");
        toast("平台终端连接失败，错误信息已保留在终端中");
      } else {
        await closeTerminal();
        toast("平台终端连接失败：" + error.message);
      }
    }
  } finally {
    if (attempt === terminalConnectAttempt) {
      terminalConnectController = null;
      clearButtonBusy(button);
    }
  }
};

const baseShowLaunch = showLaunch;
showLaunch = async function () {
  let guide = $("#multiGpuGuide");
  if (!guide) {
    guide = document.createElement("div");
    guide.id = "multiGpuGuide";
    guide.className = "multi-gpu-guide";
    $("#selectedOffer").after(guide);
  }
  const count = Number(selected?.gpuCount) || 1,
    totalVram = selected?.vram ? Number(selected.vram) * count : null;
  guide.innerHTML =
    count > 1
      ? `<strong>单机多卡运行</strong><span>建议启动命令：<code>torchrun --standalone --nproc_per_node=${count} train.py</code></span><small>${selected.vram ? `单卡 ${esc(selected.vram)} GB，合计 ${esc(totalVram)} GB；` : ""}合计显存不是一块连续显存。训练代码需使用 DDP、FSDP、DeepSpeed 等方案。创建后运行性能测试可实测 NCCL。</small>`
      : "<small>当前规格是单卡；模型放不下时，请选择供应商提供的多卡整机规格。</small>";
  return baseShowLaunch();
};
const baseInstanceMetricsMarkup = instanceMetricsMarkup;
function multiGpuHealthMarkup(telemetry) {
  const gpus = telemetry?.gpus || [];
  if (gpus.length < 2) return "";
  const sameModel = new Set(gpus.map((g) => g.name)).size === 1,
    sameMemory = new Set(gpus.map((g) => g.memoryTotal)).size === 1,
    utilization = gpus.map((g) => Number(g.util) || 0),
    spread = Math.max(...utilization) - Math.min(...utilization),
    compatible = sameModel && sameMemory;
  return `<div class="multi-gpu-health ${compatible ? "healthy" : "warning"}"><strong>${compatible ? "多卡硬件一致" : "多卡兼容风险"}</strong><span>${gpus.length} 卡 · ${compatible ? esc(gpus[0].name) + " · 单卡 " + esc(gpus[0].memoryTotal) + " MiB" : "检测到不同 GPU 型号或显存容量"}</span><small>${spread >= 30 ? "各卡利用率相差 " + spread + "%，请检查训练代码是否启用了所有 GPU" : "各卡利用率差 " + spread + "%"}</small></div>`;
}
instanceMetricsMarkup = function (instance) {
  return (
    multiGpuHealthMarkup(telemetryCache.get(String(instance.id))) +
    baseInstanceMetricsMarkup(instance)
  );
};
