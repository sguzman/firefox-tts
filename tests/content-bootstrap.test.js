const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/content/content-script.js"), "utf8");

test("reader bootstrap ping, explicit toggle, quit, and re-open preserve a singleton", async () => {
  let registrations = [];
  let removals = [];
  let created = 0;
  let opened = 0;
  let stopped = 0;
  let destroyed = 0;
  class FakeReader {
    constructor() {
      created++;
      this.enabled = false;
      this.highlighter = { clear() {} };
      this.toolbar = { destroy() { destroyed++; } };
    }
    async toggle() {
      if (this.enabled) {
        this.enabled = false;
        this.stop();
      } else {
        this.enabled = true;
        opened++;
      }
    }
    stop() { stopped++; }
  }
  const elements = [];
  const context = vm.createContext({
    chrome: { runtime: { onMessage: {
      addListener(fn) { registrations.push(fn); },
      removeListener(fn) { removals.push(fn); }
    } } },
    document: {
      querySelectorAll() { return elements; },
      documentElement: { setAttribute() {} }
    },
    console,
    EdgeTtsExtension: { Reader: { ReaderApp: FakeReader } }
  });
  vm.runInContext(source, context, { filename: "content-script.js" });
  assert.equal(created, 1);
  assert.equal(registrations.length, 1);
  const respond = async (type) => {
    let response;
    const result = registrations[0]({ type }, null, reply => { response = reply; });
    assert.equal(result, false);
    await new Promise(resolve => setImmediate(resolve));
    return response;
  };
  assert.equal((await respond("EDGE_TTS_PING_V2")).revision, 18);
  assert.equal((await respond("EDGE_TTS_TOGGLE_V2")).accepted, true);
  assert.equal(opened, 1);
  assert.equal((await respond("EDGE_TTS_TOGGLE_V2")).accepted, true);
  assert.equal(stopped, 1, "closing reader stops its speech");
  context.__EDGE_TTS_READER__.detach();
  assert.equal((await respond("EDGE_TTS_PING_V2")).active, false);
  await respond("EDGE_TTS_TOGGLE_V2");
  assert.equal(created, 2, "reopen constructs new reader, not stale state");
  context.__EDGE_TTS_READER__.dispose();
  assert.equal(removals.length, 1);
  assert.ok(destroyed >= 1);
});
