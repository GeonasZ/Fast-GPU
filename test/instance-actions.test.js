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
