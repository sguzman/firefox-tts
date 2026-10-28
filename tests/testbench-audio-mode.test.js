const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "src/options/pronunciation.html"), "utf8");
const source = fs.readFileSync(path.join(root, "src/options/pronunciation.js"), "utf8");

test("pitch correction A/B control is test-bench only and defaults to production behavior", () => {
  assert.match(html, /id="test-preserve-pitch" type="checkbox" checked/);
  assert.match(html, /same test WAV/);
  assert.match(source, /function currentTestPreservesPitch\(\)/);
  assert.match(source, /testAudio\.preservesPitch = currentTestPreservesPitch\(\)/);
  assert.match(source, /testAudio\.webkitPreservesPitch = currentTestPreservesPitch\(\)/);
  assert.match(source, /#test-preserve-pitch"\)\.addEventListener\("change"/);
  assert.match(source, /:not\(#test-preserve-pitch\)/);
  assert.doesNotMatch(source, /storage\.(?:local|sync)\.set\(\{[^}]*test-preserve-pitch/);
});
