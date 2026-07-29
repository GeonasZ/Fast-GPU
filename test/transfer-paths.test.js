const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const app = require("./frontend-source")(root);
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");

test("SCP and rsync resolve cloud-relative paths from the terminal working path", () => {
  assert.match(
    app,
    /normalizedRemotePath\(`\$\{sshTerminalWorkingDirectory\}\/\$\{value\}`\)/,
  );
  assert.match(app, /相对于左侧工作路径：/);
  assert.match(app, /完整路径：/);
  assert.match(app, /if \(!terminalDialog\?\.open\) return ""/);
  assert.match(app, /remoteDir = resolvedSyncDirectory\(\)/);
});

test("local transfer paths must remain absolute in the UI and API", () => {
  assert.match(app, /function isAbsoluteLocalPath/);
  assert.match(app, /if \(!isAbsoluteLocalPath\(localPath\)\)/);
  assert.match(server, /if \(!path\.isAbsolute\(requestedLocalPath\)\)/);
  assert.match(server, /local_path_must_be_absolute/);
  assert.doesNotMatch(server, /path\.resolve\(String\(d\.localPath/);
});

test("SCP download browses remote files while local storage uses the system picker", () => {
  assert.match(app, /data-scp-direction="download"/);
  assert.match(app, /scpDownloadRemotePath/);
  assert.match(app, /browseScpDownloadRemote/);
  assert.match(app, /fastGpuWindow\?\.pickDirectory/);
  assert.match(app, /scpDirectoryCache/);
  assert.match(server, /files\\\/download/);
  assert.match(server, /files\\\/list/);
  assert.match(server, /云端文件必须是安全的绝对路径/);
  assert.match(server, /fast-gpu-list-/);
});
