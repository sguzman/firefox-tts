const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const get = name => fs.readFileSync(path.join(root, name), "utf8");

test("No passive injection, broad page access or background page scanning", () => {
  const manifest = JSON.parse(get("manifest.json"));
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.host_permissions, undefined);
  assert.ok(manifest.permissions.includes("activeTab"));
  assert.ok(manifest.permissions.includes("scripting"));
  assert.ok(!get("src/background/action.js").includes("setInterval("));
  const reader = get("src/content/reader.js");
  assert.ok(!reader.includes("new root.MutationObserver("));
  assert.ok(!reader.includes(".observe(document.body"));
  const script = get("src/content/content-script.js");
  assert.ok(!script.includes(".focus("));
  assert.ok(!script.includes("document.activeElement ="));
});

test("Reader's deliberate no-observer policy holds even with live DOM", () => {
  let observersCreated = 0;
  const context = vm.createContext({
    EdgeTtsExtension: {
      TextModel: {},
      Highlighter: { DEFAULT_SENTENCE_COLOR: "#fff", DEFAULT_WORD_COLOR: "#fff",
        Highlighter: class {}, normalizeColor: c => c },
      SpeechEngine: { SpeechEngine: class {
        onVoicesChanged() { return () => {}; }
      }, createSpeechBatch() {} },
      Toolbar: { Toolbar: class {} }
    },
    document: { body: {}, documentElement: { lang: "en" } },
    MutationObserver: class { constructor() { observersCreated++; } },
    console
  });
  vm.runInContext(get("src/content/reader.js"), context);
  const app = new context.EdgeTtsExtension.Reader.ReaderApp();
  app.enabled = true;
  app.model = { profile: "chatgpt", blocks: [{ segments: [{ text: "Hello" }] }] };
  app.observeModelMutations();
  assert.equal(observersCreated, 0);
  assert.equal(app.modelMutationObserver, null);
});
