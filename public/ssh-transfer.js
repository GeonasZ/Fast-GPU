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
  const localPath = await window.fastGpuWindow?.pickDirectory?.();
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
    // 保留加载状态供光标和辅助技术识别，不使用闪烁动画。
    button.classList.toggle("ssh-loading", !accessible && powered);
    button.classList.toggle("ssh-dormant", !accessible && !powered);
    button.setAttribute("aria-busy", String(!accessible && powered));
    button.title = title;
  });
  bindInstanceBenchmarkButtons();
}
new MutationObserver(() => {
  decorateSshButtons();
}).observe($("#instanceGrid"), { childList: true, subtree: true });
decorateSshButtons();
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
        `fast-gpu-${instance.provider}-${instance.id}`.replace(
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
