const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const auth = fs.readFileSync(path.join(root, 'public', 'auth.js'), 'utf8');
const authHtml = fs.readFileSync(path.join(root, 'public', 'auth.html'), 'utf8');
const titlebarCss = fs.readFileSync(path.join(root, 'public', 'electron-titlebar.css'), 'utf8');

test('Electron pages suppress the root scrollbar above the titlebar', () => {
  assert.match(app, /documentElement\.classList\.add\(["']electron-client-root["']\)/);
  assert.match(auth, /documentElement\.classList\.add\(["']electron-client-root["']\)/);
  assert.match(titlebarCss, /html\.electron-client-root\s*\{[^}]*overflow:\s*hidden/);
});

test('authentication page exposes Electron window controls', () => {
  assert.match(authHtml, /electron-titlebar\.css/);
  assert.match(auth, /data-window-action=[\\"']minimize/);
  assert.match(auth, /data-window-action=[\\"']close/);
  assert.match(auth, /fastGpuWindow\.minimize\(\)/);
  assert.match(auth, /fastGpuWindow\.close\(\)/);
});
