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
