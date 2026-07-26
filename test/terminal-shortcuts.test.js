const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('SSH terminal exposes configurable clipboard and editing shortcuts', () => {
  assert.match(app, /id="showTerminalShortcuts"/);
  assert.match(app, /terminalKeyboardMode\s*===\s*["']desktop["']/);
  assert.match(app, /event\.ctrlKey\s*&&\s*event\.shiftKey\s*&&\s*key\s*===\s*["']c["']/);
  assert.match(app, /event\.ctrlKey\s*&&\s*event\.shiftKey\s*&&\s*key\s*===\s*["']v["']/);
  assert.match(app, /key\s*===\s*["']c["']\s*&&\s*xterm\.hasSelection\(\)/);
  assert.match(app, /key\s*===\s*["']z["'][\s\S]*sendTerminalInput\(["']\\x1f["']\)/);
});

test('SSH terminal guards multiline paste and supports context actions', () => {
  assert.match(app, /lineCount\s*>\s*1\s*&&\s*!confirm/);
  assert.match(app, /addEventListener\(\s*["']contextmenu["']/);
  assert.match(app, /data-terminal-copy/);
  assert.match(app, /data-terminal-paste/);
});

test('Alt arrows move by one visual terminal row outside alternate screen', () => {
  assert.match(app, /event\.key\s*===\s*["']ArrowUp["']\s*\|\|\s*event\.key\s*===\s*["']ArrowDown["']/);
  assert.match(app, /sequence\.repeat\(Math\.max\(1,\s*xterm\.cols\)\)/);
  assert.match(app, /buffer\?\.active\?\.type\s*===\s*["']alternate["']/);
});
