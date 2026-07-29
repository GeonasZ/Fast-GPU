const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const source = require("./frontend-source")(path.join(__dirname, ".."));

test("all instance card lifecycle buttons use one delegated action path", () => {
  assert.match(
    source,
    /closest\("\[data-action\], \[data-timeout-delete\]"\)/,
  );
  assert.doesNotMatch(source, /\[data-action\]"\)\.forEach/);
});

test("instance actions normalize provider numeric IDs from DOM strings", () => {
  assert.match(
    source,
    /String\(item\.id\) === String\(id\)/,
  );
  assert.match(source, /provider: instance\.provider/);
});

test("instance cards have one status derivation and no legacy status writer", () => {
  const fs = require("node:fs");
  const root = path.join(__dirname, "..");
  const instancesPage = fs.readFileSync(
    path.join(root, "public", "instances-page.js"),
    "utf8",
  );
  const sshTransfer = fs.readFileSync(
    path.join(root, "public", "ssh-transfer.js"),
    "utf8",
  );

  assert.equal(
    (instancesPage.match(/function instanceVisualStatus\(/g) || []).length,
    1,
  );
  assert.equal(
    (instancesPage.match(/loadInstances\s*=\s*async function/g) || []).length,
    1,
  );
  assert.doesNotMatch(sshTransfer, /applyInstanceLifecycleLabels/);
});

test("provider inventory cleanup never treats durable keypairs as instances", () => {
  const server = require("node:fs").readFileSync(
    path.join(__dirname, "..", "server.js"),
    "utf8",
  );
  assert.match(server, /id\.startsWith\("keypair:"\)/);
});

test("Hyperstack keypair picker exposes per-entity delete controls", () => {
  assert.match(source, /data-delete-keypair/);
  assert.match(source, /method:\s*"DELETE"/);
});

test("unmanaged Hyperstack keypairs are visibly blocked from VM configuration", () => {
  assert.match(source, /非平台管理 · 不可创建 VM/);
  assert.match(source, /configSubmit\.disabled = !managed/);
  assert.match(source, /keypairOption\?\.dataset\.managed !== "true"/);
});

test("shared provisioning checks are not reported as every provider being incomplete", () => {
  assert.match(
    source,
    /item\.id === "hyperstack"[\s\S]*startsWith\("HYPERSTACK_"\)/,
  );
});
