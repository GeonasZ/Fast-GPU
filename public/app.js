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
globalThis.confirmAction = (message, options = {}) =>
  new Promise((resolve) => {
    let dialog = $("#appConfirmDialog");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "appConfirmDialog";
      dialog.innerHTML = '<form method="dialog"><span class="eyebrow">CONFIRM ACTION</span><h2></h2><p></p><menu><button value="cancel">取消</button><button value="confirm" class="primary">确认</button></menu></form>';
      document.body.append(dialog);
    }
    dialog.querySelector("h2").textContent = options.title || "确认操作";
    dialog.querySelector("p").textContent = message;
    dialog.querySelector('[value="confirm"]').textContent =
      options.confirmText || "确认";
    dialog.returnValue = "cancel";
    dialog.onclose = () => resolve(dialog.returnValue === "confirm");
    dialog.showModal();
  });
let offers = [],
  selected = null,
  instances = [],
  streams = new Map();
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
  const failureMarkup = instance.runtime?.status === "failed"
    ? '<div class="initialization-failure"><strong>初始化失败原因</strong><span>' +
      esc(instance.runtime.reason || instance.runtime.message || "未知错误") +
      (instance.runtime.log && instance.runtime.log !== instance.runtime.reason
        ? "<small>" + esc(instance.runtime.log) + "</small>"
        : "") +
      "</span></div>"
    : "";
  const timeoutMarkup = timedOut
    ? '<div class="initialization-timeout"><strong>初始化已超过大部分正常安装时间</strong><span>实例仍在持续计费，建议通过 SSH 排障；确认卡住后请删除实例以停止计费。</span><button type="button" data-timeout-delete="' +
      esc(instance.id) +
      '">删除并停止计费</button></div>'
    : "";
  return providerMarkup || progressMarkup || sshMarkup || failureMarkup || timeoutMarkup
    ? '<div class="initialization-detail' +
        (timedOut ? " timed-out" : "") +
        '">' +
        providerMarkup +
        progressMarkup +
        sshMarkup +
        failureMarkup +
        timeoutMarkup +
        "</div>"
    : "";
}
document.addEventListener("click", function (event) {
  const button = event.target.closest("[data-action], [data-timeout-delete]");
  if (!button) return;
  const id = button.dataset.id || button.dataset.timeoutDelete;
  const action = button.dataset.action || "delete";
  const instance = instances.find(function (item) {
    return String(item.id) === String(id);
  });
  if (instance) instanceAction(instance.id, action, button);
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
const UI_STATE_KEY = "fast-gpu-console-state-v1";
const WINDOW_STATE_KEY = "fast-gpu-client-window-v1";
function setupDesktopTitlebar() {
  if (!window.fastGpuWindow) return;
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
  document.documentElement.classList.add("electron-client-root");
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
    window.fastGpuWindow.minimize();
  maximizeButton.onclick = async () =>
    showMaximized(await window.fastGpuWindow.toggleMaximize());
  $('[data-window-action="close"]').onclick = () =>
    window.fastGpuWindow.close();
  window.fastGpuWindow.isMaximized().then(showMaximized);
  window.fastGpuWindow.onMaximizedChange(showMaximized);
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
    item.priceUnit || "CNY/hour",
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
      const syncNickname = await confirmAction(
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
        await confirmAction(
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
