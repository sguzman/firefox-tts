const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const source = fs.readFileSync(path.join(root, "src/background/action.js"), "utf8");

function harness({ initialReady = false, failFirstToggle = false } = {}) {
  const calls = [];
  let ready = initialReady;
  let firstToggle = true;
  const listeners = {};
  const browser = {
    action: { onClicked: { addListener(fn) { listeners.click = fn; } } },
    tabs: {
      onRemoved: { addListener(fn) { listeners.remove = fn; } },
      async sendMessage(tabId, message) {
        calls.push(["message", tabId, message.type]);
        if (message.type === "EDGE_TTS_PING_V2") {
          if (!ready) throw new Error("No receiver");
          return { ready: true, revision: 18 };
        }
        if (message.type === "EDGE_TTS_TOGGLE_V2") {
          if (firstToggle && failFirstToggle) {
            firstToggle = false;
            throw new Error("Invalidated context");
          }
          return { accepted: true, revision: 18 };
        }
        throw new Error("Unrecognized message");
      }
    },
    scripting: {
      async insertCSS({ target, files }) {
        calls.push(["css", target.tabId, ...files]);
      },
      async executeScript({ target, files }) {
        calls.push(["script", target.tabId, ...files]);
        ready = true;
      }
    }
  };
  const context = vm.createContext({ browser, console, module: { exports: {} } });
  vm.runInContext(source, context, { filename: "action.js" });
  return { calls, listeners, exported: context.module.exports, get ready() { return ready; } };
}

test("Firefox MV3 manifest: fixed ID, no idle injection, no Chromium offscreen", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.browser_specific_settings.gecko.id, "firefox-tts@sguzman.dev");
  assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.required, ["none"]);
  assert.deepEqual(manifest.background.scripts, ["src/background/audio.js", "src/background/native.js", "src/background/action.js"]);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.host_permissions, undefined);
  for (const file of manifest.background.scripts) {
    assert.ok(fs.statSync(path.join(root, file)).isFile());
  }
  assert.ok(!manifest.permissions.includes("offscreen"));
  assert.ok(!manifest.permissions.includes("tts"));
});

test("one action injects CSS and ordered modules; next action reuses singleton", async () => {
  const h = harness();
  assert.equal(h.calls.length, 0, "must have zero idle page effects");
  await h.exported.toggle(19);
  const injected = h.calls.filter((x) => x[0] === "script");
  assert.equal(injected.length, 1);
  assert.equal(injected[0][2], "src/content/namespace.js");
  assert.equal(injected[0].at(-1), "src/content/content-script.js");
  for (const file of injected[0].slice(2)) assert.ok(fs.existsSync(path.join(root, file)), file);
  assert.equal(h.calls.filter((x) => x[0] === "css").length, 1);
  await h.exported.toggle(19);
  assert.equal(h.calls.filter((x) => x[0] === "script").length, 1);
  assert.equal(h.calls.filter((x) => x[2] === "EDGE_TTS_TOGGLE_V2").length, 2);
});

test("stale context retries exactly once without reloading the page", async () => {
  const h = harness({ failFirstToggle: true });
  await h.exported.toggle(5);
  assert.equal(h.calls.filter((x) => x[0] === "script").length, 2);
  assert.equal(h.calls.filter((x) => x[2] === "EDGE_TTS_TOGGLE_V2").length, 2);
  assert.equal(h.calls.some((x) => x[0] === "navigate"), false);
});

test("click does not inject for missing/invalid tab and tab-close does not throw", () => {
  const h = harness();
  h.listeners.click({ id: -1 });
  h.listeners.click({});
  h.listeners.remove(9);
  assert.equal(h.calls.length, 0);
});
