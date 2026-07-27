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
async function pasteTerminalText(text) {
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
    !(await confirmAction(
      `即将向远端终端粘贴 ${lineCount} 行内容，其中的命令可能立即执行。是否继续？`,
      { title: "确认多行粘贴", confirmText: "继续粘贴" },
    ))
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
