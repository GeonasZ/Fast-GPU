const fs = require("node:fs");
const path = require("node:path");

const frontendFiles = [
  "app.js",
  "providers-page.js",
  "instances-page.js",
  "ssh-transfer.js",
  "storage-page.js",
  "ssh-transfer-actions.js",
  "terminal.js",
  "image-management.js",
  "bootstrap.js",
];

module.exports = function readFrontendSource(root) {
  return frontendFiles
    .map((file) => fs.readFileSync(path.join(root, "public", file), "utf8"))
    .join("\n");
};
