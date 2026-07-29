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
function instanceVisualStatus(instance, pendingAction) {
  const action = pendingAction || instance.lifecycleAction;
  if (action === "delete") return "terminating";
  if (action === "stop") return "stopping";
  if (action === "start") return "starting";
  return instance.providerState === "running" ? "running" : instance.status;
}

function instanceStatusLabel(status) {
  return (
    {
      running: "供应商运行中",
      provisioning: "供应商准备中",
      starting: "正在启动",
      stopped: "已停止",
      stopping: "正在停止",
      terminating: "正在删除",
      failed: "初始化失败",
    }[status] || status
  );
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
      state = instanceVisualStatus(i, pending?.action);
    if (!["stopping", "starting", "terminating"].includes(state)) continue;
    const button = $(`[data-action][data-id="${CSS.escape(String(i.id))}"]`),
      pill = button?.closest(".instance")?.querySelector(".pill"),
      label = instanceStatusLabel(state);
    if (button) {
      button.disabled = true;
      // “正在停止”已经由右上角状态标识表达；按钮保留“启动”文案，
      // 让用户明确停止完成后的可用动作，同时在过渡期禁用以避免竞态。
      button.textContent = state === "stopping" ? "启动" : `${label}…`;
    }
    if (pill) {
      pill.className = `pill ${state}`;
      pill.textContent = label;
    }
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
  const instance = instances.find((item) => String(item.id) === String(id));
  if (!instance) {
    toast("实例状态已变化，请刷新后重试");
    return;
  }
  id = String(instance.id);
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
      body: JSON.stringify({ provider: instance.provider }),
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
    !(await confirmAction(
      `当前 GPU 利用率最高为 ${preflight.maxUtilization}%，实例可能正在运行任务。\n\n性能测试会占用 GPU、磁盘和网络资源，仍要继续吗？`,
      { title: "确认运行性能测试", confirmText: "继续测试" },
    ))
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
  syncTelemetryStreams();
  applyInstancePrices();
  updateInstanceBadge();
  updateInstanceTotalSpend();
  updateInstanceEmptyState();
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
        visualStatus = instanceVisualStatus(i),
        statusLabel = instanceStatusLabel(visualStatus),
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
       '</div></div></div><div class="instance-connection-status"><span class="sub">' +
        esc(i.ip || i.accessMessage || "") +
        '</span></div><div class="instance-actions"><div><button data-expand="' +
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
