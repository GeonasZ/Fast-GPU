const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
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
